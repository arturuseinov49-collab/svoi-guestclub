import test from 'node:test';
import assert from 'node:assert/strict';
import { createRkeeperClient, RKEEPER_REQUIREMENTS } from '../server/pos/rkeeper.mjs';

const objectId = 199990246;
const taskGuid = '03046fb4-7c57-4884-9d08-a05c24123273';
const orderGuid = 'd06a58d0-75c8-42f9-b836-e1afdffb53fa';
const now = Date.parse('2026-11-10T12:00:00Z');
const config = { token: 'test-only-never-valid', objectId, customerIdProperty: 'SvoiCustomerId', closedAtProperty: 'SvoiClosedAt' };
const row = extra => ({ orderGuid, sum: 408.5, unpaid: 0, isFinished: true, isReturn: false, isReserve: false, ...extra });
const detail = extra => ({ orderGuid, price: { total: 408.5, sumToPay: 0 }, extProperties: { SvoiCustomerId: 'customer-17', SvoiClosedAt: '2026-11-10T14:30:00+03:00' }, ...extra });
const envelope = (taskType, taskResponse, common = {}) => ({ responseCommon: { taskGuid, taskType, objectId, ...common }, ...(taskResponse === undefined ? {} : { taskResponse }) });
function fixture({ rows = [row()], order = detail(), respond, options = {} } = {}) {
  const calls = [];
  const client = createRkeeperClient({ ...config, ...options }, { clock: () => now, wait: async () => {}, fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url, options, body });
    const value = respond ? await respond(body, calls.length) : envelope(body.taskType, body.taskType === 'GetOrderList' ? { orders: rows } : { order });
    return value instanceof Response ? value : Response.json(value);
  } });
  return { client, calls };
}

test('r_keeper reads authenticated real API contract and preserves minor units / true close time', async () => {
  const f = fixture(); const result = await f.client.poll();
  assert.deepEqual(result.receipts, [{ provider: 'rkeeper', scope: String(objectId), externalId: orderGuid, status: 'paid', billMinor: 40850, customerId: 'customer-17', closedAt: '2026-11-10T11:30:00.000Z' }]);
  assert.equal(f.calls.length, 2);
  for (const call of f.calls) {
    assert.equal(call.url, 'https://ws.ucs.ru/wsserverlp/api/v2/aggregators/Create');
    assert.equal(call.options.headers.AggregatorAuthentication, config.token);
    assert.equal(call.options.redirect, 'error');
    assert.equal(call.body.params.sync.objectId, objectId);
    assert.ok(call.options.signal instanceof AbortSignal);
  }
  assert.deepEqual(f.calls[0].body, { taskType: 'GetOrderList', params: { sync: { objectId, timeout: 10 }, withClosed: true } });
  assert.equal(f.calls[1].body.params.allExtendedProperties, true);
  assert.equal(f.calls[1].body.params.orderGuid, orderGuid);
  assert.ok(RKEEPER_REQUIREMENTS.licensedIntegrationRequired);
});

test('unknown customer, absent close timestamp and non-final orders never invent paid visits', async () => {
  const noCustom = fixture({ order: detail({ extProperties: { GuestPhone: '+79999999999', GuestName: 'Not an identity' }, createdAt: '2026-11-10T10:00:00', rkFriendsAnchor: orderGuid }) });
  assert.deepEqual((await noCustom.client.poll()).receipts[0], { provider: 'rkeeper', scope: String(objectId), externalId: orderGuid, status: 'review', billMinor: 40850, customerId: null, closedAt: null });
  const open = fixture({ rows: [row({ isFinished: false, unpaid: 408.5 })] });
  assert.equal((await open.client.poll()).receipts[0].status, 'open'); assert.equal(open.calls.length, 2);
  for (const change of [{ unpaid: 0.01 }, { isReturn: undefined }, { isReserve: true }, { unpaid: null }, { sum: '408.5001' }, { sum: -10 }, { sum: 0 }]) {
    assert.notEqual((await fixture({ rows: [row(change)] }).client.poll()).receipts[0].status, 'paid');
  }
});

