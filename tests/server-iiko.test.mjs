import test from 'node:test';
import assert from 'node:assert/strict';
import { createIikoClient, validateIikoConfig, normalizeIikoOrder, verifyWebhookAuthorization, extractWebhookJobs } from '../server/pos/iiko.mjs';

const org = '11111111-1111-4111-8111-111111111111';
const terminal = '22222222-2222-4222-8222-222222222222';
const order = '33333333-3333-4333-8333-333333333333';
const customer = '44444444-4444-4444-8444-444444444444';
const other = '55555555-5555-4555-8555-555555555555';
const secret = 'test-only-secret-that-is-not-a-live-secret';
const config = { appId: 'test-app', clientSecret: secret, apiKey: 'test-only-key', organizationId: org, terminalGroupIds: [terminal], utcOffsetMinutes: 180,
  expectedWebhookUrl: 'https://example.test/hooks/iiko/connection', webhookToken: 'test-only-webhook-token-32-characters-long' };
const info = patch => ({ id: order, organizationId: org, creationStatus: 'Success', timestamp: 123456,
  order: { terminalGroupId: terminal, status: 'Closed', sum: 200.50, processedPaymentsSum: 200.50, whenClosed: '2026-11-10 12:34:56.123', customer: { id: customer, name: 'Ignored PII' }, ...patch } });
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('iiko normalizes verified closed payment in integer kopecks and explicit local offset', () => {
  assert.deepEqual(normalizeIikoOrder(info(), config), { provider: 'iiko', scope: org, externalId: order, status: 'paid', billMinor: 20050, customerId: customer, closedAt: '2026-11-10T09:34:56.123Z' });
  assert.equal(normalizeIikoOrder(info({ customer: null, phone: '+79990000000' }), config).customerId, null);
  assert.equal(normalizeIikoOrder(info({ sum: 0.29, processedPaymentsSum: 0.29 }), config).billMinor, 29);
  assert.equal(normalizeIikoOrder(info({ customer: { id: '00000000-0000-0000-0000-000000000000' } }), config).customerId, null);
});

test('iiko service metadata uses Cloud table IDs, terminal-local opening time and final line sums without inventing compound totals', () => {
  const value = normalizeIikoOrder(info({ tableIds: [other], whenCreated: '2026-11-10 12:00:00.000', waiter: { id: customer, phone: 'private' },
    comment: 'Kitchen only', items: [
      { type: 'Product', product: { name: 'Тако' }, amount: 2, price: 100, resultSum: 150 },
      { type: 'Product', product: { name: 'Удалено' }, amount: 1, resultSum: 100, deleted: { reason: 'void' } },
      { type: 'Compound', primaryComponent: { product: { name: 'Первая половина' }, resultSum: 100 }, secondaryComponent: { product: { name: 'Вторая половина' } }, amount: 1 },
      { type: 'Service', service: { name: 'Подача' }, amount: 1, cost: 15 },
    ] }), config);
  assert.deepEqual(value.service, { tableIds: [other], waiterId: customer, openedAt: '2026-11-10T09:00:00.000Z', comment: 'Kitchen only', items: [
    { name: 'Тако', quantity: 2, sumMinor: 15000 }, { name: 'Первая половина / Вторая половина', quantity: 1, sumMinor: null }, { name: 'Подача', quantity: 1, sumMinor: null },
  ] });
  assert.equal(JSON.stringify(value).includes('private'), false);
  assert.equal(value.billMinor, 20050);
  for (const tableIds of [[other, 'malformed-table'], [other, other.toUpperCase()], 'not-an-array']) {
    assert.throws(() => normalizeIikoOrder(info({ tableIds }), config), /неполные/);
  }
});

test('iiko table discovery reads one scoped candidate batch with terminal-local dateFrom and rejects cross-table or duplicate data', async () => {
  const calls = []; let orders = [info({ tableIds: [other] })];
  const client = createIikoClient(config, { fetchImpl: async (url, options) => {
    if (url.endsWith('/access_token')) return response({ token: 'test-access-token' });
    assert.equal(new URL(url).pathname, '/api/1/order/by_table'); calls.push(JSON.parse(options.body)); return response({ orders });
  } });
  assert.equal((await client.fetchTableReceipts([other], '2026-11-10T09:00:00.000Z')).length, 1);
  assert.deepEqual(calls[0], { organizationIds: [org], tableIds: [other], statuses: ['New', 'Bill', 'Closed', 'Deleted'], dateFrom: '2026-11-10 12:00:00.000' });
  orders = [info({ tableIds: [customer] })]; await assert.rejects(client.fetchTableReceipts([other], '2026-11-10T09:00:00Z'));
  orders = [info({ tableIds: [other] }), info({ tableIds: [other] })]; await assert.rejects(client.fetchTableReceipts([other], '2026-11-10T09:00:00Z'));
});

