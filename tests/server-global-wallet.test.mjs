import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, ApiError } from '../server/database.mjs';
import { PosStore } from '../server/pos/store.mjs';
import { defaultGuestProfile } from '../server/venue-profile.mjs';
import { creditGlobalPosCashback, globalBalances } from '../server/global-bonuses.mjs';

const now = Date.parse('2026-11-10T12:00:00Z');
const startedAt = '2026-11-10T00:00:00.000Z';
const policy = { enabled: true, cashbackPercent: 1, redemptionEnabled: false };
function fixture(t, durable = false) {
  const dir = durable ? mkdtempSync(join(tmpdir(), 'svoi-global-wallet-')) : null;
  const path = dir ? join(dir, 'test.sqlite') : ':memory:';
  let store = new Store(path, { clock: () => now, developerIds: [900000001] });
  let pos = new PosStore(store);
  const login = id => store.login({ id, firstName: `Тест ${id}`, lastName: '', username: null });
  const developer = login(900000001); const owner = login(1001); const guest = login(1002);
  const otherOwner = login(1003); const otherGuest = login(1004);
  const command = (user, type, fields = {}) => store.command(user.user.id, { idempotencyKey: randomUUID(), type, ...fields });
  const venue = command(developer, 'createVenue', { name: 'Первое кафе', kind: 'Кафе', address: 'Тест 1' }).result;
  const otherVenue = command(developer, 'createVenue', { name: 'Второе кафе', kind: 'Кафе', address: 'Тест 2' }).result;
  for (const [venueId, userId] of [[venue.venueId, owner.user.id], [otherVenue.venueId, otherOwner.user.id]]) store.sql.prepare("INSERT INTO staff(venue_id,user_id,role) VALUES (?,?,'owner')").run(venueId, userId);
  command(owner, 'addGuest', { venueId: venue.venueId, guestCode: guest.guestCode });
  command(otherOwner, 'addGuest', { venueId: otherVenue.venueId, guestCode: guest.guestCode });
  command(otherOwner, 'addGuest', { venueId: otherVenue.venueId, guestCode: otherGuest.guestCode });
  pos.configure({ id: 'one', venueId: venue.venueId, provider: 'iiko', scope: 'org-one', enabled: true, startedAt });
  pos.configure({ id: 'two', venueId: otherVenue.venueId, provider: 'rkeeper', scope: 'restaurant-two', enabled: true, startedAt });
  const receipt = (connection = 'one', fields = {}) => ({ provider: connection === 'one' ? 'iiko' : 'rkeeper', scope: connection === 'one' ? 'org-one' : 'restaurant-two',
    externalId: 'order-1', status: 'paid', billMinor: 100000, customerId: 'customer-1', closedAt: '2026-11-10T10:00:00.000Z', ...fields });
  const bind = (connection = 'one', externalId = 'order-1', customer = guest) => pos.bindCustomer((connection === 'one' ? owner : otherOwner).user.id, { connectionId: connection, externalId, guestCode: customer.guestCode });
  const earn = (connection = 'one', fields = {}, customer = guest) => { const item = receipt(connection, fields); pos.importReceipt(connection, item); return bind(connection, item.externalId, customer); };
  const wallet = (customer = guest) => store.snapshot(customer.user.id).globalWallet;
  const local = (venueId = venue.venueId, guestId = guest.guestId) => store.read().memberships.find(item => item.venueId === venueId && item.guestId === guestId).balance;
  t.after(() => { store.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });
  return { get store() { return store; }, get pos() { return pos; }, developer, owner, guest, otherOwner, otherGuest, venue, otherVenue, command, receipt, bind, earn, wallet, local,
    restart() { store.close(); store = new Store(path, { clock: () => now, developerIds: [900000001] }); pos = new PosStore(store); },
    profile(fields) { const p = defaultGuestProfile(); command(developer, 'updateVenueProfile', { venueId: venue.venueId, guestProfile: { ...p, ...fields, features: { ...p.features, ...fields.features } } }); } };
}
const throwsStatus = (fn, status) => assert.throws(fn, error => error instanceof ApiError && error.status === status);

test('legacy state has an enabled 1% global policy, zero leaves and no SQL migration', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const before = store.sql.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  const session = store.login({ id: 100, firstName: 'Гость', lastName: '', username: null });
  assert.equal(Object.hasOwn(store.read(), 'globalLedger'), false);
  assert.deepEqual(session.globalProgram, policy);
  assert.deepEqual(session.globalWallet, { unit: 'leaf', balance: 0, pendingReview: false, transactions: [] });
  assert.deepEqual(session.guestGlobalBalances, []);
  assert.deepEqual(store.sql.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all(), before);
  assert.equal(store.sql.prepare('PRAGMA user_version').get().user_version, 2);
});

