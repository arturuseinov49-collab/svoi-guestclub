import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { Store, ApiError } from '../server/database.mjs';
import { PosRuntime } from '../server/pos/runtime.mjs';
import { PosSecrets } from '../server/pos/secrets.mjs';
import { createApplication } from '../server/application.mjs';

const org = '11111111-1111-4111-8111-111111111111';
const terminal = '22222222-2222-4222-8222-222222222222';
const orderId = '33333333-3333-4333-8333-333333333333';
const customer = '44444444-4444-4444-8444-444444444444';
const config = { organizationId: org, terminalGroupIds: [terminal], utcOffsetMinutes: 180,
  appId: 'application-secret-name', clientSecret: 'test-client-secret-sensitive', apiKey: 'test-api-key-sensitive' };
const response = body => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const statusError = status => error => error instanceof ApiError && error.status === status;
const event = (fields = {}) => [{ eventType: 'TableOrderUpdate', organizationId: org, eventInfo: { id: orderId, ...fields } }];
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

function fixture(t, { durable = false, storage = true } = {}) {
  const dir = durable ? mkdtempSync(join(tmpdir(), 'svoi-pos-runtime-')) : null;
  const path = dir ? join(dir, 'test.sqlite') : ':memory:'; const masterKey = storage ? randomBytes(32).toString('base64') : undefined;
  let now = Date.parse('2026-11-10T12:00:00Z'); let store = new Store(path, { clock: () => now, developerIds: [900000001] }); let runtime; let connectionId;
  const flags = { orderError: false, hookMismatch: false, secretMismatch: false, gate: null, reached: null, rkeeperRows: [], rkeeperDates: {}, tableOrders: [], tableError: false };
  const calls = [];
  const order = { id: orderId, organizationId: org, creationStatus: 'Success', order: { terminalGroupId: terminal, status: 'Closed', sum: 1000,
    processedPaymentsSum: 1000, customer: { id: customer }, whenClosed: '2026-11-10 15:00:01' } };
  const fetchImpl = async (url, options) => {
    if (new URL(url).origin === 'https://ws.ucs.ru') {
      assert.equal(url, 'https://ws.ucs.ru/wsserverlp/api/v2/aggregators/Create'); assert.equal(options.headers.AggregatorAuthentication, 'test-rkeeper-secret');
      const request = JSON.parse(options.body); let taskResponse;
      if (request.taskType === 'GetOrderList') taskResponse = { orders: flags.rkeeperRows };
      else if (request.taskType === 'GetOrder') {
        const row = flags.rkeeperRows.find(item => item.orderGuid === request.params.orderGuid); assert.ok(row);
        taskResponse = { order: { orderGuid: row.orderGuid, price: { total: row.sum, sumToPay: 0 },
          extProperties: { svoiCustomerId: 'rk-customer', svoiClosedAt: flags.rkeeperDates[row.orderGuid] ?? '2026-11-10T12:00:01Z' } } };
      } else throw new Error(`Unexpected r_keeper task ${request.taskType}`);
      return response({ responseCommon: { objectId: 7, taskType: request.taskType, taskGuid: randomUUID() }, taskResponse });
    }
    assert.equal(new URL(url).origin, 'https://api-ru.iiko.services'); assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    const path = new URL(url).pathname; const body = JSON.parse(options.body); calls.push({ path, body });
    if (path === '/api/v2/access_token') return response({ token: 'server-access-token-sensitive' });
    assert.equal(options.headers.Authorization, 'Bearer server-access-token-sensitive');
    if (path === '/api/1/organizations') return response({ organizations: [{ id: org, currencyIsoName: 'RUB' }] });
    if (path === '/api/1/terminal_groups') return response({ terminalGroups: [{ organizationId: org, items: [{ id: terminal, organizationId: org, timeZone: '03:00:00' }] }] });
    if (path === '/api/1/webhooks/settings') return response({ webHooksUri: flags.hookMismatch ? 'https://old.example/hook' : runtime.webhookUrl(connectionId),
      authToken: flags.secretMismatch ? 'invalid-secret-value-that-does-not-match' : runtime.setup(owner.user.id, connectionId).webhookToken,
      webHooksFilter: { tableOrderFilter: { orderStatuses: ['Closed', 'Deleted'] } } });
    if (path === '/api/1/order/by_id') {
      assert.deepEqual(body.organizationIds, [org]); assert.ok(Array.isArray(body.orderIds));
      flags.reached?.resolve(); if (flags.gate) await flags.gate.promise;
      if (flags.orderError) throw new Error('simulated provider failure containing a secret that must not escape');
      return response({ orders: body.orderIds.map(id => structuredClone(id === orderId ? order : flags.tableOrders.find(item => item.id === id))).filter(Boolean) });
    }
    if (path === '/api/1/order/by_table') {
      assert.deepEqual(body.organizationIds, [org]); assert.equal(body.dateFrom, '2026-11-10 15:01:00.000');
      if (flags.tableError) throw new Error('simulated table fetch failure');
      return response({ orders: structuredClone(flags.tableOrders) });
    }
    throw new Error(`Unexpected vendor API path: ${path}`);
  };
  const createRuntime = () => new PosRuntime(store, { masterKey, publicUrl: 'https://svoi.test', fetchImpl, clock: () => now });
  runtime = createRuntime();
  const login = id => store.login({ id, firstName: `Гость ${id}`, lastName: '', username: null });
  const owner = login(2001); const guest = login(2002); const otherOwner = login(2003); const staff = login(2004);
  const command = (user, type, fields = {}) => store.command(user.user.id, { type, idempotencyKey: randomUUID(), ...fields });
  const developer = login(900000001);
  const venue = command(developer, 'createVenue', { name: 'Касса runtime', kind: 'Кафе', address: 'Адрес 1' }).result;
  const otherVenue = command(developer, 'createVenue', { name: 'Другая касса', kind: 'Кафе', address: 'Адрес 2' }).result;
  for (const [venueId, userId] of [[venue.venueId, owner.user.id], [otherVenue.venueId, otherOwner.user.id]]) store.sql.prepare("INSERT INTO staff(venue_id,user_id,role) VALUES (?,?,'owner')").run(venueId, userId);
  command(owner, 'addGuest', { venueId: venue.venueId, guestCode: guest.guestCode });
  command(staff, 'acceptStaffInvite', { code: command(owner, 'createStaffInvite', { venueId: venue.venueId }).result.code });
  t.after(async () => {
    await runtime.close(); store.close();
    if (dir) { assert.equal(dirname(dir), tmpdir()); assert.ok(basename(dir).startsWith('svoi-pos-runtime-')); rmSync(dir, { recursive: true, force: true }); }
  });
  return { owner, guest, otherOwner, staff, venue, otherVenue, flags, calls, order, path, masterKey, command,
    get runtime() { return runtime; }, get store() { return store; }, get id() { return connectionId; },
    save(fields = {}) { connectionId = runtime.save(owner.user.id, { venueId: venue.venueId, provider: 'iiko', config: { ...config, ...fields } }).connectionId; return connectionId; },
    async activate() { await runtime.probe(owner.user.id, connectionId); runtime.setEnabled(owner.user.id, connectionId, true); now += 60000; },
    token() { return runtime.setup(owner.user.id, connectionId).webhookToken; },
    hook(payload = event()) { return runtime.webhook(connectionId, this.token(), payload); },
    advance(ms) { now += ms; },
    balance() { return store.read().memberships.find(member => member.venueId === venue.venueId && member.guestId === guest.guestId).balance; },
    async restart() { await runtime.close(); store.close(); store = new Store(path, { clock: () => now, developerIds: [900000001] }); runtime = createRuntime(); },
  };
}