test('r_keeper reads open order dishes, excludes voids and never guesses local opening time or discounted line totals', async () => {
  const order = detail({ tableCode: 7, waiterId: 15, comment: 'Kitchen only', products: [
    { name: 'Тако', quantity: 2, price: 100 }, { name: 'Отмена', quantity: 1, price: 50, voidReason: 'void' },
    { name: 'Отмена 2', quantity: 1, price: 50, voidingReason: 'void' },
  ], extProperties: { SvoiOpenedAt: '2026-11-10T14:00:00+03:00' } });
  const f = fixture({ rows: [row({ isFinished: false, unpaid: 408.5, openTime: '2026-11-10T14:00:00' })], order, options: { openedAtProperty: 'SvoiOpenedAt' } });
  const receipt = (await f.client.poll()).receipts[0];
  assert.equal(receipt.status, 'open'); assert.equal(receipt.closedAt, null);
  assert.deepEqual(receipt.service, { tableIds: ['7'], waiterId: '15', openedAt: '2026-11-10T11:00:00.000Z', comment: 'Kitchen only', items: [{ name: 'Тако', quantity: 2, sumMinor: null }] });
  const noOffset = fixture({ rows: [row({ openTime: '2026-11-10T14:00:00' })], order });
  assert.equal((await noOffset.client.poll()).receipts[0].service.openedAt, null);
});

test('r_keeper probe accepts a real pilot receipt identified by table/waiter/opening time without a customer field', async () => {
  const f = fixture({ options: { customerIdProperty: null, openedAtProperty: 'SvoiOpenedAt' }, order: detail({ tableCode: 7, waiterId: 15,
    extProperties: { SvoiClosedAt: '2026-11-10T14:30:00+03:00', SvoiOpenedAt: '2026-11-10T14:00:00+03:00' } }) });
  assert.equal((await f.client.probe()).ok, true);
});

test('return orders are flagged separately and list/detail discrepancies require review', async () => {
  assert.equal((await fixture({ rows: [row({ isReturn: true })] }).client.poll()).receipts[0].status, 'refund');
  const negativeReturn = (await fixture({ rows: [row({ isReturn: true, sum: -408.5 })] }).client.poll()).receipts[0];
  assert.equal(negativeReturn.status, 'refund'); assert.equal(negativeReturn.billMinor, null);
  assert.equal((await fixture({ order: detail({ price: { total: 410, sumToPay: 0 } }) }).client.poll()).receipts[0].status, 'review');
  assert.equal((await fixture({ order: detail({ price: { total: 408.5, sumToPay: 0.01 } }) }).client.poll()).receipts[0].status, 'review');
  const cents = fixture({ rows: [row({ sum: 0.29 })], order: detail({ price: { total: 0.29, sumToPay: 0 } }) });
  assert.equal((await cents.client.poll()).receipts[0].billMinor, 29);
});

test('ambiguous or invalid POS timestamps do not use server/open time as closure', async () => {
  for (const date of ['2026-11-10T14:30:00', '2026-02-30T12:00:00Z', '2026-11-11T12:00:00Z', '2026-11-10T25:00:00Z', 'not-a-date', null]) {
    const f = fixture({ order: detail({ extProperties: { SvoiClosedAt: date, SvoiCustomerId: 'known' } }) });
    const receipt = (await f.client.poll()).receipts[0]; assert.equal(receipt.closedAt, null); assert.equal(receipt.status, 'review');
  }
});