test('iiko and r_keeper credits aggregate only global leaves; each local balance stays independent', t => {
  const f = fixture(t);
  assert.deepEqual(f.earn(), { guestId: f.guest.guestId, imported: 1, earned: 50 });
  f.earn('two', { billMinor: 299999 });
  assert.equal(f.wallet().balance, 39); // 10 + floor(2999.99 rubles * 1%).
  assert.equal(f.local(), 50);
  assert.equal(f.local(f.otherVenue.venueId), 149);
  assert.equal(f.store.read().globalLedger.length, 2);
  assert.deepEqual(new Set(f.store.read().globalLedger.map(item => item.provider)), new Set(['iiko', 'rkeeper']));
  assert.deepEqual(f.store.snapshot(f.guest.user.id).globalProgram, policy);
  // A private/unpublished live venue is still eligible; publication is not a payment gate.
  assert.equal(f.store.snapshot(f.guest.user.id).catalog.length, 0);
});

test('global 1% is independent of local cashback and rounds down per paid receipt', t => {
  const f = fixture(t);
  f.command(f.owner, 'updateProgram', { venueId: f.venue.venueId, program: { cashback: 0, everyVisits: 100, visitBonus: 0, tipsBonus: 0 } });
  f.earn('one', { billMinor: 9999 });
  assert.equal(f.wallet().balance, 0); assert.equal(f.wallet().transactions.length, 0);
  f.pos.importReceipt('one', f.receipt('one', { externalId: 'whole-leaf', billMinor: 10000 }));
  f.pos.importReceipt('one', f.receipt('one', { externalId: 'rounded-leaf', billMinor: 19999 }));
  assert.equal(f.wallet().balance, 2); assert.equal(f.local(), 0);
  assert.equal(f.store.read().transactions.length, 0);
});

test('QR, manual visits, local awards and local redemptions never credit or debit the global wallet', t => {
  const f = fixture(t); f.earn(); const before = f.wallet();
  f.command(f.owner, 'scanGuest', { venueId: f.venue.venueId, qr: f.guest.guestQr });
  f.command(f.owner, 'recordVisit', { venueId: f.venue.venueId, guestId: f.guest.guestId, bill: 5000, tips: 0, source: 'iiko', externalId: 'forged', globalCashback: 500 });
  f.command(f.owner, 'awardBonus', { venueId: f.venue.venueId, guestId: f.guest.guestId, amount: 100, reason: 'Локальный комплимент' });
  f.command(f.owner, 'redeemReward', { venueId: f.venue.venueId, guestId: f.guest.guestId, rewardId: 'coffee' });
  assert.deepEqual(f.wallet(), before);
  assert.equal(f.store.read().visits[0].source, undefined);
  assert.equal(f.local(), 250);
  const state = f.store.read();
  for (const user of [f.guest, f.owner, f.developer]) {
    for (const type of ['grantGlobalLeaves', 'redeemGlobalLeaves', 'updateGlobalProgram']) throwsStatus(() => f.command(user, type, { amount: 1000000, enabled: true, cashbackPercent: 30 }), 400);
  }
  assert.deepEqual(f.store.read(), state); // No path can spend or overdraw global leaves.
});

test('wallet history is own-only and staff receive only balances of guests in their current venues', t => {
  const f = fixture(t); f.earn(); f.earn('two', { billMinor: 200000 });
  f.earn('two', { externalId: 'other-order', customerId: 'other-customer', billMinor: 300000 }, f.otherGuest);
  const guest = f.store.snapshot(f.guest.user.id); const owner = f.store.snapshot(f.owner.user.id);
  assert.equal(guest.globalWallet.balance, 30); assert.equal(guest.globalWallet.transactions.length, 2);
  assert.deepEqual(guest.guestGlobalBalances, []);
  assert.deepEqual(owner.guestGlobalBalances, [{ venueId: f.venue.venueId, guestId: f.guest.guestId, balance: 30 }]);
  assert.equal(owner.globalWallet.transactions.length, 0);
  assert.equal(f.wallet(f.otherGuest).transactions.length, 1);
  for (const snapshot of [guest, owner, f.store.snapshot(f.otherGuest.user.id), f.store.snapshot(f.developer.user.id)]) {
    assert.equal(Object.hasOwn(snapshot.db, 'globalLedger'), false);
    for (const tx of snapshot.globalWallet.transactions) assert.deepEqual(Object.keys(tx).sort(), ['createdAt', 'delta', 'id', 'reason']);
  }
  assert.deepEqual(f.store.snapshot(f.developer.user.id).guestGlobalBalances, []);
  assert.deepEqual(f.store.snapshot(f.otherOwner.user.id).guestGlobalBalances.map(item => item.venueId), [f.otherVenue.venueId, f.otherVenue.venueId]);
  f.command(f.developer, 'revokeManager', { venueId: f.venue.venueId, userId: f.owner.user.id });
  assert.deepEqual(f.store.snapshot(f.owner.user.id).guestGlobalBalances, []);
});

