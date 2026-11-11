import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stats } from '../src/domain';
import { createSeed } from '../src/seed';
import { Provider, createFixture, normalizeFixture, processReceipt } from '../src/integrations/pos';
for (const provider of ['iiko', 'rkeeper'] as Provider[]) {
  const receipt = (scenario: 'closed' | 'open' | 'refund' | 'unmatched' = 'closed', venue = 'list') => normalizeFixture(createFixture(provider, venue, scenario, 'receipt-1001'), venue);
  test(`${provider}: paid receipt creates visit and points, no invented guest rating`, () => {
    const result = processReceipt(createSeed(), receipt());
    assert.equal(result.event.result, 'imported'); assert.equal(result.earned, provider === 'iiko' ? 115 : 120);
    assert.equal(result.db.visits[0].rating, null); assert.equal(result.db.visits[0].source, provider);
    assert.equal(result.db.visits[0].tipsKnown, provider === 'iiko');
  });
  test(`${provider}: replay remains idempotent after database serialization`, () => {
    const first = processReceipt(createSeed(), receipt());
    const second = processReceipt(JSON.parse(JSON.stringify(first.db)), receipt());
    assert.equal(second.event.result, 'duplicate');
    assert.deepEqual(second.db.memberships, first.db.memberships); assert.equal(second.db.visits.length, first.db.visits.length); assert.equal(second.db.transactions.length, first.db.transactions.length);
  });
  test(`${provider}: open and refund receipts never accrue`, () => {
    const db = createSeed();
    for (const scenario of ['open', 'refund'] as const) { const result = processReceipt(db, receipt(scenario)); assert.notEqual(result.event.result, 'imported'); assert.deepEqual(result.db.memberships, db.memberships); assert.equal(result.db.visits.length, db.visits.length); }
  });
  test(`${provider}: unknown guest needs explicit linking`, () => {
    const unknown = receipt('unmatched'); const first = processReceipt(createSeed(), unknown);
    assert.equal(first.event.result, 'unmatched');
    const linked = processReceipt(first.db, unknown, 'anna'); assert.equal(linked.event.result, 'imported'); assert.equal(linked.db.visits[0].guestId, 'anna');
    const replay = processReceipt(linked.db, unknown, 'alex'); assert.equal(replay.event.result, 'duplicate');
  });
  test(`${provider}: same receipt id is independent per venue`, () => {
    const a = processReceipt(createSeed(), receipt()); const b = processReceipt(a.db, receipt('closed', 'moss'));
    assert.equal(b.event.result, 'imported'); assert.equal(stats(b.db, 'list', 'alex').balance, stats(a.db, 'list', 'alex').balance);
  });
  test(`${provider}: rejects a receipt for a different linked venue`, () => {
    const wrong = { ...receipt(), venueId: 'moss' }; assert.throws(() => processReceipt(createSeed(), wrong), /заведения/);
  });
}
test('providers use separate receipt namespaces', () => {
  const db = createSeed(); const a = processReceipt(db, normalizeFixture(createFixture('iiko', 'list', 'closed', '1001'), 'list'));
  const b = processReceipt(a.db, normalizeFixture(createFixture('rkeeper', 'list', 'closed', '1001'), 'list'));
  assert.equal(b.event.result, 'imported');
});
