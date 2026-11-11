import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Store, ApiError } from '../server/database.mjs';

const denied = (fn, status = 403) => assert.throws(fn, error => error instanceof ApiError && error.status === status);
const venueFields = { name: 'Наше кафе', kind: 'Кафе', address: 'Город, улица 1' };
function fixture(t, options = {}) {
  let now = Date.now(); const store = new Store(':memory:', { developerIds: [101], clock: () => now, ...options });
  t.after(() => store.close());
  const login = id => store.login({ id, firstName: `Пользователь ${id}`, lastName: '', username: `user${id}` });
  const cmd = (user, type, fields = {}, key = randomUUID()) => store.command(user.user.id, { type, idempotencyKey: key, ...fields });
  const developer = login(101); const manager = login(102); const staff = login(103); const guest = login(104); const outsider = login(105);
  const create = () => cmd(developer, 'createVenue', venueFields).result;
  const assign = venueId => cmd(manager, 'acceptStaffInvite', { code: cmd(developer, 'createManagerInvite', { venueId }).result.code });
  return { store, login, cmd, developer, manager, staff, guest, outsider, create, assign, advance: ms => { now += ms; } };
}

test('developer access fails closed and is never assigned to a first user or via client fields', t => {
  const f = fixture(t, { developerIds: [] });
  assert.equal(f.developer.isDeveloper, false);
  for (const user of [f.developer, f.manager, f.staff, f.guest]) {
    denied(() => f.cmd(user, 'createVenue', { ...venueFields, isDeveloper: true, role: 'owner' }));
    denied(() => f.cmd(user, 'listManagedVenues'));
    denied(() => f.cmd(user, 'createManagerInvite', { venueId: 'fake' }));
  }
  assert.deepEqual(f.store.read().venues, []);
  for (const value of ['0', '-1', '1e3', '42,bad', '9007199254740993', ['x'], null]) assert.throws(() => new Store(':memory:', { developerIds: value }), /DEVELOPER_TELEGRAM_IDS/);
  const explicit = new Store(':memory:', { developerIds: '101, 102' }); t.after(() => explicit.close());
  assert.equal(explicit.isDeveloper(101), true); assert.equal(explicit.isDeveloper(103), false);
});

test('only developer creates venues and sees global metadata, without gaining access to guest data', t => {
  const f = fixture(t); const key = randomUUID();
  const created = f.cmd(f.developer, 'createVenue', venueFields, key); const venueId = created.result.venueId;
  assert.equal(created.isDeveloper, true); assert.deepEqual(created.staffVenues, []); assert.deepEqual(created.db.venues, []);
  denied(() => f.cmd(f.manager, 'createVenue', venueFields));
  f.assign(venueId); f.cmd(f.manager, 'scanGuest', { venueId, qr: f.guest.guestQr });
  f.cmd(f.manager, 'addNote', { venueId, guestId: f.guest.guestId, kind: 'note', text: 'Внутренние сведения команды' });
  const listing = f.cmd(f.developer, 'listManagedVenues').result.managedVenues;
  assert.equal(listing.length, 1); assert.equal(listing[0].id, venueId); assert.equal(listing[0].guestCount, 1); assert.equal(listing[0].staffCount, 1);
  assert.deepEqual(listing[0].managers, [{ userId: f.manager.user.id, name: 'Пользователь 102' }]);
  assert.ok(!JSON.stringify(listing).includes('Внутренние сведения')); assert.ok(!JSON.stringify(listing).includes(f.guest.guestQr));
  denied(() => f.cmd(f.developer, 'scanGuest', { venueId, qr: f.guest.guestQr }));
  assert.deepEqual(f.store.snapshot(101).db.notes, []);
  for (const user of [f.manager, f.staff, f.guest]) denied(() => f.cmd(user, 'listManagedVenues'));
  f.store.developerIds.delete(101);
  denied(() => f.cmd(f.developer, 'createVenue', venueFields, key));
});