const serviceTable = '66666666-6666-4666-8666-666666666666';
const serviceWaiter = '77777777-7777-4777-8777-777777777777';
async function tableFixture(t) {
  const f = fixture(t); f.save(); await f.activate();
  f.command(f.owner, 'configureServiceMapping', { venueId: f.venue.venueId, connectionId: f.id,
    tables: [{ label: '7', posTableId: serviceTable }], staff: [{ userId: f.staff.user.id, posWaiterId: serviceWaiter }] });
  f.command(f.staff, 'startService', { venueId: f.venue.venueId, guestId: f.guest.guestId, tableLabel: '7' });
  Object.assign(f.order.order, { status: 'New', customer: null, processedPaymentsSum: 0, whenClosed: null,
    tableIds: [serviceTable], waiter: { id: serviceWaiter }, whenCreated: '2026-11-10 15:01:01.000',
    items: [{ type: 'Product', product: { name: 'Тако' }, amount: 2, resultSum: 1000 }], comment: 'Staff-only kitchen note' });
  f.flags.tableOrders = [f.order]; return f;
}

test('service polling discovers an order without a customer or webhook, follows sticky ID and imports its paid check once', async t => {
  const f = await tableFixture(t); await f.runtime.tick();
  let guestState = f.store.snapshot(f.guest.user.id);
  assert.equal(guestState.serviceSessions[0].status, 'linked'); assert.equal(guestState.db.visits.length, 0);
  assert.equal(guestState.serviceSessions[0].order.items[0].name, 'Тако');
  assert.equal(JSON.stringify(guestState.serviceSessions).includes('Staff-only'), false);
  Object.assign(f.order.order, { status: 'Closed', processedPaymentsSum: 1000, whenClosed: '2026-11-10 15:02:01.000', tableIds: [customer] });
  f.advance(61000); await f.runtime.tick();
  guestState = f.store.snapshot(f.guest.user.id);
  assert.equal(guestState.serviceSessions[0].status, 'closed'); assert.equal(guestState.serviceSessions[0].order.status, 'paid'); assert.equal(guestState.db.visits.length, 1);
  assert.equal(f.balance(), 50); assert.equal(guestState.globalWallet.balance, 10);
  f.hook(); await f.runtime.tick(); assert.equal(f.store.read().visits.length, 1); assert.equal(f.balance(), 50);
});

