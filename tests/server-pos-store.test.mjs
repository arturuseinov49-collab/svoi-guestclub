import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, ApiError } from '../server/database.mjs';
import { PosStore } from '../server/pos/store.mjs';

const now = Date.parse('2026-11-10T12:00:00Z');
const startedAt = '2026-11-10T00:00:00.000Z';
function setup(t, durable = false) {
  const dir = durable ? mkdtempSync(join(tmpdir(), 'svoi-pos-store-')) : null;
  const file = dir ? join(dir, 'test.sqlite') : ':memory:';
  let store = new Store(file, { clock: () => now, developerIds: [900000001] }); let pos = new PosStore(store);
  const command = (user, type, fields = {}) => store.command(user.user.id, { idempotencyKey: randomUUID(), type, ...fields });
  const login = id => store.login({ id, firstName: `Гость ${id}`, lastName: '', username: null });
  const owner = login(1001); const guest = login(1002); const otherOwner = login(1003); const otherGuest = login(1004);
  const developer = login(900000001);
  const venue = command(developer, 'createVenue', { name: 'Первая касса', kind: 'Кафе', address: 'Адрес 1' }).result;
  const otherVenue = command(developer, 'createVenue', { name: 'Вторая касса', kind: 'Кафе', address: 'Адрес 2' }).result;
  for (const [venueId, userId] of [[venue.venueId, owner.user.id], [otherVenue.venueId, otherOwner.user.id]]) store.sql.prepare("INSERT INTO staff(venue_id,user_id,role) VALUES (?,?,'owner')").run(venueId, userId);
  command(owner, 'addGuest', { venueId: venue.venueId, guestCode: guest.guestCode });
  command(otherOwner, 'addGuest', { venueId: otherVenue.venueId, guestCode: otherGuest.guestCode });
  pos.configure({ id: 'one', venueId: venue.venueId, provider: 'iiko', scope: 'org-one', enabled: true, startedAt });
  t.after(() => { store.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });
  const receipt = (fields = {}) => ({ provider: 'iiko', scope: 'org-one', externalId: 'order-1', status: 'paid', billMinor: 100000, customerId: 'customer-1', closedAt: '2026-11-10T10:00:00.000Z', ...fields });
  const bind = (fields = {}) => pos.bindCustomer(owner.user.id, { connectionId: 'one', externalId: 'order-1', guestCode: guest.guestCode, ...fields });
  return { get store() { return store; }, get pos() { return pos; }, owner, guest, otherOwner, otherGuest, venue, otherVenue, command, receipt, bind,
    restart() { store.close(); store = new Store(file, { clock: () => now, developerIds: [900000001] }); pos = new PosStore(store); },
    balance() { return store.read().memberships.find(member => member.guestId === guest.guestId && member.venueId === venue.venueId).balance; } };
}
const throwsStatus = (fn, status) => assert.throws(fn, error => error instanceof ApiError && error.status === status);

test('POS pending receipt requires owner-confirmed registered member; replay survives restart without duplicate credit', t => {
  const f = setup(t, true);
  assert.equal(f.pos.importReceipt('one', f.receipt()).status, 'unmatched');
  assert.equal(f.balance(), 0);
  assert.deepEqual(f.bind(), { guestId: f.guest.guestId, imported: 1, earned: 50 });
  assert.equal(f.balance(), 50);
  const visit = f.store.read().visits[0];
  assert.equal(visit.tipsKnown, false); assert.equal(visit.rating, null); assert.equal(visit.source, 'iiko'); assert.equal(visit.createdAt, f.receipt().closedAt);
  f.pos.updateSync('one', { cursor: { since: 'cursor-one' }, lastError: null, lastSuccessAt: new Date(now).toISOString() });
  f.restart();
  assert.equal(f.pos.importReceipt('one', f.receipt()).duplicate, true);
  assert.equal(f.balance(), 50); assert.equal(f.store.read().visits.length, 1); assert.equal(f.store.read().transactions.length, 1);
  assert.deepEqual(f.pos.getConnection('one').cursor, { since: 'cursor-one' });
  assert.deepEqual(f.bind(), { guestId: f.guest.guestId, imported: 0, earned: 0 });
  assert.equal(f.store.sql.prepare("SELECT COUNT(*) AS n FROM pos_audit WHERE action='customer_linked'").get().n, 1);
});