test('queued task uses documented GetTaskResponse and requires matching task/scope', async () => {
  let polls = 0;
  const f = fixture({ respond: body => {
    if (body.taskType === 'GetOrderList') return envelope('GetOrderList');
    assert.equal(body.taskType, 'GetTaskResponse'); assert.deepEqual(body.params, { taskGuid });
    if (polls++ === 0) return { error: { wsError: { code: 'AwaitingAnswer' } }, responseCommon: { taskType: 'GetTaskResponse', taskGuid } };
    return envelope('GetOrderList', { orders: [] });
  } });
  assert.deepEqual(await f.client.poll(), { receipts: [] });
  assert.equal(f.calls.length, 3);
  const wrong = fixture({ respond: body => body.taskType === 'GetOrderList' ? envelope('GetOrderList') : envelope('GetOrderList', { orders: [] }, { taskGuid: orderGuid }) });
  await assert.rejects(wrong.client.poll(), { code: 'SCOPE' });
});

test('task polling stops after a bounded number of pending responses', async () => {
  const f = fixture({ respond: body => body.taskType === 'GetOrderList' ? envelope('GetOrderList') : { error: { wsError: { code: 'AwaitingAnswer' } } } });
  await assert.rejects(f.client.poll(), { code: 'TIMEOUT' }); assert.equal(f.calls.length, 9);
});

test('cross-restaurant responses, mismatched orders and partial API failures abort the batch', async () => {
  await assert.rejects(fixture({ respond: body => envelope(body.taskType, { orders: [] }, { objectId: objectId + 1 }) }).client.poll(), { code: 'SCOPE' });
  await assert.rejects(fixture({ order: detail({ orderGuid: taskGuid }) }).client.poll(), { code: 'RESPONSE' });
  await assert.rejects(fixture({ respond: body => body.taskType === 'GetOrderList' ? envelope('GetOrderList', { orders: [row()] }) : new Response('secret raw message', { status: 429 }) }).client.poll(), { code: 'HTTP' });
});

test('oversized, malformed and duplicate batches fail without silent truncation', async () => {
  await assert.rejects(fixture({ rows: [row(), row({ orderGuid: taskGuid })], options: { maxOrders: 1 } }).client.poll(), { code: 'LIMIT' });
  await assert.rejects(fixture({ rows: [row(), row()] }).client.poll(), { code: 'RESPONSE' });
  await assert.rejects(fixture({ respond: () => new Response('bad-json') }).client.poll(), { code: 'RESPONSE' });
  await assert.rejects(fixture({ respond: () => new Response(' ', { headers: { 'content-length': '3000000' } }) }).client.poll(), { code: 'LIMIT' });
});

test('credentials never go to a caller-selected URL or appear in sanitized errors/probe', async () => {
  assert.throws(() => createRkeeperClient({ ...config, baseUrl: 'https://example.invalid/steal' }), { code: 'CONFIG' });
  const f = fixture({ respond: () => ({ error: { wsError: { code: 'AuthFailed', desc: `${config.token} upstream details` } } }) });
  await assert.rejects(f.client.probe(), error => { assert.ok(!error.message.includes(config.token)); assert.ok(!error.message.includes('upstream')); return error.code === 'PROVIDER'; });
  const clean = fixture(); assert.ok(!JSON.stringify(await clean.client.probe()).includes(config.token));
});

test('probe verifies detail permissions and real pilot-check fields, not just token validity', async () => {
  const healthy = fixture();
  assert.deepEqual(await healthy.client.probe(), { ok: true, provider: 'rkeeper', scope: String(objectId), orderCount: 1 });
  assert.equal(healthy.calls[1].body.taskType, 'GetOrder');
  await assert.rejects(fixture({ rows: [] }).client.probe(), { code: 'SETUP' });
  await assert.rejects(fixture({ order: detail({ extProperties: {} }) }).client.probe(), { code: 'SETUP' });
  await assert.rejects(fixture({ respond: body => body.taskType === 'GetOrderList' ? envelope('GetOrderList', { orders: [row()] }) : { error: { wsError: { code: 'Request is restricted' } } } }).client.probe(), { code: 'PROVIDER' });
});