test('manager invitation is developer-issued, expiring and one-use; staff cannot promote themselves', t => {
  const f = fixture(t); const { venueId } = f.create();
  const old = f.cmd(f.developer, 'createManagerInvite', { venueId }).result;
  const fresh = f.cmd(f.developer, 'createManagerInvite', { venueId }).result;
  denied(() => f.cmd(f.manager, 'acceptStaffInvite', { code: old.code }), 400);
  const accepted = f.cmd(f.manager, 'acceptStaffInvite', { code: fresh.code, role: 'owner', isDeveloper: true });
  assert.deepEqual(accepted.staffVenues, [{ venueId, role: 'owner' }]); assert.equal(accepted.isDeveloper, false);
  denied(() => f.cmd(f.outsider, 'acceptStaffInvite', { code: fresh.code }), 400);
  denied(() => f.cmd(f.manager, 'createManagerInvite', { venueId }));
  const staffInvite = f.cmd(f.manager, 'createStaffInvite', { venueId, role: 'owner' }).result;
  const staffState = f.cmd(f.staff, 'acceptStaffInvite', { code: staffInvite.code, role: 'owner', isDeveloper: true });
  assert.deepEqual(staffState.staffVenues, [{ venueId, role: 'staff' }]); assert.equal(staffState.isDeveloper, false);
  denied(() => f.cmd(f.staff, 'createStaffInvite', { venueId }));
  denied(() => f.cmd(f.staff, 'createManagerInvite', { venueId }));
  const other = f.create(); denied(() => f.cmd(f.manager, 'createStaffInvite', { venueId: other.venueId }));
  const expires = f.cmd(f.developer, 'createManagerInvite', { venueId: other.venueId }).result;
  f.advance(24 * 60 * 60 * 1000);
  denied(() => f.cmd(f.outsider, 'acceptStaffInvite', { code: expires.code }), 400);
});

test('revoking manager removes server rights, pending invites and replayed access immediately', t => {
  const f = fixture(t); const { venueId } = f.create();
  const invite = f.cmd(f.developer, 'createManagerInvite', { venueId }).result;
  const acceptKey = randomUUID(); f.cmd(f.manager, 'acceptStaffInvite', { code: invite.code }, acceptKey);
  const staffKey = randomUUID(); const pendingStaff = f.cmd(f.manager, 'createStaffInvite', { venueId }, staffKey).result;
  const listKey = randomUUID(); f.cmd(f.manager, 'listStaff', { venueId }, listKey);
  denied(() => f.cmd(f.manager, 'revokeManager', { venueId, userId: 102 }));
  f.cmd(f.developer, 'revokeManager', { venueId, userId: 102 });
  assert.deepEqual(f.store.snapshot(102).staffVenues, []);
  denied(() => f.cmd(f.manager, 'listStaff', { venueId }, listKey));
  denied(() => f.cmd(f.manager, 'createStaffInvite', { venueId }, staffKey));
  denied(() => f.cmd(f.manager, 'acceptStaffInvite', { code: invite.code }, acceptKey));
  denied(() => f.cmd(f.staff, 'acceptStaffInvite', { code: pendingStaff.code }), 400);
  const pendingManager = f.cmd(f.developer, 'createManagerInvite', { venueId }).result;
  f.store.developerIds.delete(101);
  denied(() => f.cmd(f.outsider, 'acceptStaffInvite', { code: pendingManager.code }));
});

