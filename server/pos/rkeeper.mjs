// Read-only White Server API v2. No mutation/payment/loyalty commands are sent.
// Contract: https://docs.rkeeper.ru/ws/white-server-api-v2-27845668.html
// https://docs.rkeeper.ru/ws/getorderlist-119015281.html
// https://docs.rkeeper.ru/ws/getorder-27846105.html
// https://docs.rkeeper.ru/ws/gettaskresponse-27846138.html
const ENDPOINT = 'https://ws.ucs.ru/wsserverlp/api/v2/aggregators/Create';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY = 2 * 1024 * 1024;
export const RKEEPER_REQUIREMENTS = Object.freeze({
  provider: 'rkeeper', api: 'White Server API v2', minimumAgent: '2.8.5.10',
  credential: 'AggregatorAuthentication', scope: 'objectId',
  permissions: ['GetOrderList: all tables', 'GetOrderList: closed orders', 'GetOrder'],
  licensedIntegrationRequired: true,
  customerIdentity: 'Configured extProperties key; opaque identity mapped by the venue owner to a registered guest.',
  closeTime: 'Configured extProperties key containing actual POS closure time with UTC offset; standard GetOrder has no documented closure time.',
  openTime: 'Optional configured extProperties key with actual opening time and explicit UTC offset; local openTime is not guessed.',
  history: 'GetOrderList has no documented date range, pagination or complete historical guarantee.',
  refunds: 'isReturn has no documented original-order link; requires reconciliation, never awards points.',
});

export class RkeeperError extends Error {
  constructor(code, message) { super(message); this.name = 'RkeeperError'; this.code = code; }
}
const fail = (code, message) => { throw new RkeeperError(code, message); };
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const guid = value => typeof value === 'string' && GUID.test(value);
const propertyName = value => value === undefined || value === null || value === '' ? null :
  typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(value) ? value : fail('CONFIG', 'Некорректное имя дополнительного поля r_keeper');
function minor(value) {
  if (!['number', 'string'].includes(typeof value)) return null;
  const text = String(value);
  if (!/^-?\d{1,7}(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.replace('-', '').split('.');
  const result = (Number(whole) * 100 + Number(fraction.padEnd(2, '0'))) * (text.startsWith('-') ? -1 : 1);
  return Number.isSafeInteger(result) && Math.abs(result) <= 100000000 ? result : null;
}
function closeTime(value, now) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const [year, month, day, hours, minutes, seconds] = value.match(/\d+/g).slice(0, 6).map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day || hours > 23 || minutes > 59 || seconds > 59) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) && millis >= Date.UTC(2000, 0, 1) && millis <= now + 5 * 60000 ? new Date(millis).toISOString() : null;
}
function normalized(row, detail, config, now) {
  const rawBill = minor(row.sum);
  // The import contract uses non-negative sale amounts. A signed/invalid refund
  // amount is unknown here; preserve its refund state without fabricating a sale.
  const billMinor = rawBill !== null && rawBill >= 0 ? rawBill : null;
  const unpaid = minor(row.unpaid);
  const props = object(detail?.extProperties) ? detail.extProperties : {};
  const identity = config.customerIdProperty && Object.hasOwn(props, config.customerIdProperty) ? props[config.customerIdProperty] : null;
  const customerId = typeof identity === 'string' && identity.trim().length > 0 && identity.trim().length <= 200 && !/[\x00-\x1f\x7f]/.test(identity) ? identity.trim() : null;
  const closedAt = config.closedAtProperty && Object.hasOwn(props, config.closedAtProperty) ? closeTime(props[config.closedAtProperty], now) : null;
  let status = 'review';
  if (row.isReturn === true) status = 'refund';
  else if (typeof row.isFinished === 'boolean' && (row.isFinished === false || (unpaid !== null && unpaid > 0))) status = 'open';
  else if (row.isFinished === true && row.isReturn === false && row.isReserve === false && unpaid === 0 && billMinor > 0 && closedAt &&
    minor(detail?.price?.total) === billMinor && minor(detail?.price?.sumToPay) === 0) status = 'paid';
  const receipt = { provider: 'rkeeper', scope: String(config.objectId), externalId: row.orderGuid.toLowerCase(), status, billMinor, customerId, closedAt };
  if (['tableCode', 'waiterId', 'products', 'comment'].some(key => Object.hasOwn(detail ?? {}, key) || Object.hasOwn(row, key)) || config.openedAtProperty) {
    const code = value => (typeof value === 'number' || typeof value === 'string') && /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? String(Number(value)) : null;
    const clean = (value, max) => typeof value === 'string' && value.trim() ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max) : null;
    if (detail?.products != null && (!Array.isArray(detail.products) || detail.products.length > 500)) fail('RESPONSE', 'Некорректные позиции заказа r_keeper');
    const tableId = code(detail?.tableCode ?? row.tableCode);
    receipt.service = { tableIds: tableId ? [tableId] : [], waiterId: code(detail?.waiterId ?? row.waiterId),
      openedAt: config.openedAtProperty && Object.hasOwn(props, config.openedAtProperty) ? closeTime(props[config.openedAtProperty], now) : null,
      items: (detail?.products ?? []).filter(item => object(item) && !item.voidReason && !item.voidingReason).map(item => ({
        name: clean(item.name, 200) || 'Позиция заказа', quantity: typeof item.quantity === 'number' ? item.quantity : Number(item.quantity),
        // White Server documents unit price, not a final discounted line total.
        sumMinor: null,
      })).filter(item => Number.isFinite(item.quantity) && item.quantity > 0 && item.quantity <= 1000000), comment: clean(detail?.comment, 1000) };
  }
  return receipt;
}