test('service discovery sees an entire ambiguous table batch before crediting and rejects partial failed discovery', async t => {
  const f = await tableFixture(t);
  Object.assign(f.order.order, { status: 'Closed', processedPaymentsSum: 1000, whenClosed: '2026-11-10 15:01:02.000' });
  f.flags.tableOrders.push({ ...structuredClone(f.order), id: serviceWaiter });
  f.hook(); f.flags.tableError = true; await f.runtime.tick();
  assert.equal(f.store.read().visits.length, 0); assert.equal(f.store.sql.prepare('SELECT done_at FROM pos_jobs').get().done_at, null);
  f.flags.tableError = false; f.advance(20000); await f.runtime.tick();
  const state = f.store.snapshot(f.guest.user.id);
  assert.equal(state.serviceSessions[0].status, 'review'); assert.equal(state.serviceSessions[0].order, undefined);
  assert.equal(state.db.visits.length, 0); assert.equal(state.globalWallet.balance, 0);
  assert.equal(f.store.snapshot(f.owner.user.id).serviceSessions[0].candidates.length, 2);
});

test('POS credentials are encrypted, authenticated to venue/connection, absent from status, and owner-scoped', async t => {
  const f = fixture(t, { durable: true }); f.save();
  const row = f.store.sql.prepare('SELECT encrypted FROM pos_credentials WHERE connection_id=?').get(f.id);
  for (const secret of [config.clientSecret, config.apiKey, config.appId, f.token()]) assert.ok(!row.encrypted.includes(secret));
  const publicStatus = JSON.stringify(f.runtime.status(f.staff.user.id, f.venue.venueId));
  for (const secret of [config.clientSecret, config.apiKey, config.appId, f.token()]) assert.ok(!publicStatus.includes(secret));
  assert.throws(() => f.runtime.setup(f.staff.user.id, f.id), statusError(403));
  assert.throws(() => f.runtime.setup(f.otherOwner.user.id, f.id), statusError(403));
  assert.throws(() => f.runtime.status(f.otherOwner.user.id, f.venue.venueId), statusError(403));
  assert.throws(() => f.runtime.save(f.guest.user.id, { venueId: f.venue.venueId, provider: 'iiko', config }), statusError(403));
  assert.throws(() => f.runtime.save(f.otherOwner.user.id, { venueId: f.otherVenue.venueId, provider: 'iiko', config }), statusError(409));
  assert.throws(() => new PosSecrets(f.store, randomBytes(32).toString('base64')).get(f.id), statusError(503));
  f.store.sql.prepare('UPDATE pos_credentials SET venue_id=? WHERE connection_id=?').run(f.otherVenue.venueId, f.id);
  assert.throws(() => f.runtime.secrets.get(f.id), statusError(503));
  // SQLite/WAL contain ciphertext only, even before checkpointing or closing the process.
  const bytes = readFileSync(f.path).toString('utf8');
  assert.ok(!bytes.includes(config.clientSecret)); assert.ok(!bytes.includes(config.apiKey));
});

