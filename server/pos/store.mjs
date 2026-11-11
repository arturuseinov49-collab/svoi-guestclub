import { createHash } from 'node:crypto';
import { ApiError } from '../database.mjs';
import { recordVisit } from '../domain.mjs';

const providers = new Set(['iiko', 'rkeeper']);
const receiptStates = new Set(['paid', 'open', 'refund', 'review']);
const syncErrors = new Set(['unavailable', 'unauthorized', 'invalid_response', 'rate_limited', 'configuration', 'timeout', 'review_required', 'sync_failed']);
const messages = {
  imported: 'Визит и бонусы учтены', open: 'Заказ ещё не закрыт и не оплачен',
  unmatched: 'Нужна привязка клиента кассы к гостю', review: 'Нужна сверка изменения или возврата',
  held: 'Начисление приостановлено до сверки гостя', ignored: 'Чек закрыт до начала подключения',
};
const fail = (status, message) => { throw new ApiError(status, message); };
const text = (value, label, max = 200) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail(400, `Некорректное поле: ${label}`);
  return value.trim();
};
const timestamp = (value, label) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) fail(400, `Некорректное время: ${label}`);
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) fail(400, `Некорректное время: ${label}`);
  return new Date(value).toISOString();
};
const digest = receipt => createHash('sha256').update(JSON.stringify(receipt)).digest('hex');