test('durable paid-import replay and remapping retry preserve one global credit and old receipt fingerprint', t => {
  const f = fixture(t, true); f.earn();
  const before = f.wallet();
  const fingerprint = f.store.sql.prepare('SELECT credited_fingerprint FROM pos_orders WHERE connection_id=? AND external_id=?').get('one', 'order-1').credited_fingerprint;
  f.restart();
  assert.equal(f.pos.importReceipt('one', f.receipt()).duplicate, true);
  assert.deepEqual(f.bind(), { guestId: f.guest.guestId, imported: 0, earned: 0 });
  assert.deepEqual(f.pos.retryPending('one'), []);
  assert.deepEqual(f.wallet(), before); assert.equal(f.local(), 50); assert.equal(f.store.read().visits.length, 1);
  assert.equal(f.store.sql.prepare('SELECT credited_fingerprint FROM pos_orders WHERE connection_id=? AND external_id=?').get('one', 'order-1').credited_fingerprint, fingerprint);
  assert.equal(f.store.sql.prepare('PRAGMA user_version').get().user_version, 2);
});

test('legacy already-imported receipts are not retroactively credited to a new global ledger', t => {
  const f = fixture(t); f.earn();
  const legacy = f.store.read(); delete legacy.globalLedger; f.store.write(legacy);
  f.pos.importReceipt('one', f.receipt()); f.bind(); f.pos.retryPending('one');
  assert.equal(f.wallet().balance, 0); assert.equal(f.local(), 50);
  f.pos.importReceipt('one', f.receipt('one', { externalId: 'new-payment' }));
  assert.equal(f.wallet().balance, 10);
});

test('concurrent queued imports are serialized: duplicate jobs credit once and distinct payments do not lose leaves', async t => {
  const f = fixture(t); f.earn();
  const results = await Promise.all(Array.from({ length: 40 }, (_, index) => Promise.resolve().then(() =>
    f.pos.importReceipt('one', f.receipt('one', { externalId: index < 20 ? 'order-1' : `new-${index}` })))));
  assert.equal(results.filter(item => item.duplicate).length, 20);
  assert.equal(f.wallet().balance, 210); assert.equal(f.wallet().transactions.length, 21);
  assert.equal(new Set(f.store.read().globalLedger.map(item => item.externalId)).size, 21);
});

test('POS local credit, global ledger, visit and import receipt roll back atomically after persistence failure', t => {
  const f = fixture(t); f.earn(); const before = f.store.read(); const write = f.store.write;
  f.store.write = function (db) { write.call(this, db); throw new Error('test persistence interruption'); };
  assert.throws(() => f.pos.importReceipt('one', f.receipt('one', { externalId: 'retry' })), /test persistence interruption/);
  f.store.write = write;
  assert.deepEqual(f.store.read(), before);
  assert.equal(f.store.sql.prepare("SELECT COUNT(*) AS n FROM pos_orders WHERE external_id='retry'").get().n, 0);
  assert.equal(f.store.sql.prepare("SELECT COUNT(*) AS n FROM pos_audit WHERE external_id='retry'").get().n, 0);
  f.pos.importReceipt('one', f.receipt('one', { externalId: 'retry' }));
  f.pos.importReceipt('one', f.receipt('one', { externalId: 'retry' }));
  assert.equal(f.wallet().balance, 20); assert.equal(f.local(), 100); assert.equal(f.store.read().visits.length, 2);
});

