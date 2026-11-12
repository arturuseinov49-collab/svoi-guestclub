import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, ApiError } from '../server/database.mjs';
import { PosStore } from '../server/pos/store.mjs';

function fixture(t, { durable = false, configured = true } = {}) {
  const dir = durable ? mkdtempSync(join(tmpdir(), 'svoi-service-')) : null;
  const file = dir ? join(dir, 'test.sqlite') : ':memory:';
  let now = Date.parse('2026-11-10T10:00:00Z');
  let store = new Store(file, { clock: () => now, developerIds: [900000001] }); let pos = new PosStore(store);
  const login = id => store.login({ id, firstName: `Тест ${id}`, lastName: '', username: null });
  const developer = login(900000001); const owner = login(1); const staff = login(2); const colleague = login(3);
  const guest = login(4); const otherGuest = login(5); const foreign = login(6);
  const command = (user, type, fields = {}, idempotencyKey = randomUUID()) => store.command(user.user.id, { type, idempotencyKey, ...fields });
  const venueId = command(developer, 'createVenue', { name: 'Сервис кафе', kind: 'Кафе', address: 'Тест 1' }).result.venueId;
  const foreignVenueId = command(developer, 'createVenue', { name: 'Другое кафе', kind: 'Кафе', address: 'Тест 2' }).result.venueId;
  for (const [venue, user, role] of [[venueId, owner, 'owner'], [venueId, staff, 'staff'], [venueId, colleague, 'staff'], [foreignVenueId, foreign, 'owner']]) store.sql.prepare('INSERT INTO staff(venue_id,user_id,role) VALUES (?,?,?)').run(venue, user.user.id, role);
  for (const customer of [guest, otherGuest]) command(staff, 'addGuest', { venueId, guestCode: customer.guestCode });
  pos.configure({ id: 'one', venueId, provider: 'iiko', scope: 'org-one', enabled: true, startedAt: '2026-11-10T00:00:00Z' });
  pos.configure({ id: 'two', venueId: foreignVenueId, provider: 'rkeeper', scope: 'foreign', enabled: true, startedAt: '2026-11-10T00:00:00Z' });
  const mapping = { venueId, connectionId: 'one', tables: [{ label: '01', posTableId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, { label: '2', posTableId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }], staff: [{ userId: staff.user.id, posWaiterId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }, { userId: colleague.user.id, posWaiterId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }] };
  if (configured) command(owner, 'configureServiceMapping', mapping);
  const start = (fields = {}, user = staff, idempotencyKey) => command(user, 'startService', { venueId, guestId: guest.guestId, tableLabel: '01', note: 'Internal staff note', ...fields }, idempotencyKey);
  const receipt = (fields = {}) => ({ provider: 'iiko', scope: 'org-one', externalId: 'order-a', status: 'open', billMinor: 120000, customerId: null, closedAt: null,
    service: { tableIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'], waiterId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', openedAt: '2026-11-10T10:00:01.000Z', items: [{ name: 'Тако', quantity: 2, sumMinor: 120000 }], comment: 'Internal kitchen note' }, ...fields });
  const snapshot = (user = guest) => store.snapshot(user.user.id);
  t.after(() => { store.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });
  return { get store() { return store; }, get pos() { return pos; }, owner, staff, colleague, guest, otherGuest, foreign, developer, venueId, foreignVenueId, mapping, command, start, receipt, snapshot,
    advance(ms) { now += ms; }, restart() { store.close(); store = new Store(file, { clock: () => now, developerIds: [900000001] }); pos = new PosStore(store); } };
}
const status = (fn, code) => assert.throws(fn, error => error instanceof ApiError && error.status === code);
const service = (f, user = f.guest) => f.snapshot(user).serviceSessions[0];
const paid = (f, fields = {}) => f.receipt({ status: 'paid', closedAt: '2026-11-10T10:00:02.000Z', ...fields });

test('start without POS mapping persists an honest waiting session, no visit or bonus; QR and retries do not duplicate it', t => {
  const f = fixture(t, { configured: false }); const key = randomUUID();
  const first = f.start({}, f.staff, key); const second = f.start({}, f.staff, key);
  assert.equal(second.replayed, true); assert.equal(first.result.sessionId, second.result.sessionId);
  assert.equal(service(f).status, 'awaiting_setup'); assert.equal(service(f).tableLabel, '01');
  assert.equal(f.snapshot().serviceReadiness.length, 0); assert.deepEqual(f.snapshot().serviceMappings, []);
  assert.equal(f.snapshot().db.visits.length, 0); assert.equal(f.snapshot().globalWallet.balance, 0);
  f.command(f.staff, 'scanGuest', { venueId: f.venueId, qr: f.guest.guestQr });
  assert.equal(f.store.read().serviceSessions.length, 1); assert.equal(f.store.read().transactions.length, 0);
  status(() => f.start({}, f.staff), 409);
  status(() => f.start({ guestId: f.otherGuest.guestId }), 409);
  status(() => f.start({ tableLabel: '2' }), 409);
  f.command(f.staff, 'cancelService', { venueId: f.venueId, sessionId: first.result.sessionId });
  assert.equal(service(f).status, 'cancelled');
  f.start(); assert.equal(f.store.read().serviceSessions.length, 2);
  assert.equal(f.store.sql.prepare('PRAGMA user_version').get().user_version, 2);
});

test('service command authorization, manager mappings and replay rights fail closed after revocation', t => {
  const f = fixture(t); const key = randomUUID(); const started = f.start({}, f.staff, key);
  for (const user of [f.guest, f.developer, f.foreign]) status(() => f.start({}, user), 403);
  status(() => f.command(f.colleague, 'cancelService', { venueId: f.venueId, sessionId: started.result.sessionId }), 403);
  status(() => f.command(f.owner, 'cancelService', { venueId: f.foreignVenueId, sessionId: started.result.sessionId }), 403);
  for (const user of [f.staff, f.guest, f.developer, f.foreign]) status(() => f.command(user, 'configureServiceMapping', f.mapping), 403);
  status(() => f.command(f.owner, 'configureServiceMapping', { ...f.mapping, connectionId: 'two' }), 404);
  status(() => f.command(f.owner, 'configureServiceMapping', { ...f.mapping, tables: [{ label: '01', posTableId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }, { label: '2', posTableId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }] }), 409);
  status(() => f.command(f.owner, 'configureServiceMapping', { ...f.mapping, staff: [{ userId: f.foreign.user.id, posWaiterId: 'foreign' }] }), 400);
  assert.equal(service(f, f.staff).staffUserId, f.staff.user.id);
  assert.equal(f.snapshot(f.colleague).serviceSessions.length, 1);
  assert.equal(service(f, f.colleague).staffUserId, f.staff.user.id);
  assert.equal(service(f, f.colleague).note, undefined); assert.equal(service(f, f.colleague).canCancel, false);
  assert.equal(f.snapshot(f.owner).serviceSessions.length, 1);
  assert.equal(f.snapshot(f.developer).serviceSessions.length, 0);
  assert.deepEqual(f.snapshot(f.staff).serviceMappings, []);
  assert.deepEqual(f.snapshot(f.staff).serviceReadiness, [{ venueId: f.venueId, ready: true, staffMapped: true, tableLabels: ['01', '2'] }]);
  f.command(f.owner, 'revokeStaff', { venueId: f.venueId, userId: f.staff.user.id });
  status(() => f.start({}, f.staff, key), 403);
  assert.equal(f.snapshot(f.staff).serviceSessions.length, 0);
  f.pos.importReceipt('one', paid(f));
  assert.equal(service(f).status, 'awaiting_setup'); assert.equal(f.store.read().visits.length, 0);
});

test('unique trusted table/waiter/time attaches open order; paid import credits once and metadata changes preserve financial fingerprint', t => {
  const f = fixture(t); const started = f.start({ staffUserId: f.colleague.user.id, externalId: 'forged' });
  assert.equal(f.pos.importReceipt('one', f.receipt()).status, 'open');
  const guest = service(f); assert.equal(guest.status, 'linked'); assert.equal(guest.order.billMinor, 120000);
  assert.deepEqual(guest.order.items, [{ name: 'Тако', quantity: 2, sumMinor: 120000 }]);
  for (const hidden of ['staffUserId', 'note', 'context', 'externalId', 'candidateIds']) assert.equal(Object.hasOwn(guest, hidden), false);
  assert.equal(Object.hasOwn(guest.order, 'comment'), false);
  assert.equal(service(f, f.staff).note, 'Internal staff note'); assert.equal(service(f, f.staff).order.comment, 'Internal kitchen note');
  assert.deepEqual(service(f, f.colleague).order.items, guest.order.items);
  assert.equal(service(f, f.colleague).order.billMinor, 120000);
  assert.equal(service(f, f.colleague).order.comment, undefined); assert.equal(service(f, f.colleague).note, undefined);
  assert.equal(service(f, f.colleague).canCancel, false);
  assert.equal(f.snapshot(f.otherGuest).serviceSessions.length, 0);
  for (const hidden of ['serviceSessions', 'serviceMappings', 'orderDetails']) assert.equal(Object.hasOwn(f.snapshot().db, hidden), false);
  status(() => f.command(f.staff, 'cancelService', { venueId: f.venueId, sessionId: started.result.sessionId }), 409);
  const changed = paid(f, { billMinor: 150000, service: { ...f.receipt().service, tableIds: ['moved-table'], waiterId: 'replacement-waiter' } });
  assert.equal(f.pos.importReceipt('one', changed).earned, 75);
  assert.equal(service(f).status, 'closed'); assert.equal(f.snapshot().globalWallet.balance, 15);
  assert.equal(Object.hasOwn(f.snapshot().db.visits[0], 'externalId'), false);
  assert.equal(f.snapshot(f.staff).db.visits[0].externalId, 'org-one:order-a');
  const fingerprint = f.store.sql.prepare('SELECT credited_fingerprint FROM pos_orders').get().credited_fingerprint;
  const again = { ...changed, service: { ...changed.service, items: [{ name: 'Обновлённое название', quantity: 1, sumMinor: null }], comment: 'Changed private note' } };
  assert.equal(f.pos.importReceipt('one', again).duplicate, true);
  assert.equal(f.store.sql.prepare('SELECT credited_fingerprint FROM pos_orders').get().credited_fingerprint, fingerprint);
  assert.equal(f.store.read().visits.length, 1); assert.equal(f.store.read().globalLedger.length, 1);
  assert.equal(f.snapshot().globalWallet.pendingReview, false);
  assert.equal(service(f).order.items[0].name, 'Обновлённое название');
  f.pos.importReceipt('one', { ...changed, status: 'refund', billMinor: 0 });
  assert.equal(service(f).status, 'review'); assert.equal(service(f).order, undefined);
  assert.equal(f.snapshot().globalWallet.balance, 15); assert.equal(f.snapshot().globalWallet.pendingReview, true);
});

test('all metadata in a batch is considered before credit; ambiguous orders require manager selection of an existing suitable candidate', t => {
  const f = fixture(t); const started = f.start();
  const outcomes = f.pos.importBatch('one', [paid(f), paid(f, { externalId: 'order-b' })]);
  assert.deepEqual(outcomes.map(item => item.status), ['service_review', 'service_review']);
  assert.equal(service(f).status, 'review'); assert.equal(service(f).order, undefined); assert.equal(service(f).candidates, undefined);
  assert.equal(service(f, f.staff).candidates, undefined); assert.equal(service(f, f.owner).candidates.length, 2);
  assert.equal(f.store.read().visits.length, 0); assert.equal(f.snapshot().globalWallet.balance, 0);
  const payload = { venueId: f.venueId, sessionId: started.result.sessionId, externalId: 'order-a' };
  status(() => f.command(f.staff, 'resolveServiceOrder', payload), 403);
  status(() => f.command(f.owner, 'resolveServiceOrder', { ...payload, externalId: 'fabricated' }), 409);
  const key = randomUUID(); f.command(f.owner, 'resolveServiceOrder', payload, key);
  assert.equal(service(f).status, 'closed'); assert.equal(f.store.read().visits.length, 1); assert.equal(f.snapshot().globalWallet.balance, 12);
  f.command(f.owner, 'resolveServiceOrder', payload, key); assert.equal(f.store.read().visits.length, 1);
  assert.equal(f.pos.importReceipt('one', paid(f, { externalId: 'order-b' })).status, 'unmatched');
  assert.equal(f.store.read().visits.length, 1); // Releasing an unchosen ambiguity never awards it.
  f.command(f.developer, 'revokeManager', { venueId: f.venueId, userId: f.owner.user.id });
  status(() => f.command(f.owner, 'resolveServiceOrder', payload, key), 403);
});

test('one order covering two active tables cannot be attached to two guests', t => {
  const f = fixture(t); const a = f.start().result.sessionId;
  const b = f.start({ guestId: f.otherGuest.guestId, tableLabel: '2' }).result.sessionId;
  const receipt = paid(f, { service: { ...f.receipt().service, tableIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'] } });
  f.pos.importReceipt('one', receipt);
  assert.deepEqual(f.snapshot(f.owner).serviceSessions.map(item => item.status), ['review', 'review']);
  status(() => f.command(f.owner, 'resolveServiceOrder', { venueId: f.venueId, sessionId: a, externalId: 'order-a' }), 409);
  f.command(f.staff, 'cancelService', { venueId: f.venueId, sessionId: b });
  f.command(f.owner, 'resolveServiceOrder', { venueId: f.venueId, sessionId: a, externalId: 'order-a' });
  assert.equal(f.snapshot().globalWallet.balance, 12); assert.equal(f.snapshot(f.otherGuest).globalWallet.balance, 0);
  f.start({ guestId: f.otherGuest.guestId });
  f.pos.importReceipt('one', receipt);
  assert.equal(f.store.read().visits.length, 1); assert.equal(f.snapshot(f.otherGuest).serviceSessions.at(-1).order, undefined);
});

test('missing, old, wrong-table, wrong-waiter or foreign-connection metadata never guesses a guest', t => {
  const f = fixture(t); f.start(); const valid = f.receipt().service;
  const cases = [null, { ...valid, tableIds: ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'] }, { ...valid, waiterId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }, { ...valid, waiterId: null },
    { ...valid, openedAt: null }, { ...valid, openedAt: '2026-11-10T09:59:59.000Z' }];
  for (let index = 0; index < cases.length; index++) f.pos.importReceipt('one', paid(f, { externalId: `no-match-${index}`, service: cases[index] }));
  f.pos.importReceipt('two', { ...paid(f), provider: 'rkeeper', scope: 'foreign' });
  assert.equal(service(f).status, 'review'); assert.equal(service(f).order, undefined); assert.equal(f.store.read().visits.length, 0);
  assert.deepEqual(service(f, f.owner).candidates, []);
  assert.equal(f.snapshot().globalWallet.balance, 0);
});

test('six-hour waiting expiry releases collision but never binds a late or historic check', t => {
  const f = fixture(t); f.start(); f.advance(6 * 60 * 60 * 1000);
  assert.equal(service(f).status, 'expired');
  f.pos.importReceipt('one', paid(f)); assert.equal(f.store.read().visits.length, 0);
  f.start(); assert.equal(f.snapshot().serviceSessions.at(-1).status, 'awaiting_order');
  f.pos.importReceipt('one', paid(f)); assert.equal(f.store.read().visits.length, 0);
});

test('mapping can enable a waiting session; changing an existing mapping cannot reinterpret its captured assignment', t => {
  const f = fixture(t, { configured: false }); f.start();
  f.command(f.owner, 'configureServiceMapping', f.mapping); assert.equal(service(f).status, 'awaiting_order');
  f.command(f.owner, 'configureServiceMapping', { ...f.mapping, staff: [{ userId: f.staff.user.id, posWaiterId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }] });
  f.pos.importReceipt('one', paid(f, { service: { ...f.receipt().service, waiterId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' } }));
  assert.equal(service(f).status, 'awaiting_setup'); assert.equal(f.store.read().visits.length, 0);
});

test('a POS customer link conflicting with the selected service guest requires review and holds both wallets', t => {
  const f = fixture(t);
  f.pos.importReceipt('one', f.receipt({ externalId: 'mapping-only', customerId: 'customer-b', service: null }));
  f.pos.bindCustomer(f.owner.user.id, { connectionId: 'one', externalId: 'mapping-only', guestCode: f.otherGuest.guestCode });
  f.start();
  assert.equal(f.pos.importReceipt('one', paid(f, { customerId: 'customer-b' })).status, 'review');
  assert.equal(service(f).status, 'review'); assert.equal(service(f).order, undefined);
  assert.equal(f.store.read().visits.length, 0);
  assert.equal(f.snapshot().globalWallet.pendingReview, true); assert.equal(f.snapshot(f.otherGuest).globalWallet.pendingReview, true);
  assert.equal(f.snapshot().globalWallet.balance, 0); assert.equal(f.snapshot(f.otherGuest).globalWallet.balance, 0);
});

test('later customer-link conflict is detected even for an already linked open table order', t => {
  const f = fixture(t); f.start(); f.pos.importReceipt('one', f.receipt({ customerId: 'customer-later' }));
  f.pos.bindCustomer(f.owner.user.id, { connectionId: 'one', externalId: 'order-a', guestCode: f.otherGuest.guestCode });
  assert.equal(service(f).status, 'review'); assert.equal(f.snapshot().globalWallet.pendingReview, true);
  assert.equal(f.pos.importReceipt('one', paid(f, { customerId: 'customer-later' })).status, 'review'); assert.equal(f.store.read().visits.length, 0);
});

test('service, order metadata and paid credits persist and replay exactly once after restart', t => {
  const f = fixture(t, { durable: true }); const key = randomUUID(); const sessionId = f.start({}, f.staff, key).result.sessionId;
  f.pos.importReceipt('one', f.receipt()); f.restart();
  assert.equal(service(f).id, sessionId); assert.equal(service(f).status, 'linked');
  assert.equal(f.start({}, f.staff, key).result.sessionId, sessionId);
  f.pos.importReceipt('one', paid(f)); f.restart(); f.pos.importReceipt('one', paid(f));
  assert.equal(service(f).status, 'closed'); assert.equal(f.snapshot().globalWallet.balance, 12); assert.equal(f.store.read().visits.length, 1);
  assert.equal(f.store.read().globalLedger.length, 1); assert.equal(f.store.sql.prepare('PRAGMA user_version').get().user_version, 2);
});

test('metadata, session linking, local/global credit and POS receipt commit together or all roll back', t => {
  const f = fixture(t); f.start(); const before = f.store.read(); const write = f.store.write; let writes = 0;
  f.store.write = function (db) { write.call(this, db); if (++writes === 2) throw new Error('test interrupted financial write'); };
  assert.throws(() => f.pos.importReceipt('one', paid(f)), /test interrupted financial write/);
  f.store.write = write; assert.deepEqual(f.store.read(), before);
  assert.equal(f.store.sql.prepare('SELECT COUNT(*) AS n FROM pos_orders').get().n, 0);
  f.pos.importReceipt('one', paid(f)); assert.equal(service(f).status, 'closed'); assert.equal(f.snapshot().globalWallet.balance, 12);
});

test('malformed service metadata or duplicate batch IDs fail atomically without changing financial state', t => {
  const f = fixture(t); f.start(); const before = f.store.read(); const valid = f.receipt().service;
  for (const metadata of [{ ...valid, openedAt: '2026-02-31T10:00:00Z' }, { ...valid, openedAt: '2026-11-10 10:00:00' },
    { ...valid, tableIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] }, { ...valid, items: [{ name: 'Тако', quantity: -1, sumMinor: 1000 }] },
    { ...valid, items: [{ name: 'Тако', quantity: 1, sumMinor: -1 }] }]) status(() => f.pos.importReceipt('one', paid(f, { service: metadata })), 400);
  status(() => f.pos.importBatch('one', [paid(f), paid(f)]), 409);
  assert.deepEqual(f.store.read(), before); assert.equal(f.store.sql.prepare('SELECT COUNT(*) AS n FROM pos_orders').get().n, 0);
});

test('poll targets follow waiting tables then sticky order IDs, expire waiting at 6h and stop open polling at 24h', t => {
  const f = fixture(t); f.start();
  assert.deepEqual(f.pos.servicePollTargets('one'), { tableIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'], orderIds: [], since: '2026-11-10T10:00:00.000Z' });
  assert.deepEqual(f.pos.servicePollTargets('two'), { tableIds: [], orderIds: [], since: null });
  f.pos.importReceipt('one', f.receipt());
  assert.deepEqual(f.pos.servicePollTargets('one'), { tableIds: [], orderIds: ['order-a'], since: null });
  f.advance(7 * 60 * 60 * 1000);
  assert.deepEqual(f.pos.servicePollTargets('one').orderIds, ['order-a']);
  f.advance(17 * 60 * 60 * 1000);
  assert.deepEqual(f.pos.servicePollTargets('one'), { tableIds: [], orderIds: [], since: null });
  assert.equal(service(f).status, 'review'); assert.equal(service(f).order, undefined);
  f.pos.importReceipt('one', paid(f)); // A later verified payment still belongs to the same sticky order.
  assert.equal(service(f).status, 'closed'); assert.equal(f.snapshot().globalWallet.balance, 12);
});

test('incomplete table metadata cannot be manually guessed, but later complete metadata becomes a reviewable candidate', t => {
  const f = fixture(t); const started = f.start();
  f.pos.importReceipt('one', paid(f, { service: { ...f.receipt().service, waiterId: null } }));
  assert.equal(service(f).status, 'review'); assert.deepEqual(service(f, f.owner).candidates, []);
  status(() => f.command(f.owner, 'resolveServiceOrder', { venueId: f.venueId, sessionId: started.result.sessionId, externalId: 'order-a' }), 409);
  f.pos.importReceipt('one', paid(f));
  assert.equal(service(f).status, 'review'); assert.equal(service(f, f.owner).candidates.length, 1); assert.equal(f.store.read().visits.length, 0);
  f.command(f.owner, 'resolveServiceOrder', { venueId: f.venueId, sessionId: started.result.sessionId, externalId: 'order-a' });
  assert.equal(service(f).status, 'closed');
});

test('poll target overflow fails closed instead of truncating; disabled connection produces no targets', t => {
  const f = fixture(t); f.start(); f.pos.importReceipt('one', f.receipt());
  const db = f.store.read(); const original = db.serviceSessions[0];
  db.serviceSessions = Array.from({ length: 101 }, (_, index) => ({ ...original, id: randomUUID(), externalId: `overflow-${index}` }));
  f.store.write(db);
  status(() => f.pos.servicePollTargets('one'), 409);
  assert.deepEqual(f.store.read(), db);
  f.pos.configure({ id: 'one', venueId: f.venueId, provider: 'iiko', scope: 'org-one', enabled: false });
  assert.deepEqual(f.pos.servicePollTargets('one'), { tableIds: [], orderIds: [], since: null });
});

test('already credited POS orders cannot be retroactively assigned to a new service guest', t => {
  const f = fixture(t);
  f.pos.importReceipt('one', paid(f, { customerId: 'known-customer', service: null }));
  f.pos.bindCustomer(f.owner.user.id, { connectionId: 'one', externalId: 'order-a', guestCode: f.guest.guestCode });
  f.start({ guestId: f.otherGuest.guestId });
  assert.equal(f.pos.importReceipt('one', paid(f, { customerId: 'known-customer' })).duplicate, true);
  assert.equal(service(f, f.otherGuest).status, 'awaiting_order'); assert.equal(service(f, f.otherGuest).order, undefined);
  assert.equal(f.snapshot().globalWallet.balance, 12); assert.equal(f.snapshot(f.otherGuest).globalWallet.balance, 0);
  assert.equal(f.store.read().visits.length, 1);
});

test('concurrent starts cannot reserve the same guest or table twice', async t => {
  const f = fixture(t);
  const outcomes = await Promise.allSettled(Array.from({ length: 10 }, () => Promise.resolve().then(() => f.start())));
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(item => item.status === 'rejected' && item.reason.status === 409).length, 9);
  assert.equal(f.store.read().serviceSessions.length, 1); assert.equal(f.store.read().visits.length, 0);
});

test('a later refund or corrected old check in the same batch holds known guests before any new credit', t => {
  const f = fixture(t);
  f.pos.importReceipt('one', f.receipt({ externalId: 'customer-map', customerId: 'known', service: null }));
  f.pos.bindCustomer(f.owner.user.id, { connectionId: 'one', externalId: 'customer-map', guestCode: f.guest.guestCode });
  f.start();
  const results = f.pos.importBatch('one', [paid(f, { customerId: 'known' }), paid(f, { externalId: 'return-last', status: 'refund', billMinor: 0, customerId: 'known', service: null })]);
  assert.deepEqual(results.map(item => item.status), ['held', 'review']);
  assert.equal(f.store.read().visits.length, 0); assert.equal(f.snapshot().globalWallet.balance, 0);
  assert.equal(service(f).status, 'review'); assert.equal(f.snapshot().globalWallet.pendingReview, true);
});

test('provider mapping IDs are canonical and invalid POS IDs cannot look ready', t => {
  const f = fixture(t, { configured: false });
  const mapping = { ...f.mapping, tables: f.mapping.tables.map(item => ({ ...item, posTableId: item.posTableId.toUpperCase() })), staff: f.mapping.staff.map(item => ({ ...item, posWaiterId: item.posWaiterId.toUpperCase() })) };
  f.command(f.owner, 'configureServiceMapping', mapping);
  assert.deepEqual(f.snapshot(f.owner).serviceMappings[0], f.mapping);
  for (const posTableId of ['pos-table-01', '00000000-0000-0000-0000-000000000000', '123']) status(() => f.command(f.owner, 'configureServiceMapping', { ...mapping, tables: [{ label: '01', posTableId }] }), 400);
  f.command(f.foreign, 'configureServiceMapping', { venueId: f.foreignVenueId, connectionId: 'two', tables: [{ label: '01', posTableId: '0001' }], staff: [{ userId: f.foreign.user.id, posWaiterId: '00077' }] });
  assert.deepEqual(f.snapshot(f.foreign).serviceMappings[0].tables, [{ label: '01', posTableId: '1' }]);
  assert.deepEqual(f.snapshot(f.foreign).serviceMappings[0].staff, [{ userId: f.foreign.user.id, posWaiterId: '77' }]);
  status(() => f.command(f.foreign, 'configureServiceMapping', { venueId: f.foreignVenueId, connectionId: 'two', tables: [{ label: '01', posTableId: '-1' }], staff: [] }), 400);
});

test('previous-session guard allows a deliberate new service but rejects stale history; exact lost-response replay stays valid', t => {
  const f = fixture(t); const key = randomUUID();
  const first = f.start({ previousSessionId: null }, f.staff, key).result.sessionId;
  f.command(f.staff, 'cancelService', { venueId: f.venueId, sessionId: first });
  status(() => f.start({ previousSessionId: null }), 409);
  assert.equal(f.store.read().serviceSessions.length, 1);
  const second = f.start({ previousSessionId: first }).result.sessionId;
  assert.notEqual(second, first);
  assert.equal(f.start({ previousSessionId: null }, f.staff, key).result.sessionId, first);
  assert.equal(f.store.read().serviceSessions.length, 2);
  f.pos.importReceipt('one', paid(f));
  assert.equal(f.snapshot().serviceSessions.at(-1).status, 'closed');
  status(() => f.start({ previousSessionId: first }), 409);
  const third = f.start({ previousSessionId: second }).result.sessionId;
  assert.notEqual(third, second); assert.equal(f.store.read().serviceSessions.length, 3);
});

test('a paid receipt older than connection activation cannot attach even when its service timestamp matches', t => {
  const f = fixture(t); f.start();
  // Simulate a future activation cutoff already allowed by trusted POS configuration.
  f.store.sql.prepare("UPDATE pos_connections SET started_at=? WHERE id='one'").run('2026-11-10T10:00:03.000Z');
  assert.equal(f.pos.importReceipt('one', paid(f)).status, 'ignored');
  assert.equal(service(f).status, 'awaiting_order'); assert.equal(service(f).order, undefined); assert.equal(f.store.read().visits.length, 0);
});

test('cancelled ambiguous service is reconciled only by a manager selecting its original paid candidate', t => {
  const f = fixture(t); const sessionId = f.start().result.sessionId;
  f.pos.importBatch('one', [paid(f), paid(f, { externalId: 'order-b' })]);
  f.command(f.staff, 'cancelService', { venueId: f.venueId, sessionId });
  assert.equal(service(f).status, 'cancelled'); assert.equal(f.store.read().visits.length, 0);
  assert.equal(service(f, f.owner).candidates.length, 2); assert.equal(service(f, f.staff).candidates, undefined);
  const resolve = { venueId: f.venueId, sessionId, externalId: 'order-a' };
  status(() => f.command(f.staff, 'resolveServiceOrder', resolve), 403);
  status(() => f.command(f.owner, 'resolveServiceOrder', { ...resolve, externalId: 'never-seen' }), 409);
  f.command(f.owner, 'resolveServiceOrder', resolve);
  assert.equal(service(f).status, 'closed'); assert.equal(f.store.read().visits.length, 1); assert.equal(f.snapshot().globalWallet.balance, 12);
});

test('expired review can reconcile original paid order after staff/mapping changes, but never an open or active-conflicting service', t => {
  const f = fixture(t); const sessionId = f.start().result.sessionId;
  f.pos.importBatch('one', [paid(f), f.receipt({ externalId: 'still-open' })]);
  f.advance(6 * 60 * 60 * 1000);
  assert.equal(service(f).status, 'expired'); assert.equal(f.store.read().visits.length, 0);
  assert.deepEqual(service(f, f.owner).candidates.map(item => item.externalId), ['order-a']);
  const resolve = { venueId: f.venueId, sessionId, externalId: 'order-a' };
  status(() => f.command(f.owner, 'resolveServiceOrder', { ...resolve, externalId: 'still-open' }), 409);
  const other = f.start({ previousSessionId: sessionId }).result.sessionId;
  status(() => f.command(f.owner, 'resolveServiceOrder', resolve), 409);
  f.command(f.staff, 'cancelService', { venueId: f.venueId, sessionId: other });
  f.command(f.owner, 'revokeStaff', { venueId: f.venueId, userId: f.staff.user.id });
  f.command(f.owner, 'configureServiceMapping', { ...f.mapping, tables: [], staff: [] });
  f.command(f.owner, 'resolveServiceOrder', resolve);
  assert.equal(f.snapshot().serviceSessions.find(item => item.id === sessionId).status, 'closed');
  assert.equal(f.store.read().visits.length, 1); assert.equal(f.snapshot().globalWallet.balance, 12);
});

test('customer-link credit immediately marks metadata and SQL prevents stale metadata from linking another guest', t => {
  const f = fixture(t);
  f.pos.importReceipt('one', paid(f, { customerId: 'already-known' }));
  f.pos.bindCustomer(f.owner.user.id, { connectionId: 'one', externalId: 'order-a', guestCode: f.otherGuest.guestCode });
  assert.equal(f.store.read().orderDetails[0].previouslyCredited, true);
  const stale = f.store.read(); stale.orderDetails[0].previouslyCredited = false; f.store.write(stale);
  const sessionId = f.start().result.sessionId;
  f.pos.importReceipt('one', paid(f, { externalId: 'unrelated-refresh', service: null }));
  assert.equal(service(f).status, 'awaiting_order'); assert.equal(service(f).order, undefined);
  const review = f.store.read(); review.serviceSessions[0].status = 'review'; review.serviceSessions[0].candidateIds = ['order-a']; f.store.write(review);
  assert.deepEqual(service(f, f.owner).candidates, []);
  status(() => f.command(f.owner, 'resolveServiceOrder', { venueId: f.venueId, sessionId, externalId: 'order-a' }), 409);
  assert.equal(f.store.read().visits.length, 1); assert.equal(f.snapshot().globalWallet.balance, 0); assert.equal(f.snapshot(f.otherGuest).globalWallet.balance, 12);
});

test('unchosen candidate is not released while another cancelled original session still has a historical claim', t => {
  const f = fixture(t); const first = f.start().result.sessionId;
  const second = f.start({ guestId: f.otherGuest.guestId, tableLabel: '2' }).result.sessionId;
  f.pos.importBatch('one', [paid(f), paid(f, { externalId: 'shared-b', service: { ...f.receipt().service, tableIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'] } })]);
  f.command(f.staff, 'cancelService', { venueId: f.venueId, sessionId: second });
  f.command(f.owner, 'resolveServiceOrder', { venueId: f.venueId, sessionId: first, externalId: 'order-a' });
  assert.equal(f.store.sql.prepare("SELECT outcome FROM pos_orders WHERE external_id='shared-b'").get().outcome, 'service_review');
  assert.equal(f.snapshot(f.otherGuest).globalWallet.balance, 0);
  f.command(f.owner, 'resolveServiceOrder', { venueId: f.venueId, sessionId: second, externalId: 'shared-b' });
  assert.equal(f.snapshot(f.otherGuest).globalWallet.balance, 12); assert.equal(f.store.read().visits.length, 2);
});
