import { randomBytes, randomUUID } from 'node:crypto';
import { ApiError } from '../database.mjs';
import { PosStore } from './store.mjs';
import { PosSecrets } from './secrets.mjs';
import { createIikoClient, extractWebhookJobs, verifyWebhookAuthorization } from './iiko.mjs';
import { createRkeeperClient } from './rkeeper.mjs';

const genericFailure = 'Не удалось проверить кассу. Проверьте ключи, разрешения и настройки у администратора кассы.';
const required = (value, label, max = 4096) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new ApiError(400, `Заполните поле «${label}»`);
  return value.trim();
};

export class PosRuntime {
  constructor(store, { masterKey = process.env.POS_MASTER_KEY, publicUrl, fetchImpl = globalThis.fetch, clock = store.clock } = {}) {
    this.store = store; this.pos = new PosStore(store); this.secrets = new PosSecrets(store, masterKey);
    this.clock = clock; this.fetchImpl = fetchImpl; this.publicUrl = publicUrl?.replace(/\/$/, '');
    this.running = null; this.stopped = false; this.nextPoll = new Map();
    store.sql.exec(`CREATE TABLE IF NOT EXISTS pos_jobs (
      connection_id TEXT NOT NULL REFERENCES pos_connections(id), order_id TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 1, attempts INTEGER NOT NULL DEFAULT 0,
      due_at INTEGER NOT NULL, done_at INTEGER, PRIMARY KEY(connection_id,order_id)
    );`);
    store.sql.exec('CREATE TABLE IF NOT EXISTS pos_connection_holds (connection_id TEXT PRIMARY KEY REFERENCES pos_connections(id), created_at INTEGER NOT NULL)');
  }
  webhookUrl(id) { return this.publicUrl ? `${this.publicUrl}/api/pos/webhooks/iiko/${id}` : ''; }
  client(provider, config, id) {
    const options = { fetchImpl: this.fetchImpl, clock: this.clock };
    return provider === 'iiko' ? createIikoClient({ ...config, expectedWebhookUrl: this.webhookUrl(id) }, options) : createRkeeperClient(config, options);
  }
  owner(userId, id) { const connection = this.pos.getConnection(id); this.store.requireStaff(userId, connection.venueId, true); return connection; }
  held(id) { return !!this.store.sql.prepare('SELECT 1 FROM pos_connection_holds WHERE connection_id=?').get(id); }
  status(userId, venueId) {
    const result = this.pos.status(userId, venueId);
    return { ...result, storageReady: this.secrets.available(), connections: result.connections.map(connection => ({ ...connection,
      lastError: this.held(connection.id) ? 'review_required' : connection.lastError,
      verifiedAt: this.store.sql.prepare('SELECT verified_at FROM pos_credentials WHERE connection_id=?').get(connection.id)?.verified_at ?? null,
      webhookUrl: connection.provider === 'iiko' ? this.webhookUrl(connection.id) : null,
    })) };
  }
  save(userId, input) {
    this.store.requireStaff(userId, input.venueId, true);
    if (!this.secrets.available()) throw new ApiError(503, 'Хранение ключей кассы ещё не настроено на сервере');
    const provider = input.provider;
    if (!['iiko', 'rkeeper'].includes(provider)) throw new ApiError(400, 'Выберите iiko или r_keeper');
    const raw = input.config;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ApiError(400, 'Заполните настройки подключения');
    let config; let scope;
    if (provider === 'iiko') {
      scope = required(raw.organizationId, 'organizationId', 36).toLowerCase();
      config = { organizationId: scope, appId: required(raw.appId, 'appId', 100), clientSecret: required(raw.clientSecret, 'clientSecret'),
        apiKey: required(raw.apiKey, 'API-ключ'), terminalGroupIds: raw.terminalGroupIds, utcOffsetMinutes: raw.utcOffsetMinutes,
        webhookToken: randomBytes(32).toString('base64url') };
    } else {
      if (raw.currency !== 'RUB') throw new ApiError(400, 'Подтвердите, что основная валюта ресторана — российский рубль');
      scope = String(Number(raw.objectId));
      config = { objectId: raw.objectId, token: required(raw.token, 'Токен White Server'),
        customerIdProperty: raw.customerIdProperty ? required(raw.customerIdProperty, 'Поле клиента кассы', 100) : null,
        closedAtProperty: required(raw.closedAtProperty, 'Поле времени закрытия', 100),
        openedAtProperty: raw.openedAtProperty ? required(raw.openedAtProperty, 'Поле времени открытия', 100) : null, currency: 'RUB' };
    }
    const old = this.pos.listConnections().find(row => row.provider === provider && row.scope === scope);
    if (old && old.venueId !== input.venueId) throw new ApiError(409, 'Эта касса уже привязана к другому заведению');
    if (!old && this.pos.listConnections().filter(row => row.venueId === input.venueId).length >= 10) throw new ApiError(400, 'Для одного заведения доступно до 10 кассовых подключений');
    const id = old?.id ?? randomUUID();
    // Validation is entirely local; saving never changes vendor configuration or starts billing.
    try { this.client(provider, config, id); } catch { throw new ApiError(400, 'Проверьте формат ключей, идентификаторов и полей кассы'); }
    if (old && provider === 'iiko') config.webhookToken = this.secrets.get(id)?.config.webhookToken ?? config.webhookToken;
    this.pos.configure({ id, venueId: input.venueId, provider, scope, enabled: false, ...(old ? { startedAt: old.startedAt } : {}) });
    this.secrets.save(id, input.venueId, config);
    this.pos.audit(id, 'credentials_saved', { actorId: userId });
    return { connectionId: id };
  }
  async probe(userId, id) {
    const connection = this.owner(userId, id); const credentials = this.secrets.get(id);
    if (this.held(id)) throw new ApiError(409, 'Сначала требуется сверка возврата администратором интеграции');
    if (!credentials) throw new ApiError(400, 'Сначала сохраните ключи кассы');
    let result;
    try { result = await this.client(connection.provider, credentials.config, id).probe(); }
    catch (error) {
      this.owner(userId, id);
      if (this.secrets.revision(id) === credentials.revision) this.pos.updateSync(id, { lastError: 'configuration' });
      throw new ApiError(502, error?.code === 'SETUP' ? 'Для проверки нужен оплаченный тестовый чек с временем закрытия и либо клиентом, либо столом, официантом и временем открытия в настроенных полях r_keeper.' : genericFailure);
    }
    this.owner(userId, id);
    if (this.secrets.revision(id) !== credentials.revision) throw new ApiError(409, 'Настройки изменились. Повторите проверку');
    if (connection.provider === 'iiko' && (!result.webhookMatches || !result.authTokenMatches || !result.tableWebhookConfigured)) {
      this.pos.updateSync(id, { lastError: 'configuration' });
      throw new ApiError(409, 'API доступен. Настройте вебхук TableOrderUpdate для этого подключения и проверьте снова. Существующий вебхук не заменяйте без согласования с администратором.');
    }
    this.secrets.verified(id, credentials.revision, this.clock()); this.pos.updateSync(id, { lastError: null });
    return { ok: true };
  }
  setEnabled(userId, id, enabled) {
    const connection = this.owner(userId, id);
    if (typeof enabled !== 'boolean') throw new ApiError(400, 'Укажите состояние подключения');
    if (enabled) {
      const credentials = this.secrets.get(id);
      if (!credentials?.verifiedAt || this.clock() - credentials.verifiedAt > 15 * 60000) throw new ApiError(409, 'Сначала проверьте соединение с кассой');
      if (this.held(id)) throw new ApiError(409, 'Обнаружен возврат. Сначала требуется сверка с кассовым отчётом администратором интеграции');
    }
    this.pos.configure({ ...connection, enabled }); this.pos.audit(id, enabled ? 'owner_enabled' : 'owner_disabled', { actorId: userId });
    this.nextPoll.delete(id); return { ok: true };
  }
  setup(userId, id) {
    const connection = this.owner(userId, id);
    if (connection.provider !== 'iiko') throw new ApiError(400, 'Вебхук нужен только для iiko');
    return { webhookUrl: this.webhookUrl(id), webhookToken: this.secrets.get(id)?.config.webhookToken };
  }
  bind(userId, input) { return this.pos.bindCustomer(userId, input); }
  webhook(id, authorization, payload) {
    const connection = this.pos.getConnection(id); const credentials = this.secrets.get(id);
    if (connection.provider !== 'iiko' || !credentials || !verifyWebhookAuthorization(authorization, credentials.config.webhookToken)) throw new ApiError(401, 'Не удалось подтвердить источник события');
    let jobs;
    try { jobs = extractWebhookJobs(payload, credentials.config); }
    catch { throw new ApiError(400, 'Некорректное кассовое событие'); }
    this.store.transaction(() => {
      for (const job of jobs) {
        const orderId = typeof job === 'string' ? job : job.externalId;
        this.store.sql.prepare(`INSERT INTO pos_jobs(connection_id,order_id,due_at) VALUES(?,?,?)
          ON CONFLICT(connection_id,order_id) DO UPDATE SET generation=generation+1,attempts=0,due_at=excluded.due_at,done_at=NULL`).run(id, orderId, this.clock());
      }
    });
    return { accepted: jobs.length };
  }
  start() {
    this.timer = setInterval(() => { void this.tick(); }, 10000); this.timer.unref();
    void this.tick();
  }
  async tick() {
    if (this.stopped || this.running) return;
    this.running = this.run();
    try { await this.running; } catch { /* No raw provider errors or credentials in logs. The next tick retries. */ }
    finally { this.running = null; }
  }
  current(id, revision) { return !this.stopped && !this.held(id) && this.pos.getConnection(id).enabled && this.secrets.revision(id) === revision; }
  async run() {
    if (!this.secrets.available()) return;
    const connections = this.pos.listConnections().filter(row => row.enabled && !this.held(row.id));
    // A slow restaurant cannot block every other tenant; each connection is still processed once per tick.
    const work = async connection => {
      if (this.stopped) return;
      const id = connection.id;
      try {
        const credentials = this.secrets.get(id);
        if (!credentials) return;
        const client = this.client(connection.provider, credentials.config, id);
        if (connection.provider === 'rkeeper') {
          if ((this.nextPoll.get(id) ?? 0) > this.clock()) return;
          this.nextPoll.set(id, this.clock() + 60000);
          const { receipts } = await client.poll();
          if (!this.current(id, credentials.revision)) return;
          // A return without a documented original-order reference cannot be safely reversed automatically.
          const returns = receipts.filter(receipt => receipt.status === 'refund' && (!receipt.closedAt || receipt.closedAt >= connection.startedAt));
          if (returns.length) {
            this.pos.importBatch(id, returns);
            this.store.sql.prepare('INSERT OR IGNORE INTO pos_connection_holds(connection_id,created_at) VALUES(?,?)').run(id, this.clock());
            this.pos.configure({ ...this.pos.getConnection(id), enabled: false });
            this.pos.updateSync(id, { lastError: 'review_required' }); return;
          }
          const existing = new Set(this.store.sql.prepare('SELECT external_id FROM pos_orders WHERE connection_id=? AND credited_fingerprint IS NOT NULL').all(id).map(row => row.external_id));
          receipts.sort((a, b) => Number(existing.has(b.externalId)) - Number(existing.has(a.externalId)) || (a.closedAt ?? '').localeCompare(b.closedAt ?? ''));
          this.pos.importBatch(id, receipts);
          this.pos.updateSync(id, { lastSuccessAt: new Date(this.clock()).toISOString(), lastError: null });
          this.pos.retryPending(id);
        } else {
          const jobs = this.store.sql.prepare('SELECT * FROM pos_jobs WHERE connection_id=? AND done_at IS NULL AND due_at<=? ORDER BY due_at LIMIT 25').all(id, this.clock());
          const targets = this.pos.servicePollTargets(id);
          const pollServices = (targets.tableIds.length || targets.orderIds.length) && (jobs.length || (this.nextPoll.get(id) ?? 0) <= this.clock());
          try {
            const receipts = new Map();
            if (pollServices) {
              // Discover all candidates before matching; a single webhook must
              // not win merely because another order at the table arrived later.
              if (targets.tableIds.length) for (const receipt of await client.fetchTableReceipts(targets.tableIds, targets.since)) receipts.set(receipt.externalId, receipt);
            }
            const ids = [...new Set([...jobs.map(job => job.order_id), ...(pollServices ? targets.orderIds : [])])];
            for (let offset = 0; offset < ids.length; offset += 100) {
              for (const receipt of await client.fetchReceipts(ids.slice(offset, offset + 100))) receipts.set(receipt.externalId, receipt);
            }
            if (!this.current(id, credentials.revision)) return;
            if (receipts.size) this.pos.importBatch(id, [...receipts.values()]);
            // The HTTP response may race a newer webhook; keep that generation queued.
            for (const job of jobs) this.store.sql.prepare('UPDATE pos_jobs SET done_at=?,attempts=0 WHERE connection_id=? AND order_id=? AND generation=?').run(this.clock(), id, job.order_id, job.generation);
            if (pollServices) this.nextPoll.set(id, this.clock() + 60000);
            if (receipts.size || pollServices) this.pos.updateSync(id, { lastSuccessAt: new Date(this.clock()).toISOString(), lastError: null });
          } catch {
            for (const job of jobs) {
              this.store.sql.prepare('UPDATE pos_jobs SET attempts=attempts+1,due_at=? WHERE connection_id=? AND order_id=? AND generation=?').run(this.clock() + Math.min(3600000, 10000 * 2 ** Math.min(job.attempts, 9)), id, job.order_id, job.generation);
            }
            if (pollServices) this.nextPoll.set(id, this.clock() + 60000);
            this.pos.updateSync(id, { lastError: 'sync_failed' });
          }
          this.pos.retryPending(id);
        }
      } catch { this.pos.updateSync(id, { lastError: 'sync_failed' }); }
    };
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, connections.length) }, async () => { while (next < connections.length && !this.stopped) await work(connections[next++]); }));
  }
  async close() { this.stopped = true; clearInterval(this.timer); if (this.running) await this.running; }
}