test('POS cannot save credentials without server encryption or activate before a matching verified webhook', async t => {
  const unavailable = fixture(t, { storage: false });
  assert.equal(unavailable.runtime.status(unavailable.owner.user.id, unavailable.venue.venueId).storageReady, false);
  assert.throws(() => unavailable.save(), statusError(503)); assert.equal(unavailable.runtime.pos.listConnections().length, 0);
  const f = fixture(t); f.save();
  assert.equal(f.runtime.pos.getConnection(f.id).enabled, false);
  assert.throws(() => f.runtime.setEnabled(f.owner.user.id, f.id, true), statusError(409));
  f.flags.hookMismatch = true; await assert.rejects(f.runtime.probe(f.owner.user.id, f.id), statusError(409));
  f.flags.hookMismatch = false; f.flags.secretMismatch = true; await assert.rejects(f.runtime.probe(f.owner.user.id, f.id), statusError(409));
  f.flags.secretMismatch = false; await f.runtime.probe(f.owner.user.id, f.id);
  f.advance(16 * 60000); assert.throws(() => f.runtime.setEnabled(f.owner.user.id, f.id, true), statusError(409));
});

test('POS authenticated webhook queues durable jobs, retries after restart and imports only fresh API receipt once', async t => {
  const f = fixture(t, { durable: true }); f.save(); await f.activate();
  assert.throws(() => f.runtime.webhook(f.id, 'forged-secret', event()), statusError(401));
  assert.equal(f.store.sql.prepare('SELECT COUNT(*) AS n FROM pos_jobs').get().n, 0);
  const otherOrg = [{ eventType: 'TableOrderUpdate', organizationId: '99999999-9999-4999-8999-999999999999', eventInfo: { id: orderId } }];
  assert.throws(() => f.hook(otherOrg), statusError(400)); assert.equal(f.store.sql.prepare('SELECT COUNT(*) AS n FROM pos_jobs').get().n, 0);
  assert.deepEqual(f.hook(event({ sum: 999999, customer: { id: customer }, status: 'Closed' })), { accepted: 1 });
  f.flags.orderError = true; await f.runtime.tick();
  assert.equal(f.store.sql.prepare('SELECT attempts FROM pos_jobs').get().attempts, 1); assert.equal(f.balance(), 0);
  const publicStatus = JSON.stringify(f.runtime.status(f.owner.user.id, f.venue.venueId)); assert.ok(!publicStatus.includes('secret that must not escape'));
  await f.restart(); f.flags.orderError = false; f.advance(20000); await f.runtime.tick();
  assert.equal(f.runtime.status(f.owner.user.id, f.venue.venueId).receipts[0].status, 'unmatched');
  assert.ok(f.store.sql.prepare('SELECT done_at FROM pos_jobs').get().done_at);
  assert.equal(f.runtime.bind(f.owner.user.id, { connectionId: f.id, externalId: orderId, guestCode: f.guest.guestCode }).earned, 50);
  f.hook(); await f.runtime.tick();
  assert.equal(f.balance(), 50); assert.equal(f.store.read().visits.length, 1); assert.equal(f.store.read().visits[0].bill, 1000);
});

test('POS newer webhook generation remains queued when an older HTTP request completes', async t => {
  const f = fixture(t); f.save(); await f.activate(); f.hook();
  f.flags.gate = deferred(); f.flags.reached = deferred(); const pending = f.runtime.tick();
  await f.flags.reached.promise; f.hook(); f.flags.gate.resolve(); await pending;
  const job = f.store.sql.prepare('SELECT generation,done_at FROM pos_jobs').get(); assert.equal(job.generation, 2); assert.equal(job.done_at, null);
  f.flags.gate = null; await f.runtime.tick(); assert.ok(f.store.sql.prepare('SELECT done_at FROM pos_jobs').get().done_at);
  f.runtime.bind(f.owner.user.id, { connectionId: f.id, externalId: orderId, guestCode: f.guest.guestCode });
  assert.equal(f.balance(), 50); assert.equal(f.store.read().visits.length, 1);
});

test('POS pause or credential rotation while fetching prevents stale receipt import and requires fresh verification', async t => {
  for (const action of ['pause', 'rotate']) {
    const f = fixture(t); f.save(); await f.activate(); f.hook();
    f.flags.gate = deferred(); f.flags.reached = deferred(); const pending = f.runtime.tick();
    await f.flags.reached.promise;
    if (action === 'pause') f.runtime.setEnabled(f.owner.user.id, f.id, false);
    else f.save({ clientSecret: 'new-sensitive-client-secret' });
    f.flags.gate.resolve(); await pending;
    assert.equal(f.balance(), 0); assert.equal(f.store.read().visits.length, 0); assert.equal(f.runtime.status(f.owner.user.id, f.venue.venueId).receipts.length, 0);
    assert.equal(f.store.sql.prepare('SELECT done_at FROM pos_jobs').get().done_at, null);
    if (action === 'rotate') assert.throws(() => f.runtime.setEnabled(f.owner.user.id, f.id, true), statusError(409));
  }
});