/** Private server import boundary. It must never receive raw receipt data from a public Mini App route. */
export class PosStore {
  constructor(store) {
    this.store = store; this.sql = store.sql; this.clock = store.clock;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS pos_connections (
        id TEXT PRIMARY KEY, venue_id TEXT NOT NULL, provider TEXT NOT NULL CHECK(provider IN ('iiko','rkeeper')),
        scope TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), started_at TEXT NOT NULL,
        cursor TEXT, last_attempt_at TEXT, last_success_at TEXT, last_error TEXT, created_at TEXT NOT NULL,
        UNIQUE(provider,scope)
      );
      CREATE TABLE IF NOT EXISTS pos_customer_links (
        connection_id TEXT NOT NULL REFERENCES pos_connections(id), customer_id TEXT NOT NULL,
        guest_id TEXT NOT NULL REFERENCES users(guest_id), actor_id INTEGER NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL, PRIMARY KEY(connection_id,customer_id)
      );
      CREATE TABLE IF NOT EXISTS pos_orders (
        connection_id TEXT NOT NULL REFERENCES pos_connections(id), external_id TEXT NOT NULL,
        receipt TEXT NOT NULL, fingerprint TEXT NOT NULL, outcome TEXT NOT NULL,
        guest_id TEXT REFERENCES users(guest_id), visit_id TEXT, earned INTEGER NOT NULL DEFAULT 0,
        credited_fingerprint TEXT, credited_receipt TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(connection_id,external_id)
      );
      CREATE INDEX IF NOT EXISTS pos_orders_outcome ON pos_orders(connection_id,outcome);
      CREATE TABLE IF NOT EXISTS pos_guest_holds (
        venue_id TEXT NOT NULL, guest_id TEXT NOT NULL REFERENCES users(guest_id),
        connection_id TEXT NOT NULL REFERENCES pos_connections(id), external_id TEXT NOT NULL,
        created_at TEXT NOT NULL, PRIMARY KEY(venue_id,guest_id,connection_id,external_id)
      );
      CREATE TABLE IF NOT EXISTS pos_audit (
        id INTEGER PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES pos_connections(id), external_id TEXT,
        guest_id TEXT REFERENCES users(guest_id), actor_id INTEGER REFERENCES users(id), action TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }
  now() { return new Date(this.clock()).toISOString(); }
  audit(connectionId, action, { externalId = null, guestId = null, actorId = null } = {}) {
    this.sql.prepare('INSERT INTO pos_audit(connection_id,external_id,guest_id,actor_id,action,created_at) VALUES (?,?,?,?,?,?)').run(connectionId, externalId, guestId, actorId, action, this.now());
  }
  /** Called only with trusted deployment configuration; never store credentials here. */
  configure({ id, venueId, provider, scope, enabled = false, startedAt }) {
    id = text(id, 'подключение', 80); venueId = text(venueId, 'заведение', 100); scope = text(scope, 'касса');
    if (!providers.has(provider) || typeof enabled !== 'boolean') fail(400, 'Некорректное подключение кассы');
    return this.store.transaction(() => {
      if (!this.store.read().venues.some(venue => venue.id === venueId)) fail(404, 'Заведение не найдено');
      const old = this.getConnection(id, false);
      startedAt = timestamp(startedAt ?? old?.startedAt ?? this.now(), 'начало подключения');
      if (old && (old.venueId !== venueId || old.provider !== provider || old.scope !== scope || old.startedAt !== startedAt)) fail(409, 'Нельзя менять кассу, заведение или начало действующего подключения');
      const occupied = this.sql.prepare('SELECT id FROM pos_connections WHERE provider=? AND scope=? AND id<>?').get(provider, scope, id);
      if (occupied) fail(409, 'Эта касса уже привязана к другому подключению');
      if (!old) this.sql.prepare('INSERT INTO pos_connections(id,venue_id,provider,scope,enabled,started_at,created_at) VALUES (?,?,?,?,?,?,?)').run(id, venueId, provider, scope, Number(enabled), startedAt, this.now());
      else this.sql.prepare('UPDATE pos_connections SET enabled=? WHERE id=?').run(Number(enabled), id);
      if (!old || old.enabled !== enabled) this.audit(id, !old ? 'configured' : enabled ? 'enabled' : 'disabled');
      return this.getConnection(id);
    });
  }
  getConnection(id, required = true) {
    const row = this.sql.prepare('SELECT * FROM pos_connections WHERE id=?').get(text(id, 'подключение', 80));
    if (!row) { if (required) fail(404, 'Подключение кассы не найдено'); return null; }
    return { id: row.id, venueId: row.venue_id, provider: row.provider, scope: row.scope, enabled: !!row.enabled, startedAt: row.started_at,
      cursor: row.cursor === null ? null : JSON.parse(row.cursor), lastAttemptAt: row.last_attempt_at, lastSuccessAt: row.last_success_at, lastError: row.last_error };
  }
  listConnections() { return this.sql.prepare('SELECT id FROM pos_connections ORDER BY id').all().map(row => this.getConnection(row.id)); }
  updateSync(connectionId, update) {
    if (!update || typeof update !== 'object') fail(400, 'Некорректный результат обмена');
    return this.store.transaction(() => {
      const connection = this.getConnection(connectionId);
      const cursor = Object.hasOwn(update, 'cursor') ? JSON.stringify(update.cursor) : JSON.stringify(connection.cursor);
      if (typeof cursor !== 'string' || Buffer.byteLength(cursor) > 8192) fail(400, 'Некорректный курсор обмена');
      const lastError = Object.hasOwn(update, 'lastError') ? update.lastError : connection.lastError;
      if (lastError !== null && !syncErrors.has(lastError)) fail(400, 'Некорректный код ошибки обмена');
      const lastSuccess = update.lastSuccessAt == null ? connection.lastSuccessAt : timestamp(update.lastSuccessAt, 'обмен');
      this.sql.prepare('UPDATE pos_connections SET cursor=?,last_attempt_at=?,last_success_at=?,last_error=? WHERE id=?').run(cursor, this.now(), lastSuccess, lastError, connectionId);
      if (lastError && lastError !== connection.lastError) this.audit(connectionId, `sync_${lastError}`);
      return this.getConnection(connectionId);
    });
  }
  normalize(connection, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'Некорректный чек');
    if (input.provider !== connection.provider || input.scope !== connection.scope) fail(409, 'Чек относится к другой кассе');
    const externalId = text(input.externalId, 'номер чека');
    if (!receiptStates.has(input.status)) fail(400, 'Неизвестный статус чека');
    const billMinor = input.billMinor;
    if (billMinor !== null && (!Number.isSafeInteger(billMinor) || billMinor < 0 || billMinor > 100000000)) fail(400, 'Некорректная сумма чека в копейках');
    const customerId = input.customerId === null ? null : text(input.customerId, 'клиент кассы');
    const closedAt = input.closedAt === null ? null : timestamp(input.closedAt, 'закрытие чека');
    if (input.status === 'paid' && (billMinor === null || billMinor === 0 || !closedAt)) fail(400, 'Оплаченный чек должен содержать сумму и время закрытия');
    if (closedAt && Date.parse(closedAt) > this.clock() + 300000) fail(400, 'Время закрытия чека находится в будущем');
    return { provider: connection.provider, scope: connection.scope, externalId, status: input.status, billMinor, customerId, closedAt };
  }
  importReceipt(connectionId, input) {
    return this.store.transaction(() => {
      const connection = this.getConnection(connectionId);
      if (!connection.enabled) fail(409, 'Подключение кассы выключено');
      return this.apply(connection, this.normalize(connection, input));
    });
  }
  linked(connectionId, customerId) {
    return customerId === null ? null : this.sql.prepare('SELECT guest_id FROM pos_customer_links WHERE connection_id=? AND customer_id=?').get(connectionId, customerId)?.guest_id ?? null;
  }
  hold(connection, guestId, externalId) {
    if (guestId) this.sql.prepare('INSERT OR IGNORE INTO pos_guest_holds(venue_id,guest_id,connection_id,external_id,created_at) VALUES (?,?,?,?,?)').run(connection.venueId, guestId, connection.id, externalId, this.now());
  }
  /** Runs inside caller transaction; return values contain no vendor payload or credentials. */
  apply(connection, receipt) {
    const old = this.sql.prepare('SELECT * FROM pos_orders WHERE connection_id=? AND external_id=?').get(connection.id, receipt.externalId);
    const fingerprint = digest(receipt); const now = this.now();
    let guestId = this.linked(connection.id, receipt.customerId); let outcome; let earned = old?.earned ?? 0; let visitId = old?.visit_id ?? null;
    let creditedFingerprint = old?.credited_fingerprint ?? null; let creditedReceipt = old?.credited_receipt ?? null;
    if (old?.credited_fingerprint) {
      guestId = old.guest_id;
      outcome = old.outcome === 'review' || fingerprint !== old.credited_fingerprint ? 'review' : 'imported';
      if (outcome === 'review') { this.hold(connection, guestId, receipt.externalId); this.hold(connection, this.linked(connection.id, receipt.customerId), receipt.externalId); }
    } else if (old?.outcome === 'review') {
      outcome = 'review'; this.hold(connection, guestId, receipt.externalId);
    } else if (receipt.closedAt && receipt.closedAt < connection.startedAt) outcome = 'ignored';
    else if (receipt.status === 'refund' || receipt.status === 'review') {
      outcome = 'review'; this.hold(connection, guestId, receipt.externalId);
    } else if (receipt.status === 'open') outcome = 'open';
    else if (!guestId) outcome = 'unmatched';
    else if (this.sql.prepare('SELECT 1 FROM pos_guest_holds WHERE venue_id=? AND guest_id=? LIMIT 1').get(connection.venueId, guestId)) outcome = 'held';
    else {
      const db = this.store.read();
      if (!db.memberships.some(member => member.venueId === connection.venueId && member.guestId === guestId)) outcome = 'unmatched';
      else {
        const result = recordVisit(db, { venueId: connection.venueId, guestId, bill: receipt.billMinor / 100, tips: 0, tipsKnown: false, rating: null,
          source: receipt.provider, externalId: `${receipt.scope}:${receipt.externalId}` }, receipt.closedAt);
        this.store.write(result.db); earned = result.earned; visitId = result.db.visits[0].id; creditedFingerprint = fingerprint; creditedReceipt = JSON.stringify(receipt); outcome = 'imported';
      }
    }
    this.sql.prepare(`INSERT INTO pos_orders(connection_id,external_id,receipt,fingerprint,outcome,guest_id,visit_id,earned,credited_fingerprint,credited_receipt,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(connection_id,external_id) DO UPDATE SET receipt=excluded.receipt,fingerprint=excluded.fingerprint,outcome=excluded.outcome,
      guest_id=excluded.guest_id,visit_id=excluded.visit_id,earned=excluded.earned,credited_fingerprint=excluded.credited_fingerprint,credited_receipt=excluded.credited_receipt,updated_at=excluded.updated_at`)
      .run(connection.id, receipt.externalId, JSON.stringify(receipt), fingerprint, outcome, guestId, visitId, earned, creditedFingerprint, creditedReceipt, old?.created_at ?? now, now);
    if (!old || old.outcome !== outcome || old.fingerprint !== fingerprint) this.audit(connection.id, outcome, { externalId: receipt.externalId, guestId });
    return { connectionId: connection.id, externalId: receipt.externalId, status: outcome, earned, guestId, visitId,
      duplicate: !!old && old.fingerprint === fingerprint && old.outcome === outcome, message: messages[outcome] };
  }
  bindCustomer(userId, { connectionId, externalId, guestCode }) {
    return this.store.transaction(() => {
      const connection = this.getConnection(connectionId); this.store.requireStaff(userId, connection.venueId, true);
      if (!connection.enabled) fail(409, 'Подключение кассы выключено');
      const order = this.sql.prepare('SELECT * FROM pos_orders WHERE connection_id=? AND external_id=?').get(connectionId, text(externalId, 'чек'));
      if (!order) fail(404, 'Чек не найден'); const receipt = JSON.parse(order.receipt);
      if (!receipt.customerId) fail(400, 'Касса не передала идентификатор клиента');
      const normalizedCode = text(guestCode, 'код гостя', 40).replace(/[\s-]/g, '').toUpperCase();
      const user = this.sql.prepare('SELECT guest_id FROM users WHERE guest_code=?').get(normalizedCode);
      if (!user || !this.store.read().memberships.some(member => member.venueId === connection.venueId && member.guestId === user.guest_id)) fail(404, 'Гость с этим кодом не найден в заведении');
      const existing = this.linked(connectionId, receipt.customerId);
      // Corrections require explicit reconciliation; silently moving a customer can award another person.
      if (existing && existing !== user.guest_id) fail(409, 'Клиент кассы уже привязан к другому гостю');
      if (!existing) {
        this.sql.prepare('INSERT INTO pos_customer_links(connection_id,customer_id,guest_id,actor_id,created_at) VALUES (?,?,?,?,?)').run(connectionId, receipt.customerId, user.guest_id, userId, this.now());
        this.audit(connectionId, 'customer_linked', { externalId: receipt.externalId, guestId: user.guest_id, actorId: userId });
      }
      // A refund seen before mapping must block this guest before any pending paid receipt is processed.
      for (const row of this.sql.prepare("SELECT external_id FROM pos_orders WHERE connection_id=? AND outcome='review' AND json_extract(receipt,'$.customerId')=?").all(connectionId, receipt.customerId)) {
        this.hold(connection, user.guest_id, row.external_id);
      }
      const pending = this.sql.prepare("SELECT receipt FROM pos_orders WHERE connection_id=? AND outcome IN ('unmatched','held') AND json_extract(receipt,'$.customerId')=? ORDER BY json_extract(receipt,'$.closedAt'),external_id LIMIT 500").all(connectionId, receipt.customerId)
        .map(row => JSON.parse(row.receipt));
      const results = pending.map(item => this.apply(connection, item));
      return { guestId: user.guest_id, imported: results.filter(item => item.status === 'imported' && !item.duplicate).length,
        earned: results.filter(item => item.status === 'imported' && !item.duplicate).reduce((sum, item) => sum + item.earned, 0) };
    });
  }
  retryPending(connectionId, { limit = 100 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) fail(400, 'Некорректный размер пакета');
    return this.store.transaction(() => {
      const connection = this.getConnection(connectionId); if (!connection.enabled) fail(409, 'Подключение кассы выключено');
      return this.sql.prepare("SELECT receipt FROM pos_orders WHERE connection_id=? AND outcome='unmatched' AND json_extract(receipt,'$.customerId') IN (SELECT customer_id FROM pos_customer_links WHERE connection_id=?) ORDER BY json_extract(receipt,'$.closedAt'),external_id LIMIT ?")
        .all(connectionId, connectionId, limit).map(row => this.apply(connection, JSON.parse(row.receipt)));
    });
  }
  status(userId, venueId) {
    this.store.requireStaff(userId, venueId);
    const connections = this.sql.prepare('SELECT id FROM pos_connections WHERE venue_id=? ORDER BY provider,id').all(venueId).map(row => {
      const { cursor, ...connection } = this.getConnection(row.id);
      const counts = Object.fromEntries(this.sql.prepare('SELECT outcome,COUNT(*) AS count FROM pos_orders WHERE connection_id=? GROUP BY outcome').all(row.id).map(item => [item.outcome, item.count]));
      return { ...connection, counts };
    });
    const receipts = this.sql.prepare(`SELECT o.* FROM pos_orders o JOIN pos_connections c ON c.id=o.connection_id WHERE c.venue_id=?
      ORDER BY CASE o.outcome WHEN 'review' THEN 0 WHEN 'held' THEN 1 WHEN 'unmatched' THEN 2 ELSE 3 END,o.updated_at DESC,o.external_id LIMIT 100`).all(venueId).map(row => {
      const receipt = JSON.parse(row.receipt);
      return { connectionId: row.connection_id, externalId: row.external_id, provider: receipt.provider, customerId: receipt.customerId, status: row.outcome,
        billMinor: receipt.billMinor, closedAt: receipt.closedAt, earned: row.earned, guestId: row.guest_id, message: messages[row.outcome] };
    });
    return { connections, receipts, heldGuests: this.sql.prepare('SELECT COUNT(DISTINCT guest_id) AS count FROM pos_guest_holds WHERE venue_id=?').get(venueId).count };
  }
}