/** Credentials are server-only. No caller-selected host: avoid sending tokens to arbitrary URLs. */
export function createRkeeperClient(config, { fetchImpl = globalThis.fetch, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), clock = Date.now } = {}) {
  if (!object(config) || typeof config.token !== 'string' || config.token.length < 8 || config.token.length > 4096 || /[\r\n]/.test(config.token)) fail('CONFIG', 'Укажите серверный токен White Server');
  const objectId = Number(config.objectId);
  if (!Number.isSafeInteger(objectId) || objectId <= 0) fail('CONFIG', 'Укажите код ресторана objectId');
  if (config.baseUrl !== undefined && config.baseUrl !== ENDPOINT) fail('CONFIG', 'Адрес White Server не поддерживается');
  const settings = { objectId, customerIdProperty: propertyName(config.customerIdProperty), closedAtProperty: propertyName(config.closedAtProperty), openedAtProperty: propertyName(config.openedAtProperty) };
  const token = config.token;
  const maxOrders = config.maxOrders ?? 500;
  if (!Number.isSafeInteger(maxOrders) || maxOrders < 1 || maxOrders > 2000) fail('CONFIG', 'Лимит заказов должен быть от 1 до 2000');
  async function post(body, deadline) {
    const remaining = deadline - clock();
    if (remaining <= 0) fail('TIMEOUT', 'Истекло время ожидания r_keeper');
    let response;
    try {
      response = await fetchImpl(ENDPOINT, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(Math.min(15000, remaining)),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', AggregatorAuthentication: token }, body: JSON.stringify(body) });
    } catch { fail('NETWORK', 'White Server недоступен или не ответил вовремя'); }
    if (!response.ok) fail(response.status === 401 || response.status === 403 ? 'AUTH' : 'HTTP', 'White Server отклонил запрос; проверьте доступ и лицензию');
    if (Number(response.headers.get('content-length')) > MAX_BODY) fail('LIMIT', 'Ответ White Server превышает допустимый размер');
    const reader = response.body?.getReader();
    if (!reader) fail('RESPONSE', 'White Server вернул пустой ответ');
    let total = 0; const parts = [];
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        total += value.byteLength;
        if (total > MAX_BODY) { await reader.cancel(); fail('LIMIT', 'Ответ White Server превышает допустимый размер'); }
        parts.push(Buffer.from(value));
      }
    } catch (error) { if (error instanceof RkeeperError) throw error; fail('NETWORK', 'Не удалось дочитать ответ White Server'); }
    try { const value = JSON.parse(Buffer.concat(parts).toString('utf8')); if (!object(value)) throw new Error(); return value; }
    catch { fail('RESPONSE', 'White Server вернул некорректный JSON'); }
  }
  function envelope(value, taskType, expectedGuid) {
    if (value.error != null) fail('PROVIDER', 'r_keeper не выполнил запрос; проверьте доступы и состояние кассы');
    const common = value.responseCommon;
    if (!object(common) || Number(common.objectId) !== objectId || common.taskType !== taskType || !guid(common.taskGuid) ||
      (expectedGuid && common.taskGuid.toLowerCase() !== expectedGuid.toLowerCase())) fail('SCOPE', 'Ответ White Server не соответствует ресторану или запросу');
    return common.taskGuid;
  }
  async function request(taskType, params, deadline) {
    let value = await post({ taskType, params: { sync: { objectId, timeout: 10 }, ...params } }, deadline);
    const taskGuid = envelope(value, taskType);
    for (let attempt = 0; !object(value.taskResponse); attempt++) {
      if (attempt >= 8) fail('TIMEOUT', 'r_keeper ещё не завершил запрос; повторите синхронизацию позже');
      await wait(500);
      value = await post({ taskType: 'GetTaskResponse', params: { taskGuid } }, deadline);
      if (value.error?.wsError?.code === 'AwaitingAnswer' && !value.error.agentError && !value.taskResponse) continue;
      envelope(value, taskType, taskGuid);
    }
    return value.taskResponse;
  }
  async function list(deadline) {
    const result = await request('GetOrderList', { withClosed: true }, deadline);
    if (!Array.isArray(result.orders)) fail('RESPONSE', 'White Server не вернул список заказов');
    if (result.orders.length > maxOrders) fail('LIMIT', 'Слишком много заказов; синхронизация остановлена без частичного импорта');
    const seen = new Set();
    for (const row of result.orders) {
      if (!object(row) || !guid(row.orderGuid) || seen.has(row.orderGuid.toLowerCase())) fail('RESPONSE', 'White Server вернул некорректные или повторные идентификаторы заказов');
      seen.add(row.orderGuid.toLowerCase());
    }
    return result.orders;
  }
  async function readOrder(row, deadline) {
    const detail = (await request('GetOrder', { orderGuid: row.orderGuid, allExtendedProperties: true }, deadline)).order;
    if (!object(detail) || (detail.orderGuid !== undefined && (!guid(detail.orderGuid) || detail.orderGuid.toLowerCase() !== row.orderGuid.toLowerCase()))) fail('RESPONSE', 'White Server вернул другой или неполный заказ');
    return detail;
  }
  return {
    async probe() {
      // Authentication alone is not readiness: exercise the detail permission and
      // configured POS fields on an actual closed pilot order before enabling.
      const deadline = clock() + 10000; const rows = await list(deadline);
      const candidates = rows.filter(row => row.isFinished === true && row.isReturn === false && row.isReserve === false && minor(row.unpaid) === 0 && minor(row.sum) > 0)
        .sort((a, b) => String(b.openTime ?? b.createTime ?? '').localeCompare(String(a.openTime ?? a.createTime ?? ''))).slice(0, 8);
      for (const row of candidates) {
        const receipt = normalized(row, await readOrder(row, deadline), settings, clock());
        if (receipt.status === 'paid' && (receipt.customerId || (receipt.service?.tableIds.length === 1 && receipt.service.waiterId && receipt.service.openedAt))) return { ok: true, provider: 'rkeeper', scope: String(objectId), orderCount: rows.length };
      }
      fail('SETUP', 'Нужен оплаченный пробный чек с временем закрытия и либо клиентом, либо столом, официантом и временем открытия с часовым поясом');
    },
    async poll() {
      const deadline = clock() + 120000;
      const rows = await list(deadline); const receipts = new Array(rows.length); let cursor = 0;
      // Open orders need details too: table, waiter and dishes drive service cards.
      // A failure rejects the whole poll: the caller never advances with a partial batch.
      async function worker() {
        while (cursor < rows.length) {
          const index = cursor++; const row = rows[index];
          const detail = await readOrder(row, deadline);
          receipts[index] = normalized(row, detail, settings, clock());
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, rows.length) }, worker));
      return { receipts };
    },
  };
}