test('repeated directory reads return current team and venue counts after a lost response', t => {
  const f = fixture(t); const { venueId } = f.create(); f.assign(venueId);
  const directoryKey = randomUUID(); const teamKey = randomUUID();
  f.cmd(f.developer, 'listManagedVenues', {}, directoryKey);
  f.cmd(f.manager, 'listStaff', { venueId }, teamKey);
  const invite = f.cmd(f.manager, 'createStaffInvite', { venueId }).result;
  f.cmd(f.staff, 'acceptStaffInvite', { code: invite.code });
  f.cmd(f.manager, 'scanGuest', { venueId, qr: f.guest.guestQr });
  const auditCount = f.store.sql.prepare('SELECT COUNT(*) AS count FROM audit').get().count;
  const directory = f.cmd(f.developer, 'listManagedVenues', {}, directoryKey);
  const team = f.cmd(f.manager, 'listStaff', { venueId }, teamKey);
  assert.equal(directory.replayed, true); assert.equal(team.replayed, true);
  assert.equal(directory.result.managedVenues[0].guestCount, 1);
  assert.equal(directory.result.managedVenues[0].staffCount, 2);
  assert.deepEqual(team.result.members.map(member => member.userId).sort(), [102, 103]);
  assert.equal(f.store.sql.prepare('SELECT COUNT(*) AS count FROM audit').get().count, auditCount);
  f.cmd(f.manager, 'revokeStaff', { venueId, userId: 103 });
  assert.equal(f.cmd(f.manager, 'listStaff', { venueId }, teamKey).result.members.length, 1);
  assert.equal(f.cmd(f.developer, 'listManagedVenues', {}, directoryKey).result.managedVenues[0].staffCount, 1);
  f.cmd(f.developer, 'revokeManager', { venueId, userId: 102 });
  const afterRevocation = f.cmd(f.developer, 'listManagedVenues', {}, directoryKey).result.managedVenues[0];
  assert.deepEqual(afterRevocation.managers, []); assert.equal(afterRevocation.staffCount, 0);
  denied(() => f.cmd(f.manager, 'listStaff', { venueId }, teamKey));
});

test('existing team access does not consume an invitation, while staff can accept a manager promotion', t => {
  const f = fixture(t); const { venueId } = f.create(); f.assign(venueId);
  const first = f.cmd(f.manager, 'createStaffInvite', { venueId }).result;
  f.cmd(f.staff, 'acceptStaffInvite', { code: first.code });
  const pending = f.cmd(f.manager, 'createStaffInvite', { venueId }).result;
  denied(() => f.cmd(f.manager, 'acceptStaffInvite', { code: pending.code }), 409);
  denied(() => f.cmd(f.staff, 'acceptStaffInvite', { code: pending.code }), 409);
  assert.equal(f.cmd(f.outsider, 'acceptStaffInvite', { code: pending.code }).staffVenues[0].role, 'staff');
  const promotion = f.cmd(f.developer, 'createManagerInvite', { venueId }).result;
  denied(() => f.cmd(f.manager, 'acceptStaffInvite', { code: promotion.code }), 409);
  const key = randomUUID();
  const accepted = f.cmd(f.staff, 'acceptStaffInvite', { code: promotion.code }, key);
  assert.deepEqual(accepted.staffVenues, [{ venueId, role: 'owner' }]);
  assert.equal(f.cmd(f.staff, 'acceptStaffInvite', { code: promotion.code }, key).replayed, true);
  denied(() => f.cmd(f.guest, 'acceptStaffInvite', { code: promotion.code }), 400);
});