test('POS permissions, provider scope uniqueness, immutable identity and disabled import are enforced', t => {
  const f = setup(t);
  f.pos.importReceipt('one', f.receipt());
  throwsStatus(() => f.pos.bindCustomer(f.guest.user.id, { connectionId: 'one', externalId: 'order-1', guestCode: f.guest.guestCode }), 403);
  throwsStatus(() => f.pos.bindCustomer(f.otherOwner.user.id, { connectionId: 'one', externalId: 'order-1', guestCode: f.guest.guestCode }), 403);
  throwsStatus(() => f.bind({ guestCode: f.otherGuest.guestCode }), 404);
  throwsStatus(() => f.pos.status(f.otherOwner.user.id, f.venue.venueId), 403);
  throwsStatus(() => f.pos.configure({ id: 'two', venueId: f.otherVenue.venueId, provider: 'iiko', scope: 'org-one', startedAt }), 409);
  throwsStatus(() => f.pos.configure({ id: 'one', venueId: f.otherVenue.venueId, provider: 'iiko', scope: 'org-one', startedAt }), 409);
  throwsStatus(() => f.pos.configure({ id: 'one', venueId: f.venue.venueId, provider: 'rkeeper', scope: 'org-one', startedAt }), 409);
  throwsStatus(() => f.pos.configure({ id: 'one', venueId: f.venue.venueId, provider: 'iiko', scope: 'org-one', startedAt: '2026-11-09T00:00:00Z' }), 409);
  throwsStatus(() => f.pos.importReceipt('one', f.receipt({ scope: 'org-other' })), 409);
  throwsStatus(() => f.pos.importReceipt('one', f.receipt({ provider: 'rkeeper' })), 409);
  f.pos.configure({ id: 'one', venueId: f.venue.venueId, provider: 'iiko', scope: 'org-one' });
  assert.equal(f.pos.getConnection('one').startedAt, startedAt);
  throwsStatus(() => f.pos.importReceipt('one', f.receipt()), 409); throwsStatus(() => f.bind(), 409);
  const state = f.pos.status(f.owner.user.id, f.venue.venueId);
  assert.equal(state.connections[0].enabled, false); assert.ok(!Object.hasOwn(state.connections[0], 'cursor'));
});

test('POS rejects malformed money and dates, preserves unknown guests and does not import historic or open checks', t => {
  const f = setup(t);
  for (const billMinor of [undefined, -1, 1.5, NaN, Infinity, 100000001, '100000']) throwsStatus(() => f.pos.importReceipt('one', f.receipt({ billMinor })), 400);
  for (const closedAt of [null, '', '2026-11-10 10:00:00', '2026-02-31T10:00:00Z', '2026-11-10T13:00:00Z']) throwsStatus(() => f.pos.importReceipt('one', f.receipt({ closedAt })), 400);
  throwsStatus(() => f.pos.importReceipt('one', f.receipt({ billMinor: 0 })), 400);
  throwsStatus(() => f.pos.importReceipt('one', f.receipt({ status: 'Closed' })), 400);
  assert.equal(f.pos.importReceipt('one', f.receipt({ externalId: 'open', status: 'open', billMinor: null, closedAt: null })).status, 'open');
  assert.equal(f.pos.importReceipt('one', f.receipt({ externalId: 'history', closedAt: '2026-11-09T23:59:59Z' })).status, 'ignored');
  assert.equal(f.pos.importReceipt('one', f.receipt({ externalId: 'old-refund', status: 'refund', closedAt: '2026-11-09T23:59:59Z' })).status, 'ignored');
  assert.equal(f.pos.importReceipt('one', f.receipt({ customerId: null })).status, 'unmatched');
  throwsStatus(() => f.bind(), 400);
  assert.equal(f.balance(), 0); assert.equal(f.store.read().visits.length, 0);
});

