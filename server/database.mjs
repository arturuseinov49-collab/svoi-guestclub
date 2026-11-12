import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { recordVisit, awardBonus, addNote, addReview, replyReview, redeemReward, validateProgram } from './domain.mjs';
import { effectiveGuestProfile, validateGuestProfile } from './venue-profile.mjs';
import { validateServiceFlow } from './service-flow.mjs';
import { GLOBAL_PROGRAM, globalBalances, guestGlobalWallet } from './global-bonuses.mjs';

const empty = () => ({ version: 1, venues: [], guests: [], memberships: [], visits: [], notes: [], reviews: [], transactions: [], posEvents: [] });
const hash = value => createHash('sha256').update(value).digest('hex');
const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const code = (length = 8) => Array.from(randomBytes(length), value => alphabet[value % alphabet.length]).join('');
export class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new ApiError(status, message); };
const string = (value, min, max, label) => {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) fail(400, `${label}: от ${min} до ${max} символов`);
  return value.trim();
};
const normalCode = value => string(value, 8, 40, 'Код').replace(/[\s-]/g, '').toUpperCase();
const qrPrefix = 'svoi:guest:v1:';
function developerAllowlist(value) {
  const entries = typeof value === 'string' ? value.split(',').map(item => item.trim()).filter(Boolean) : value;
  if (!Array.isArray(entries) || entries.some(item => !/^[1-9][0-9]*$/.test(String(item)) || !Number.isSafeInteger(Number(item)))) throw new Error('Некорректная настройка DEVELOPER_TELEGRAM_IDS');
  return new Set(entries.map(Number));
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
// The directory is a separate projection: browsing never grants staff access or
// membership and never exposes club invitation codes or guest data.
function catalogVenue(venue) {
  return { id: venue.id, name: venue.name, kind: venue.kind, address: venue.address, monogram: venue.monogram,
    program: { cashback: venue.program.cashback, everyVisits: venue.program.everyVisits, visitBonus: venue.program.visitBonus, tipsBonus: venue.program.tipsBonus },
    guestProfile: effectiveGuestProfile(venue) };
}

// An IMMEDIATE SQLite transaction commits domain state, audit and operation receipt together.
export class Store {
  constructor(path, { clock = Date.now, developerIds = [] } = {}) {
    this.clock = clock; this.developerIds = developerAllowlist(developerIds);
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.sql = new DatabaseSync(path);
    const schema = this.sql.prepare('PRAGMA user_version').get().user_version;
    if (![0, 1, 2].includes(schema)) {
      this.sql.close();
      throw new Error('Unsupported database schema; manual migration is required');
    }
    this.sql.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, first_name TEXT NOT NULL, last_name TEXT NOT NULL, username TEXT, guest_id TEXT NOT NULL UNIQUE, guest_code TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
      CREATE TABLE IF NOT EXISTS staff (venue_id TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id), role TEXT NOT NULL CHECK(role IN ('owner','staff')), PRIMARY KEY(venue_id,user_id));
      CREATE TABLE IF NOT EXISTS invites (code_hash TEXT PRIMARY KEY, venue_id TEXT NOT NULL, created_by INTEGER NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL, used_by INTEGER REFERENCES users(id), revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS command_receipts (user_id INTEGER NOT NULL REFERENCES users(id), command_key TEXT NOT NULL, request_hash TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(user_id,command_key));
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, actor_id INTEGER NOT NULL REFERENCES users(id), command TEXT NOT NULL, venue_id TEXT, guest_id TEXT, created_at INTEGER NOT NULL);
      `);
    this.sql.prepare('INSERT OR IGNORE INTO app_state(id,value) VALUES (1,?)').run(JSON.stringify(empty()));
    this.transaction(() => {
      if (!this.sql.prepare('PRAGMA table_info(users)').all().some(column => column.name === 'guest_qr')) this.sql.exec('ALTER TABLE users ADD COLUMN guest_qr TEXT');
      if (!this.sql.prepare('PRAGMA table_info(invites)').all().some(column => column.name === 'role')) this.sql.exec("ALTER TABLE invites ADD COLUMN role TEXT NOT NULL DEFAULT 'staff' CHECK(role IN ('owner','staff'))");
      this.sql.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_guest_qr ON users(guest_qr)');
      const update = this.sql.prepare('UPDATE users SET guest_qr=? WHERE id=?');
      for (const user of this.sql.prepare('SELECT id FROM users WHERE guest_qr IS NULL').all()) update.run(randomBytes(32).toString('base64url'), user.id);
      this.sql.exec('PRAGMA user_version=2');
    });
  }
  close() { this.sql.close(); }
  transaction(fn) {
    this.sql.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.sql.exec('COMMIT'); return value; }
    catch (error) { this.sql.exec('ROLLBACK'); throw error; }
  }
  read() { return JSON.parse(this.sql.prepare('SELECT value FROM app_state WHERE id=1').get().value); }
  write(db) { this.sql.prepare('UPDATE app_state SET value=? WHERE id=1').run(JSON.stringify(db)); }
  user(id) { return this.sql.prepare('SELECT * FROM users WHERE id=?').get(id); }
  staff(id) { return this.sql.prepare('SELECT venue_id AS venueId, role FROM staff WHERE user_id=?').all(id).map(row => ({ ...row })); }
  isDeveloper(userId) { return this.developerIds.has(userId); }
  requireDeveloper(userId) { if (!this.isDeveloper(userId)) fail(403, 'Это действие доступно только разработчику «Своих»'); }
  requireVenue(venueId, db = this.read()) { const venue = db.venues.find(item => item.id === string(venueId, 1, 100, 'Заведение')); if (!venue) fail(404, 'Заведение не найдено'); return venue; }
  requireStaff(userId, venueId, owner = false) {
    const row = this.sql.prepare('SELECT role FROM staff WHERE venue_id=? AND user_id=?').get(string(venueId, 1, 100, 'Заведение'), userId);
    if (!row || (owner && row.role !== 'owner')) fail(403, owner ? 'Это действие доступно руководителю заведения' : 'Нет доступа сотрудника к этому заведению');
    return row;
  }
  managedVenues(db = this.read()) {
    const managers = this.sql.prepare("SELECT staff.venue_id AS venueId, users.id AS userId, users.first_name || CASE WHEN users.last_name='' THEN '' ELSE ' ' || users.last_name END AS name FROM staff JOIN users ON users.id=staff.user_id WHERE staff.role='owner'").all();
    const counts = this.sql.prepare('SELECT venue_id AS venueId, COUNT(*) AS count FROM staff GROUP BY venue_id').all();
    return db.venues.map(venue => ({ id: venue.id, name: venue.name, kind: venue.kind, address: venue.address, joinCode: venue.joinCode, guestProfile: effectiveGuestProfile(venue),
      managers: managers.filter(manager => manager.venueId === venue.id).map(({ userId, name }) => ({ userId, name })),
      guestCount: db.memberships.filter(member => member.venueId === venue.id).length, staffCount: counts.find(item => item.venueId === venue.id)?.count ?? 0 }));
  }
  teamMembers(venueId) {
    return this.sql.prepare("SELECT users.id AS userId, users.first_name || CASE WHEN users.last_name='' THEN '' ELSE ' ' || users.last_name END AS name, staff.role FROM staff JOIN users ON users.id=staff.user_id WHERE venue_id=? ORDER BY staff.role,users.first_name").all(venueId).map(row => ({ ...row }));
  }
  login(user) {
    return this.transaction(() => {
      const db = this.read(); let row = this.user(user.id);
      const name = [user.firstName, user.lastName].filter(Boolean).join(' ').slice(0, 100) || 'Гость';
      if (!row) {
        const guestId = randomUUID(); let guestCode;
        do { guestCode = code(); } while (this.sql.prepare('SELECT 1 FROM users WHERE guest_code=?').get(guestCode));
        this.sql.prepare('INSERT INTO users(id,first_name,last_name,username,guest_id,guest_code,guest_qr) VALUES (?,?,?,?,?,?,?)').run(user.id, user.firstName.slice(0, 100), user.lastName.slice(0, 100), user.username, guestId, guestCode, randomBytes(32).toString('base64url'));
        db.guests.push({ id: guestId, name, phone: '', color: '#BCA4F8', createdAt: new Date(this.clock()).toISOString() }); row = this.user(user.id);
      } else {
        this.sql.prepare('UPDATE users SET first_name=?,last_name=?,username=? WHERE id=?').run(user.firstName.slice(0, 100), user.lastName.slice(0, 100), user.username, user.id);
        db.guests = db.guests.map(guest => guest.id === row.guest_id ? { ...guest, name } : guest);
      }
      this.write(db); this.sql.prepare('DELETE FROM sessions WHERE expires_at<=?').run(this.clock());
      const token = randomBytes(32).toString('base64url');
      this.sql.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)').run(hash(token), user.id, this.clock() + 12 * 60 * 60 * 1000);
      return { token, ...this.snapshot(user.id) };
    });
  }
  authenticate(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) fail(401, 'Откройте приложение через Telegram, чтобы войти');
    const session = this.sql.prepare('SELECT user_id FROM sessions WHERE token_hash=? AND expires_at>?').get(hash(token), this.clock());
    if (!session) fail(401, 'Сессия завершилась. Откройте приложение заново в Telegram'); return session.user_id;
  }
  logout(token) { this.sql.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token)); }
  snapshot(userId) {
    const row = this.user(userId); if (!row) fail(401, 'Войдите через Telegram'); const db = this.read();
    const staffVenues = this.staff(userId); const permitted = new Set(staffVenues.map(item => item.venueId));
    const member = new Set(db.memberships.filter(item => item.guestId === row.guest_id).map(item => item.venueId));
    const visible = item => permitted.has(item.venueId) || (item.guestId === row.guest_id && member.has(item.venueId));
    const memberships = db.memberships.filter(visible); const guestIds = new Set([row.guest_id, ...memberships.map(item => item.guestId)]);
    const balances = globalBalances(db);
    // POS holds already persist reconciliation state; do not create a new schema
    // or reveal which other venue produced a hold in a guest's global wallet.
    const hasPosHolds = this.sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pos_guest_holds'").get();
    const pendingReview = !!(hasPosHolds && this.sql.prepare('SELECT 1 FROM pos_guest_holds WHERE guest_id=? LIMIT 1').get(row.guest_id));
    return { user: { id: row.id, firstName: row.first_name, lastName: row.last_name, username: row.username }, guestId: row.guest_id, guestCode: row.guest_code, guestQr: qrPrefix + row.guest_qr, isDeveloper: this.isDeveloper(userId), staffVenues,
      globalProgram: { ...GLOBAL_PROGRAM }, globalWallet: guestGlobalWallet(db, row.guest_id, pendingReview, balances),
      guestGlobalBalances: db.memberships.filter(item => permitted.has(item.venueId)).map(({ venueId, guestId }) => ({ venueId, guestId, balance: balances.get(guestId) ?? 0 })),
      catalog: db.venues.filter(venue => effectiveGuestProfile(venue).published).map(catalogVenue),
      db: { version: 1,
        venues: db.venues.filter(venue => permitted.has(venue.id) || member.has(venue.id)).map(venue => { const { joinCode, serviceFlow, ...publicVenue } = venue; return permitted.has(venue.id) ? venue : publicVenue; }),
        guests: db.guests.filter(guest => guestIds.has(guest.id)), memberships,
        visits: db.visits.filter(visible).map(visit => permitted.has(visit.venueId) ? visit : { ...visit, rating: null }),
        notes: db.notes.filter(note => permitted.has(note.venueId)), reviews: db.reviews.filter(visible), transactions: db.transactions.filter(visible), posEvents: [],
      },
    };
  }
  command(userId, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'Некорректная команда');
    const type = string(input.type, 1, 40, 'Команда'); const key = string(input.idempotencyKey, 8, 128, 'Ключ операции'); const requestHash = hash(canonical(input));
    return this.transaction(() => {
      const old = this.sql.prepare('SELECT request_hash,result FROM command_receipts WHERE user_id=? AND command_key=?').get(userId, key);
      if (old) {
        if (old.request_hash !== requestHash) fail(409, 'Этот ключ операции уже использован для другого действия');
        this.authorizeReplay(userId, { ...input, type });
        // A retried read must reflect current access and counts; mutation receipts remain immutable.
        const result = type === 'listManagedVenues' ? { managedVenues: this.managedVenues() }
          : type === 'listStaff' ? { members: this.teamMembers(input.venueId.trim()) } : JSON.parse(old.result);
        return { ...this.snapshot(userId), result, replayed: true };
      }
      let db = this.read(); const ownGuestId = this.user(userId).guest_id; let result = {}; const venueId = typeof input.venueId === 'string' ? input.venueId.trim() : input.venueId;
      const staff = owner => this.requireStaff(userId, venueId, owner);
      const member = guestId => { if (!db.memberships.some(item => item.venueId === venueId && item.guestId === guestId)) fail(404, 'Гость не найден в этом заведении'); };
      switch (type) {
        case 'createVenue': {
          this.requireDeveloper(userId);
          const name = string(input.name, 2, 70, 'Название'); const kind = string(input.kind, 2, 50, 'Тип заведения'); const address = string(input.address, 2, 150, 'Адрес');
          const id = randomUUID(); let joinCode; do { joinCode = code(); } while (db.venues.some(venue => venue.joinCode === joinCode));
          db.venues.push({ id, name, kind, address, monogram: name[0].toUpperCase(), joinCode, program: { cashback: 5, everyVisits: 5, visitBonus: 100, tipsBonus: 25 } });
          result = { venueId: id, joinCode }; break;
        }
        case 'listManagedVenues': {
          this.requireDeveloper(userId);
          result = { managedVenues: this.managedVenues(db) }; break;
        }
        case 'updateVenueProfile': {
          this.requireDeveloper(userId); this.requireVenue(venueId, db);
          let guestProfile;
          try { guestProfile = validateGuestProfile(input.guestProfile); }
          catch (error) { fail(400, error.message); }
          db.venues = db.venues.map(venue => venue.id === venueId ? { ...venue, guestProfile } : venue);
          result = { venueId }; break;
        }
        case 'createManagerInvite': {
          this.requireDeveloper(userId); this.requireVenue(venueId, db);
          this.sql.prepare("UPDATE invites SET revoked=1 WHERE venue_id=? AND role='owner' AND used_by IS NULL").run(venueId);
          const inviteCode = code(24); const expiresAt = this.clock() + 24 * 60 * 60 * 1000;
          this.sql.prepare("INSERT INTO invites(code_hash,venue_id,created_by,expires_at,role) VALUES (?,?,?,?,'owner')").run(hash(inviteCode), venueId, userId, expiresAt);
          result = { code: inviteCode, expiresAt: new Date(expiresAt).toISOString() }; break;
        }
        case 'revokeManager': {
          this.requireDeveloper(userId); this.requireVenue(venueId, db);
          if (!Number.isSafeInteger(input.userId) || input.userId <= 0) fail(400, 'Некорректный руководитель');
          const target = this.sql.prepare("SELECT 1 FROM staff WHERE venue_id=? AND user_id=? AND role='owner'").get(venueId, input.userId);
          if (!target) fail(404, 'Руководитель не найден');
          this.sql.prepare("DELETE FROM staff WHERE venue_id=? AND user_id=? AND role='owner'").run(venueId, input.userId);
          this.sql.prepare('UPDATE invites SET revoked=1 WHERE venue_id=? AND created_by=? AND used_by IS NULL').run(venueId, input.userId);
          this.sql.prepare("UPDATE invites SET revoked=1 WHERE venue_id=? AND role='owner' AND used_by IS NULL").run(venueId); break;
        }
        case 'joinVenue': {
          const joinCode = normalCode(input.code); const venue = db.venues.find(item => item.joinCode === joinCode); if (!venue) fail(404, 'Заведение с таким кодом не найдено');
          if (!db.memberships.some(item => item.venueId === venue.id && item.guestId === ownGuestId)) db.memberships.push({ venueId: venue.id, guestId: ownGuestId, balance: 0 }); result = { venueId: venue.id }; break;
        }
        case 'addGuest': {
          staff(); const guest = this.sql.prepare('SELECT guest_id FROM users WHERE guest_code=?').get(normalCode(input.guestCode));
          if (!guest) fail(404, 'Гость с таким кодом не найден. Попросите его открыть «Свои»');
          if (!db.memberships.some(item => item.venueId === venueId && item.guestId === guest.guest_id)) db.memberships.push({ venueId, guestId: guest.guest_id, balance: 0 }); result = { guestId: guest.guest_id }; break;
        }
        case 'scanGuest': {
          staff(); this.requireVenue(venueId, db);
          if (typeof input.qr !== 'string' || !/^svoi:guest:v1:[A-Za-z0-9_-]{43}$/.test(input.qr)) fail(400, 'Это не QR гостя «Своих». Попросите гостя открыть личный QR в приложении');
          const guest = this.sql.prepare('SELECT guest_id, first_name, last_name FROM users WHERE guest_qr=?').get(input.qr.slice(qrPrefix.length));
          if (!guest) fail(404, 'QR гостя не найден');
          if (!db.memberships.some(item => item.venueId === venueId && item.guestId === guest.guest_id)) db.memberships.push({ venueId, guestId: guest.guest_id, balance: 0 });
          result = { guestId: guest.guest_id, name: [guest.first_name, guest.last_name].filter(Boolean).join(' ') }; break;
        }
        case 'recordVisit': {
          staff(); member(input.guestId); const visit = recordVisit(db, { venueId, guestId: input.guestId, bill: input.bill, tips: input.tips, rating: input.rating ?? null, tipsKnown: true });
          db = visit.db; result = { earned: visit.earned, visitId: db.visits[0].id }; break;
        }
        case 'awardBonus': staff(); member(input.guestId); db = awardBonus(db, venueId, input.guestId, input.amount, string(input.reason, 3, 300, 'Причина')); break;
        case 'addNote': {
          staff(); member(input.guestId); if (!['thanks', 'preference', 'note'].includes(input.kind)) fail(400, 'Выберите тип заметки');
          db = addNote(db, venueId, input.guestId, string(input.text, 3, 1000, 'Заметка'), input.kind); db.notes[0].author = [this.user(userId).first_name, this.user(userId).last_name].filter(Boolean).join(' '); break;
        }
        case 'updateProgram': {
          staff(true); if (!input.program || typeof input.program !== 'object') fail(400, 'Укажите правила программы');
          const program = { cashback: input.program.cashback, everyVisits: input.program.everyVisits, visitBonus: input.program.visitBonus, tipsBonus: input.program.tipsBonus };
          validateProgram(program); db.venues = db.venues.map(item => item.id === venueId ? { ...item, program } : item); break;
        }
        case 'updateServiceFlow': {
          staff(true); this.requireVenue(venueId, db);
          let serviceFlow;
          try { serviceFlow = validateServiceFlow(input.serviceFlow); }
          catch (error) { fail(400, error.message); }
          db.venues = db.venues.map(item => item.id === venueId ? { ...item, serviceFlow } : item); break;
        }
        case 'addReview': member(ownGuestId); db = addReview(db, venueId, ownGuestId, input.rating, string(input.text, 3, 1000, 'Отзыв')); break;
        case 'replyReview': {
          const review = db.reviews.find(item => item.id === input.reviewId); if (!review) fail(404, 'Отзыв не найден'); this.requireStaff(userId, review.venueId); db = replyReview(db, review.id, string(input.response, 3, 1000, 'Ответ')); break;
        }
        case 'redeemReward': staff(); member(input.guestId); db = redeemReward(db, venueId, input.guestId, input.rewardId); break;
        case 'createStaffInvite': {
          staff(true); const inviteCode = code(24); const expiresAt = this.clock() + 24 * 60 * 60 * 1000;
          this.sql.prepare("INSERT INTO invites(code_hash,venue_id,created_by,expires_at,role) VALUES (?,?,?,?,'staff')").run(hash(inviteCode), venueId, userId, expiresAt); result = { code: inviteCode, expiresAt: new Date(expiresAt).toISOString() }; break;
        }
        case 'acceptStaffInvite': {
          const invite = this.sql.prepare('SELECT * FROM invites WHERE code_hash=?').get(hash(normalCode(input.code)));
          if (!invite || invite.revoked || invite.used_by !== null || invite.expires_at <= this.clock()) fail(400, 'Приглашение недействительно, истекло или уже использовано');
          this.requireVenue(invite.venue_id, db);
          if (invite.role === 'owner') this.requireDeveloper(invite.created_by); else this.requireStaff(invite.created_by, invite.venue_id, true);
          const existing = this.sql.prepare('SELECT role FROM staff WHERE venue_id=? AND user_id=?').get(invite.venue_id, userId);
          if (existing && (invite.role === 'staff' || existing.role === 'owner')) fail(409, existing.role === 'owner' ? 'У вас уже есть доступ руководителя к этому заведению' : 'Вы уже в команде этого заведения');
          if (invite.role === 'owner') this.sql.prepare("INSERT INTO staff(venue_id,user_id,role) VALUES (?,?,'owner') ON CONFLICT(venue_id,user_id) DO UPDATE SET role='owner'").run(invite.venue_id, userId);
          else this.sql.prepare("INSERT OR IGNORE INTO staff(venue_id,user_id,role) VALUES (?,?,'staff')").run(invite.venue_id, userId);
          this.sql.prepare('UPDATE invites SET used_by=? WHERE code_hash=?').run(userId, invite.code_hash); result = { venueId: invite.venue_id }; break;
        }
        case 'listStaff': {
          staff(true); result = { members: this.teamMembers(venueId) }; break;
        }
        case 'revokeStaff': {
          staff(true); if (!Number.isSafeInteger(input.userId) || input.userId <= 0) fail(400, 'Некорректный сотрудник'); const target = this.sql.prepare('SELECT role FROM staff WHERE venue_id=? AND user_id=?').get(venueId, input.userId);
          if (!target) fail(404, 'Сотрудник не найден'); if (target.role === 'owner') fail(400, 'Доступ руководителя меняет разработчик «Своих»'); this.sql.prepare('DELETE FROM staff WHERE venue_id=? AND user_id=?').run(venueId, input.userId); break;
        }
        default: fail(400, 'Неизвестная команда');
      }
      this.write(db); this.sql.prepare('INSERT INTO command_receipts(user_id,command_key,request_hash,result,created_at) VALUES (?,?,?,?,?)').run(userId, key, requestHash, JSON.stringify(result), this.clock());
      // Audit targets come from resolved effects, never from unused caller fields.
      let auditVenueId = null; let auditGuestId = null;
      if (['createVenue', 'joinVenue', 'acceptStaffInvite'].includes(type)) auditVenueId = result.venueId;
      if (type === 'joinVenue') auditGuestId = ownGuestId;
      if (['addGuest', 'scanGuest', 'recordVisit', 'awardBonus', 'addNote', 'updateProgram', 'updateServiceFlow', 'updateVenueProfile', 'redeemReward', 'createStaffInvite', 'createManagerInvite', 'revokeManager', 'listStaff', 'revokeStaff', 'addReview'].includes(type)) auditVenueId = venueId;
      if (['recordVisit', 'awardBonus', 'addNote', 'redeemReward'].includes(type)) auditGuestId = input.guestId;
      if (['addGuest', 'scanGuest'].includes(type)) auditGuestId = result.guestId;
      if (type === 'addReview') auditGuestId = ownGuestId;
      if (type === 'replyReview') { const review = db.reviews.find(item => item.id === input.reviewId); auditVenueId = review.venueId; auditGuestId = review.guestId; }
      this.sql.prepare('INSERT INTO audit(actor_id,command,venue_id,guest_id,created_at) VALUES (?,?,?,?,?)').run(userId, type, auditVenueId, auditGuestId, this.clock());
      return { ...this.snapshot(userId), result };
    });
  }
  authorizeReplay(userId, input) {
    if (['createVenue', 'listManagedVenues', 'createManagerInvite', 'revokeManager', 'updateVenueProfile'].includes(input.type)) this.requireDeveloper(userId);
    if (['recordVisit', 'awardBonus', 'addNote', 'redeemReward', 'addGuest', 'scanGuest'].includes(input.type)) this.requireStaff(userId, input.venueId);
    if (['updateProgram', 'updateServiceFlow', 'createStaffInvite', 'listStaff', 'revokeStaff'].includes(input.type)) this.requireStaff(userId, input.venueId, true);
    if (input.type === 'acceptStaffInvite') { const invite = this.sql.prepare('SELECT venue_id, role FROM invites WHERE code_hash=? AND used_by=?').get(hash(normalCode(input.code)), userId); if (!invite) fail(403, 'Приглашение больше недоступно'); this.requireStaff(userId, invite.venue_id, invite.role === 'owner'); }
    if (input.type === 'replyReview') { const review = this.read().reviews.find(item => item.id === input.reviewId); if (!review) fail(404, 'Отзыв не найден'); this.requireStaff(userId, review.venueId); }
  }
}