test('QR is unique, opaque and stable; only venue staff can scan and confirmation creates one visit', t => {
  const f = fixture(t); const { venueId } = f.create(); f.assign(venueId);
  assert.match(f.guest.guestQr, /^svoi:guest:v1:[A-Za-z0-9_-]{43}$/);
  assert.notEqual(f.guest.guestQr, f.outsider.guestQr); assert.equal(f.login(104).guestQr, f.guest.guestQr);
  assert.ok(!f.guest.guestQr.includes(f.guest.guestCode));
  denied(() => f.cmd(f.guest, 'scanGuest', { venueId, qr: f.guest.guestQr }));
  denied(() => f.cmd(f.outsider, 'scanGuest', { venueId, qr: f.guest.guestQr }));
  for (const qr of ['', f.guest.guestCode, 'https://example.com/', null, {}, 'svoi:guest:v1:' + 'A'.repeat(42)]) denied(() => f.cmd(f.manager, 'scanGuest', { venueId, qr }), 400);
  denied(() => f.cmd(f.manager, 'scanGuest', { venueId, qr: 'svoi:guest:v1:' + randomBytes(32).toString('base64url') }), 404);
  const scan = f.cmd(f.manager, 'scanGuest', { venueId, qr: f.guest.guestQr }).result;
  assert.deepEqual(scan, { guestId: f.guest.guestId, name: 'Пользователь 104' });
  f.cmd(f.manager, 'scanGuest', { venueId, qr: f.guest.guestQr });
  assert.equal(f.store.read().memberships.length, 1); assert.equal(f.store.read().visits.length, 0); assert.equal(f.store.read().transactions.length, 0);
  const command = { venueId, guestId: scan.guestId, bill: 500, tips: 0, rating: null }; const key = randomUUID();
  f.cmd(f.manager, 'recordVisit', command, key); f.cmd(f.manager, 'recordVisit', command, key);
  const guestState = f.store.snapshot(104); assert.equal(guestState.db.visits.length, 1); assert.equal(guestState.db.memberships[0].balance, 25);
  assert.ok(!JSON.stringify(f.store.snapshot(102).db).includes(f.guest.guestQr));
  const staffInvite = f.cmd(f.manager, 'createStaffInvite', { venueId }).result;
  f.cmd(f.staff, 'acceptStaffInvite', { code: staffInvite.code });
  const scanKey = randomUUID(); f.cmd(f.staff, 'scanGuest', { venueId, qr: f.outsider.guestQr }, scanKey);
  f.cmd(f.manager, 'revokeStaff', { venueId, userId: 103 });
  denied(() => f.cmd(f.staff, 'scanGuest', { venueId, qr: f.outsider.guestQr }, scanKey));
});

test('migration preserves existing users, managers and old invitations while assigning durable QR tokens', t => {
  const directory = mkdtempSync(join(tmpdir(), 'svoi-access-migration-')); const path = join(directory, 'legacy.sqlite');
  let store;
  t.after(() => { store?.close(); assert.equal(dirname(directory), tmpdir()); assert.ok(basename(directory).startsWith('svoi-access-migration-')); rmSync(directory, { recursive: true, force: true }); });
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, first_name TEXT NOT NULL, last_name TEXT NOT NULL, username TEXT, guest_id TEXT NOT NULL UNIQUE, guest_code TEXT NOT NULL UNIQUE);
    CREATE TABLE invites (code_hash TEXT PRIMARY KEY, venue_id TEXT NOT NULL, created_by INTEGER NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL, used_by INTEGER REFERENCES users(id), revoked INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE staff (venue_id TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id), role TEXT NOT NULL CHECK(role IN ('owner','staff')), PRIMARY KEY(venue_id,user_id));
    INSERT INTO users VALUES (102,'Руководитель','','manager','guest-existing','ABCDEFGH');
    INSERT INTO staff VALUES ('venue-existing',102,'owner');
    INSERT INTO invites VALUES ('legacy-hash','venue-existing',102,9999999999999,NULL,0);
    PRAGMA user_version=1;`);
  legacy.close();
  store = new Store(path, { developerIds: [101] });
  const firstQr = store.snapshot(102).guestQr;
  assert.match(firstQr, /^svoi:guest:v1:[A-Za-z0-9_-]{43}$/); assert.equal(store.user(102).guest_code, 'ABCDEFGH');
  assert.deepEqual(store.staff(102), [{ venueId: 'venue-existing', role: 'owner' }]); assert.equal(store.snapshot(102).isDeveloper, false);
  assert.equal(store.sql.prepare('SELECT role FROM invites').get().role, 'staff'); assert.equal(store.sql.prepare('PRAGMA user_version').get().user_version, 2);
  store.close(); store = new Store(path, { developerIds: [101] });
  assert.equal(store.snapshot(102).guestQr, firstQr); assert.equal(store.sql.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});