test('iiko does not invent payments, closing times or refunds from partial vendor data', () => {
  for (const patch of [{ processedPaymentsSum: null }, { processedPaymentsSum: 199 }, { processedPaymentsSum: '200.50' },
    { sum: -10 }, { sum: 0 }, { sum: 1.001 }, { sum: Infinity }, { sum: null }, { whenClosed: null },
    { whenClosed: '2026-02-31 12:00:00.000' }, { whenClosed: '2026-11-10T12:00:00Z' }, { status: 'Deleted' }, { status: 'Refunded' }]) {
    assert.equal(normalizeIikoOrder(info(patch), config).status, 'review', JSON.stringify(patch));
  }
  for (const status of ['New', 'Bill']) assert.equal(normalizeIikoOrder(info({ status }), config).status, 'open');
  assert.equal(normalizeIikoOrder({ ...info(), creationStatus: 'InProgress', order: null }, config).status, 'review');
  assert.throws(() => normalizeIikoOrder({ ...info(), organizationId: other }, config), /неполные/);
  assert.throws(() => normalizeIikoOrder(info({ terminalGroupId: other }), config), /другой группе/);
});

test('iiko webhook accepts only exact authorization, extracts IDs only, rejects cross-organization batch', () => {
  assert.equal(verifyWebhookAuthorization(config.webhookToken, config.webhookToken), true);
  for (const header of ['', undefined, `Bearer ${config.webhookToken}`, config.webhookToken + 'x']) assert.equal(verifyWebhookAuthorization(header, config.webhookToken), false);
  assert.equal(verifyWebhookAuthorization('short', 'short'), false);
  const event = { eventType: 'TableOrderUpdate', organizationId: org, eventInfo: { id: order, order: { sum: 99999999, customer: { id: other } } } };
  assert.deepEqual(extractWebhookJobs([event, event, { eventType: 'StopListUpdate' }], config), [{ provider: 'iiko', scope: org, externalId: order }]);
  assert.throws(() => extractWebhookJobs([event, { ...event, organizationId: other }], config), /другой организации/);
  assert.throws(() => extractWebhookJobs([{ ...event, eventInfo: { id: order, organizationId: other } }], config));
  assert.throws(() => extractWebhookJobs({ events: [event] }, config));
  assert.throws(() => extractWebhookJobs(Array(1001).fill(event), config));
});

test('iiko restricts host, credentials, organization and terminal scoping before network requests', () => {
  for (const patch of [{ baseUrl: 'http://127.0.0.1' }, { baseUrl: 'https://api-ru.iiko.services.attacker.test' },
    { baseUrl: 'https://api-ru.iiko.services/path' }, { terminalGroupIds: [] }, { organizationId: 'not-an-id' },
    { utcOffsetMinutes: undefined }, { utcOffsetMinutes: 841 }, { clientSecret: 'bad\nheader' }]) {
    assert.throws(() => validateIikoConfig({ ...config, ...patch }), /настройки/);
  }
  for (const expectedWebhookUrl of ['http://localhost:8094/hook', 'http://127.0.0.1:8094/hook', 'http://[::1]:8094/hook']) assert.equal(validateIikoConfig({ ...config, expectedWebhookUrl }).expectedWebhookUrl, expectedWebhookUrl);
  for (const expectedWebhookUrl of ['http://example.com/hook', 'http://localhost.attacker.test/hook', 'https://username:password@example.com/hook', 'not-a-url']) assert.throws(() => validateIikoConfig({ ...config, expectedWebhookUrl }), /настройки/);
});