test('changed or refunded paid checks hold the wallet for reconciliation without fabricating reversal', t => {
  const f = fixture(t, true); f.earn();
  const entries = f.wallet().transactions;
  assert.equal(f.pos.importReceipt('one', f.receipt('one', { billMinor: 90000 })).status, 'review');
  assert.equal(f.pos.importReceipt('one', f.receipt('one', { status: 'refund', billMinor: 0 })).status, 'review');
  assert.equal(f.pos.importReceipt('one', f.receipt('one', { externalId: 'held-payment' })).status, 'held');
  assert.equal(f.wallet().balance, 10); assert.equal(f.wallet().pendingReview, true);
  assert.deepEqual(f.wallet().transactions, entries); assert.equal(f.wallet(f.otherGuest).pendingReview, false);
  f.restart(); assert.equal(f.wallet().pendingReview, true); assert.equal(f.wallet().balance, 10);
  assert.deepEqual(f.store.snapshot(f.owner.user.id).guestGlobalBalances, [{ venueId: f.venue.venueId, guestId: f.guest.guestId, balance: 10 }]);
});

test('open, historic, unmatched, refund-first, held and disabled POS receipts do not create global leaves', t => {
  const f = fixture(t);
  assert.equal(f.pos.importReceipt('one', f.receipt('one', { externalId: 'open', status: 'open', billMinor: null, closedAt: null })).status, 'open');
  assert.equal(f.pos.importReceipt('one', f.receipt('one', { externalId: 'historic', closedAt: '2026-11-09T23:00:00Z' })).status, 'ignored');
  assert.equal(f.pos.importReceipt('one', f.receipt()).status, 'unmatched');
  assert.equal(f.pos.importReceipt('one', f.receipt('one', { externalId: 'refund', status: 'refund', billMinor: 0 })).status, 'review');
  assert.equal(f.bind().imported, 0); assert.equal(f.wallet().pendingReview, true);
  assert.equal(f.pos.importReceipt('one', f.receipt()).status, 'held');
  f.pos.configure({ id: 'one', venueId: f.venue.venueId, provider: 'iiko', scope: 'org-one', enabled: false });
  throwsStatus(() => f.pos.importReceipt('one', f.receipt()), 409);
  assert.equal(f.wallet().balance, 0); assert.equal(f.wallet().transactions.length, 0); assert.equal(f.local(), 0);
});

test('demo cards cannot mint global leaves; local loyalty being off does not disable the independent global program', t => {
  const f = fixture(t);
  f.profile({ demo: true }); f.earn();
  assert.equal(f.wallet().balance, 0);
  f.profile({ demo: false, features: { loyalty: false } });
  const localBefore = f.local();
  f.pos.importReceipt('one', f.receipt('one', { externalId: 'loyalty-off' }));
  assert.equal(f.wallet().balance, 10); assert.equal(f.local(), localBefore);
  f.profile({ demo: false });
  f.pos.importReceipt('one', f.receipt()); f.pos.importReceipt('one', f.receipt('one', { externalId: 'loyalty-off' }));
  assert.equal(f.wallet().balance, 10);
  f.pos.importReceipt('one', f.receipt('one', { externalId: 'live-payment' }));
  assert.equal(f.wallet().balance, 20);
  f.profile({ features: { visits: false } }); const before = f.store.read();
  assert.throws(() => f.pos.importReceipt('one', f.receipt('one', { externalId: 'visits-off' })), /Учёт визитов/);
  assert.deepEqual(f.store.read(), before);
  assert.equal(f.store.sql.prepare("SELECT COUNT(*) AS n FROM pos_orders WHERE external_id='visits-off'").get().n, 0);
});

test('global journal rejects malformed amounts, duplicate source reassignment, negative entries and overflow', t => {
  const f = fixture(t); f.earn(); const db = f.store.read(); const entry = db.globalLedger[0];
  const input = { ...entry, id: randomUUID() }; delete input.delta;
  assert.equal(creditGlobalPosCashback(db, input), db);
  for (const fields of [{ guestId: f.otherGuest.guestId, venueId: f.otherVenue.venueId }, { billMinor: 120000 }, { provider: 'rkeeper' }, { createdAt: '2026-11-10T11:00:00Z' }]) {
    assert.throws(() => creditGlobalPosCashback(db, { ...input, ...fields }), /сверки/);
  }
  for (const billMinor of [-1, 0, 1.5, 100000001, Infinity, '10000']) assert.throws(() => creditGlobalPosCashback(db, { ...input, externalId: 'invalid', billMinor }), /Некорректный оплаченный чек/);
  assert.throws(() => globalBalances({ ...db, globalLedger: [{ ...entry, delta: -10 }] }), /Некорректная запись/);
  assert.throws(() => creditGlobalPosCashback({ ...db, globalLedger: [{ ...entry, delta: Number.MAX_SAFE_INTEGER }] }, { ...input, externalId: 'overflow' }), /допустимый баланс/);
  assert.equal(f.wallet().balance, 10);
});