test('POS changed or refunded credited check stays in review and holds the guest across venue connectors', t => {
  const f = setup(t);
  f.pos.importReceipt('one', f.receipt()); f.bind();
  assert.equal(f.pos.importReceipt('one', f.receipt({ billMinor: 90000 })).status, 'review');
  assert.equal(f.pos.importReceipt('one', f.receipt()).status, 'review');
  assert.equal(f.pos.importReceipt('one', f.receipt({ status: 'refund', billMinor: 0 })).status, 'review');
  assert.equal(f.pos.importReceipt('one', f.receipt({ externalId: 'order-2' })).status, 'held');
  assert.equal(f.balance(), 50); assert.equal(f.store.read().visits.length, 1);
  f.pos.configure({ id: 'two', venueId: f.venue.venueId, provider: 'rkeeper', scope: 'restaurant-two', enabled: true, startedAt });
  const otherReceipt = f.receipt({ provider: 'rkeeper', scope: 'restaurant-two', externalId: 'r-order-1', customerId: 'r-customer' });
  f.pos.importReceipt('two', otherReceipt);
  assert.equal(f.pos.bindCustomer(f.owner.user.id, { connectionId: 'two', externalId: 'r-order-1', guestCode: f.guest.guestCode }).imported, 0);
  assert.equal(f.pos.status(f.owner.user.id, f.venue.venueId).heldGuests, 1); assert.equal(f.balance(), 50);
});

test('POS refunds before linking prevent pending bonus; changed binding and null customer mapping are rejected', t => {
  const f = setup(t);
  f.pos.importReceipt('one', f.receipt());
  f.pos.importReceipt('one', f.receipt({ externalId: 'refund-first', status: 'refund', billMinor: 0 }));
  assert.equal(f.bind().imported, 0); assert.equal(f.balance(), 0);
  assert.equal(f.pos.importReceipt('one', f.receipt()).status, 'held');
  f.command(f.owner, 'addGuest', { venueId: f.venue.venueId, guestCode: f.otherGuest.guestCode });
  throwsStatus(() => f.bind({ guestCode: f.otherGuest.guestCode }), 409);
  assert.equal(f.pos.status(f.owner.user.id, f.venue.venueId).heldGuests, 1);
});

test('POS receipt and bonus rollback together on failure; a retried transaction credits exactly once', t => {
  const f = setup(t);
  f.pos.importReceipt('one', f.receipt()); f.bind();
  const write = f.store.write;
  f.store.write = function (db) { write.call(this, db); throw new Error('injected persistence failure'); };
  assert.throws(() => f.pos.importReceipt('one', f.receipt({ externalId: 'order-2' })), /injected persistence failure/);
  f.store.write = write;
  assert.equal(f.balance(), 50); assert.equal(f.store.read().visits.length, 1);
  assert.equal(f.store.sql.prepare("SELECT COUNT(*) AS n FROM pos_orders WHERE external_id='order-2'").get().n, 0);
  assert.equal(f.pos.importReceipt('one', f.receipt({ externalId: 'order-2' })).earned, 50);
  assert.equal(f.balance(), 100); assert.equal(f.store.read().visits.length, 2);
});

test('POS sync state persists only bounded cursor and known error codes, status exposes bounded venue-only rows', t => {
  const f = setup(t);
  throwsStatus(() => f.pos.updateSync('one', { lastError: 'secret-vendor-token' }), 400);
  throwsStatus(() => f.pos.updateSync('one', { cursor: 'x'.repeat(9000) }), 400);
  f.pos.updateSync('one', { lastError: 'unauthorized' });
  for (let i = 0; i < 110; i++) f.pos.importReceipt('one', f.receipt({ externalId: `open-${i}`, status: 'open', billMinor: null, closedAt: null }));
  const state = f.pos.status(f.owner.user.id, f.venue.venueId);
  assert.equal(state.receipts.length, 100); assert.equal(state.connections[0].counts.open, 110); assert.equal(state.connections[0].lastError, 'unauthorized');
  assert.deepEqual(f.pos.status(f.otherOwner.user.id, f.otherVenue.venueId), { connections: [], receipts: [], heldGuests: 0 });
});