test('POS r_keeper ignores historical returns without pausing current paid check imports', async t => {
  const f = fixture(t);
  const oldReturn = '77777777-7777-4777-8777-777777777777';
  const row = { orderGuid: orderId, sum: 1000, unpaid: 0, isFinished: true, isReturn: false, isReserve: false };
  f.flags.rkeeperRows = [row, { ...row, orderGuid: oldReturn, isReturn: true }];
  f.flags.rkeeperDates[oldReturn] = '2026-11-09T12:00:00Z';
  const { connectionId } = f.runtime.save(f.owner.user.id, { venueId: f.venue.venueId, provider: 'rkeeper',
    config: { objectId: 7, currency: 'RUB', token: 'test-rkeeper-secret', customerIdProperty: 'svoiCustomerId', closedAtProperty: 'svoiClosedAt' } });
  await f.runtime.probe(f.owner.user.id, connectionId); f.runtime.setEnabled(f.owner.user.id, connectionId, true); f.advance(60000); await f.runtime.tick();
  assert.equal(f.runtime.pos.getConnection(connectionId).enabled, true);
  const receipts = f.runtime.status(f.owner.user.id, f.venue.venueId).receipts;
  assert.equal(receipts.find(item => item.externalId === oldReturn).status, 'ignored'); assert.equal(receipts.find(item => item.externalId === orderId).status, 'unmatched');
  f.runtime.bind(f.owner.user.id, { connectionId, externalId: orderId, guestCode: f.guest.guestCode }); assert.equal(f.balance(), 50);
});

test('POS unresolved r_keeper return cannot be bypassed by probing again and enabling the connection', async t => {
  const f = fixture(t, { durable: true });
  f.flags.rkeeperRows = [{ orderGuid: orderId, sum: 1000, unpaid: 0, isFinished: true, isReturn: false, isReserve: false }];
  const { connectionId } = f.runtime.save(f.owner.user.id, { venueId: f.venue.venueId, provider: 'rkeeper',
    config: { objectId: 7, currency: 'RUB', token: 'test-rkeeper-secret', customerIdProperty: 'svoiCustomerId', closedAtProperty: 'svoiClosedAt' } });
  await f.runtime.probe(f.owner.user.id, connectionId); f.runtime.setEnabled(f.owner.user.id, connectionId, true);
  f.flags.rkeeperRows[0].isReturn = true; f.advance(60000); await f.runtime.tick();
  assert.equal(f.runtime.pos.getConnection(connectionId).enabled, false); assert.equal(f.runtime.pos.getConnection(connectionId).lastError, 'review_required');
  // The return may disappear from the vendor's current GetOrderList; our durable lock must remain.
  await f.restart(); f.flags.rkeeperRows = [];
  await assert.rejects(f.runtime.probe(f.owner.user.id, connectionId), statusError(409));
  f.runtime.save(f.owner.user.id, { venueId: f.venue.venueId, provider: 'rkeeper', config: { objectId: 7, currency: 'RUB', token: 'test-rkeeper-secret', customerIdProperty: 'svoiCustomerId', closedAtProperty: 'svoiClosedAt' } });
  assert.equal(f.runtime.held(connectionId), true);
  assert.throws(() => f.runtime.setEnabled(f.owner.user.id, connectionId, true), statusError(409)); assert.equal(f.balance(), 0);
});

test('retired POS HTTP endpoints and webhooks cannot create connections or ingest events', async t => {
  const app = createApplication({ dataPath: ':memory:', publicUrl: 'https://svoi.test', botToken: 'test-only', rateLimits: false });
  await new Promise(done => app.server.listen(0, '127.0.0.1', done)); t.after(() => app.close());
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const before = app.store.read();
  for (const path of ['status?venueId=unknown', 'configure', 'probe', 'enabled', 'bind', 'webhook-setup', `webhooks/iiko/${randomUUID()}`]) {
    for (const method of ['GET', 'POST']) {
      const response = await fetch(`${origin}/api/pos/${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: JSON.stringify({ config: {}, order: {} }) } : {}) });
      assert.equal(response.status, 410); assert.equal(response.headers.get('cache-control'), 'no-store');
    }
  }
  assert.equal(app.pos, undefined); assert.deepEqual(app.store.read(), before);
  assert.equal(app.store.sql.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='pos_jobs'").get().n, 0);
});