test('iiko client verifies organization/currency/terminals and exact webhook without leaking config or mutating POS', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, ...options, body: JSON.parse(options.body) });
    assert.equal(options.redirect, 'error'); assert.ok(options.signal);
    const path = new URL(url).pathname;
    if (path === '/api/v2/access_token') return response({ token: 'test-access-token' });
    assert.equal(options.headers.Authorization, 'Bearer test-access-token');
    if (path === '/api/1/organizations') return response({ organizations: [{ id: org, currencyIsoName: 'RUB' }] });
    if (path === '/api/1/terminal_groups') return response({ terminalGroups: [{ organizationId: org, items: [{ id: terminal, organizationId: org, timeZone: '03:00:00' }] }] });
    if (path === '/api/1/webhooks/settings') return response({ webHooksUri: config.expectedWebhookUrl, authToken: config.webhookToken, webHooksFilter: { tableOrderFilter: { orderStatuses: ['Closed', 'Deleted'] } } });
    if (path === '/api/1/order/by_id') return response({ orders: [info()] });
    throw new Error('Unexpected POS mutation');
  };
  const client = createIikoClient(config, { fetchImpl });
  assert.deepEqual(await client.probe(), { provider: 'iiko', scope: org, terminalGroupIds: [terminal], webhookConfigured: true, webhookMatches: true, authTokenMatches: true, tableWebhookConfigured: true });
  assert.equal((await client.fetchReceipt(order)).status, 'paid');
  assert.equal(calls.filter(call => call.url.endsWith('/api/v2/access_token')).length, 1);
  assert.deepEqual(calls[0].body, { appId: config.appId, clientSecret: config.clientSecret, apiKey: config.apiKey });
  assert.deepEqual(calls.at(-1).body, { organizationIds: [org], orderIds: [order] });
});

test('iiko retries expired token once but never relays vendor bodies or network error secrets', async () => {
  let tokens = 0; let orders = 0;
  const client = createIikoClient(config, { fetchImpl: async url => {
    if (url.endsWith('/access_token')) return response({ token: `token${++tokens}` });
    if (++orders === 1) return response({ error: secret }, 401);
    return response({ orders: [info()] });
  } });
  assert.equal((await client.fetchReceipt(order)).status, 'paid'); assert.equal(tokens, 2); assert.equal(orders, 2);
  const broken = createIikoClient(config, { fetchImpl: async () => { throw new Error(secret); } });
  await assert.rejects(broken.fetchReceipt(order), error => error.code === 'IIKO_NETWORK' && !String(error.stack).includes(secret));
  const busy = createIikoClient(config, { fetchImpl: async () => response({ error: secret }, 429) });
  await assert.rejects(busy.fetchReceipt(order), error => error.retryable && error.status === 429 && !String(error.stack).includes(secret));
});

test('iiko fails closed on wrong scope, unavailable orders, oversized or malformed JSON', async () => {
  for (const orderReply of [response({ orders: [] }), response({ orders: [{ ...info(), organizationId: other }] }),
    response({ orders: [info(), info()] }), response({ orders: null }), new Response('not JSON'),
    new Response('x'.repeat(2 * 1024 * 1024 + 1))]) {
    const client = createIikoClient(config, { fetchImpl: async url => url.endsWith('/access_token') ? response({ token: 'token' }) : orderReply });
    await assert.rejects(client.fetchReceipt(order));
  }
});

test('iiko probe rejects another organization, unsupported currency, foreign terminals and offset mismatch', async () => {
  for (const patch of [{ orgId: other }, { currency: 'USD' }, { currency: null }, { terminalId: other }, { terminalOrg: other }, { timeZone: '04:00:00' }, { timeZone: undefined }]) {
    const client = createIikoClient(config, { fetchImpl: async url => {
      if (url.endsWith('/access_token')) return response({ token: 'token' });
      if (url.endsWith('/organizations')) return response({ organizations: [{ id: patch.orgId || org, currencyIsoName: 'currency' in patch ? patch.currency : 'RUB' }] });
      if (url.endsWith('/terminal_groups')) return response({ terminalGroups: [{ organizationId: org, items: [{ id: patch.terminalId || terminal, organizationId: patch.terminalOrg || org, timeZone: 'timeZone' in patch ? patch.timeZone : '03:00:00' }] }] });
      throw new Error('Should stop before webhook request');
    } });
    await assert.rejects(client.probe(), error => ['IIKO_SCOPE', 'IIKO_CURRENCY', 'IIKO_TIMEZONE'].includes(error.code), JSON.stringify(patch));
  }
});

test('iiko token is shared between simultaneous reads and refreshed before expiry', async () => {
  let now = 0; let tokens = 0;
  const client = createIikoClient(config, { clock: () => now, fetchImpl: async url => {
    if (url.endsWith('/access_token')) return response({ token: `token${++tokens}` });
    return response({ orders: [info()] });
  } });
  await Promise.all([client.fetchReceipt(order), client.fetchReceipt(order)]); assert.equal(tokens, 1);
  now = 50 * 60000;
  await client.fetchReceipt(order); assert.equal(tokens, 2);
});
