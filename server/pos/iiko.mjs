import { createHash, timingSafeEqual } from 'node:crypto';

// Official contract checked 2026-11-10:
// https://api.iiko.help/docs/api-reference/ (TableOrders.Response.TableOrder)
// https://api.iiko.help/docs/concepts/authorization/
// https://api.iiko.help/docs/guides/webhooks/
// This read-only client never creates orders or replaces a restaurant's webhook.
const API_ORIGIN = 'https://api-ru.iiko.services';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nonzeroUuid = value => typeof value === 'string' && UUID.test(value) && value !== '00000000-0000-0000-0000-000000000000';
const sameId = (left, right) => typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase();
const isRecord = value => !!value && typeof value === 'object' && !Array.isArray(value);
const MAX_BYTES = 2 * 1024 * 1024;

export class IikoError extends Error {
  constructor(code, message, { retryable = false, status } = {}) {
    super(message); this.name = 'IikoError'; this.code = code; this.retryable = retryable;
    if (status) this.status = status;
  }
}
const invalid = () => new IikoError('IIKO_CONFIG', 'Проверьте настройки подключения iiko');
const malformed = () => new IikoError('IIKO_RESPONSE', 'iiko вернул неполные или неподдерживаемые данные');

export function validateIikoConfig(input) {
  if (!isRecord(input)) throw invalid();
  for (const key of ['appId', 'clientSecret', 'apiKey']) {
    if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > 4096 || /[\r\n]/.test(input[key])) throw invalid();
  }
  if (!nonzeroUuid(input.organizationId) || !Array.isArray(input.terminalGroupIds) || input.terminalGroupIds.length < 1 || input.terminalGroupIds.length > 100 || input.terminalGroupIds.some(id => !nonzeroUuid(id))) throw invalid();
  if (!Number.isInteger(input.utcOffsetMinutes) || input.utcOffsetMinutes < -720 || input.utcOffsetMinutes > 840) throw invalid();
  if (input.baseUrl !== undefined && input.baseUrl !== API_ORIGIN && input.baseUrl !== API_ORIGIN + '/') throw invalid();
  if (input.expectedWebhookUrl !== undefined) {
    if (typeof input.expectedWebhookUrl !== 'string' || input.expectedWebhookUrl.length > 2048) throw invalid();
    let webhookUrl;
    try { webhookUrl = new URL(input.expectedWebhookUrl); } catch { throw invalid(); }
    const localHttp = webhookUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(webhookUrl.hostname);
    if ((webhookUrl.protocol !== 'https:' && !localHttp) || webhookUrl.username || webhookUrl.password || webhookUrl.hash) throw invalid();
  }
  if (input.webhookToken !== undefined && (typeof input.webhookToken !== 'string' || input.webhookToken.length < 32 || input.webhookToken.length > 4096 || /[\r\n]/.test(input.webhookToken))) throw invalid();
  return { appId: input.appId, clientSecret: input.clientSecret, apiKey: input.apiKey,
    organizationId: input.organizationId.toLowerCase(), terminalGroupIds: [...new Set(input.terminalGroupIds.map(id => id.toLowerCase()))],
    utcOffsetMinutes: input.utcOffsetMinutes, baseUrl: API_ORIGIN,
    ...(input.expectedWebhookUrl !== undefined ? { expectedWebhookUrl: input.expectedWebhookUrl } : {}),
    ...(input.webhookToken !== undefined ? { webhookToken: input.webhookToken } : {}) };
}

function minor(value) {
  // Reject unknown amounts and fractional kopecks instead of silently rounding them.
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const result = Math.round(value * 100);
  return Number.isSafeInteger(result) && Math.abs(value * 100 - result) < 0.000001 ? result : null;
}

function localDate(value, offset) {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(value);
  if (!m) return null;
  const [year, month, day, hours, minutes, seconds] = m.slice(1, 7).map(Number);
  if (year < 2000 || year > 2200) return null;
  const millis = Number((m[7] || '').padEnd(3, '0'));
  const date = new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds, millis));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || date.getUTCHours() !== hours || date.getUTCMinutes() !== minutes || date.getUTCSeconds() !== seconds) return null;
  return new Date(date.getTime() - offset * 60000).toISOString();
}

function terminalOffset(value) {
  // TerminalGroup.timeZone is a date-span, not an IANA name. Require an
  // unambiguous whole-minute offset for every selected terminal group.
  if (typeof value !== 'string') return null;
  const match = /^([+-]?)(\d{1,2}):(\d{2}):00$/.exec(value);
  if (!match || Number(match[2]) > 14 || Number(match[3]) > 59) return null;
  return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
}

export function normalizeIikoOrder(info, rawConfig) {
  const config = validateIikoConfig(rawConfig);
  if (!isRecord(info) || !nonzeroUuid(info.id) || !sameId(info.organizationId, config.organizationId)) throw malformed();
  const result = { provider: 'iiko', scope: config.organizationId, externalId: info.id.toLowerCase(), status: 'review', billMinor: null, customerId: null, closedAt: null };
  if (info.creationStatus !== 'Success' || !isRecord(info.order)) return result;
  const order = info.order;
  if (!config.terminalGroupIds.some(id => sameId(id, order.terminalGroupId))) throw new IikoError('IIKO_SCOPE', 'Заказ относится к другой группе касс');
  result.billMinor = minor(order.sum);
  result.customerId = nonzeroUuid(order.customer?.id) ? order.customer.id.toLowerCase() : null;
  result.closedAt = localDate(order.whenClosed, config.utcOffsetMinutes);
  if (order.status === 'New' || order.status === 'Bill') result.status = 'open';
  const processed = minor(order.processedPaymentsSum);
  if (order.status === 'Closed' && result.billMinor > 0 && processed !== null && processed >= result.billMinor && result.closedAt) result.status = 'paid';
  // Deleted is not proof of a refund. The Cloud response has no reliable return
  // identifier or amount. Deleted/ambiguous corrections require reconciliation.
  return result;
}

export function verifyWebhookAuthorization(header, secret) {
  if (typeof secret !== 'string' || secret.length < 32 || secret.length > 4096 || typeof header !== 'string' || header.length > 4096) return false;
  return timingSafeEqual(createHash('sha256').update(header).digest(), createHash('sha256').update(secret).digest());
}

export function extractWebhookJobs(events, rawConfig) {
  const config = validateIikoConfig(rawConfig);
  if (!Array.isArray(events) || events.length > 1000) throw malformed();
  const ids = new Set();
  for (const event of events) {
    if (!isRecord(event)) throw malformed();
    if (event.eventType !== 'TableOrderUpdate' && event.eventType !== 'TableOrderError') continue;
    if (!sameId(event.organizationId, config.organizationId)) throw new IikoError('IIKO_SCOPE', 'Событие относится к другой организации');
    if (!isRecord(event.eventInfo) || !nonzeroUuid(event.eventInfo.id)) throw malformed();
    if (event.eventInfo.organizationId !== undefined && !sameId(event.eventInfo.organizationId, config.organizationId)) throw malformed();
    ids.add(event.eventInfo.id.toLowerCase());
  }
  // Event totals, customer details, timestamps and statuses are deliberately not
  // trusted. A durable worker must obtain the current order through fetchReceipt.
  return [...ids].map(externalId => ({ provider: 'iiko', scope: config.organizationId, externalId }));
}

async function readJson(response) {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) throw malformed();
  const reader = response.body?.getReader();
  if (!reader) throw malformed();
  const chunks = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) { await reader.cancel(); throw malformed(); }
      chunks.push(value);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!isRecord(value)) throw malformed();
    return value;
  } catch (error) { if (error instanceof IikoError) throw error; throw malformed(); }
  finally { reader.releaseLock(); }
}

export function createIikoClient(rawConfig, { fetchImpl = fetch, clock = Date.now, timeoutMs = 15000 } = {}) {
  const config = validateIikoConfig(rawConfig);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw invalid();
  let token = null; let expiresAt = 0; let tokenRequest;
  async function post(path, body, accessToken) {
    try {
      const response = await fetchImpl(config.baseUrl + path, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'Content-Type': 'application/json', Timeout: '15', ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) }, body: JSON.stringify(body) });
      if (!response.ok) {
        await response.body?.cancel();
        throw new IikoError('IIKO_HTTP', 'Не удалось получить данные iiko. Проверьте доступ и повторите запрос', { status: response.status, retryable: response.status === 408 || response.status === 429 || response.status >= 500 });
      }
      return await readJson(response);
    } catch (error) {
      if (error instanceof IikoError) throw error;
      // Fetch errors may contain the URL or credentials in the response body.
      throw new IikoError('IIKO_NETWORK', 'Нет ответа от iiko. Повторите запрос позже', { retryable: true });
    }
  }
  async function getToken() {
    if (token && clock() < expiresAt) return token;
    if (!tokenRequest) tokenRequest = (async () => {
      const reply = await post('/api/v2/access_token', { appId: config.appId, clientSecret: config.clientSecret, apiKey: config.apiKey });
      if (typeof reply.token !== 'string' || !reply.token || reply.token.length > 20000 || /[\r\n]/.test(reply.token)) throw malformed();
      token = reply.token; expiresAt = clock() + 50 * 60000; return token;
    })().finally(() => { tokenRequest = undefined; });
    return tokenRequest;
  }
  async function authorized(path, body) {
    const first = await getToken();
    try { return await post(path, body, first); }
    catch (error) {
      if (error.status !== 401) throw error;
      if (token === first) { token = null; expiresAt = 0; }
      return post(path, body, await getToken());
    }
  }
  return {
    async probe() {
      const reply = await authorized('/api/1/organizations', { organizationIds: [config.organizationId], returnAdditionalInfo: true, includeDisabled: false });
      const org = Array.isArray(reply.organizations) && reply.organizations.find(item => sameId(item?.id, config.organizationId));
      if (!org) throw new IikoError('IIKO_SCOPE', 'Нет доступа к выбранной организации iiko');
      if (org.currencyIsoName !== 'RUB') throw new IikoError('IIKO_CURRENCY', 'Для этого подключения нужна касса с валютой RUB');
      const terminals = await authorized('/api/1/terminal_groups', { organizationIds: [config.organizationId], includeDisabled: false });
      if (!Array.isArray(terminals.terminalGroups)) throw malformed();
      const allowed = terminals.terminalGroups.filter(group => sameId(group?.organizationId, config.organizationId)).flatMap(group => Array.isArray(group.items) ? group.items : []);
      if (config.terminalGroupIds.some(id => !allowed.some(item => sameId(item?.id, id) && sameId(item?.organizationId, config.organizationId)))) throw new IikoError('IIKO_SCOPE', 'Нет доступа к выбранной группе касс iiko');
      if (allowed.filter(item => config.terminalGroupIds.some(id => sameId(item?.id, id))).some(item => terminalOffset(item.timeZone) !== config.utcOffsetMinutes)) throw new IikoError('IIKO_TIMEZONE', 'Часовой пояс подключения не совпадает с выбранными кассами iiko');
      const hooks = await authorized('/api/1/webhooks/settings', { organizationId: config.organizationId });
      // authToken and webhook URLs may contain secrets: do not return either.
      return { provider: 'iiko', scope: config.organizationId, terminalGroupIds: [...config.terminalGroupIds],
        webhookConfigured: typeof hooks.webHooksUri === 'string' && hooks.webHooksUri.length > 0,
        webhookMatches: !!config.expectedWebhookUrl && hooks.webHooksUri === config.expectedWebhookUrl,
        authTokenMatches: verifyWebhookAuthorization(hooks.authToken, config.webhookToken),
        tableWebhookConfigured: isRecord(hooks.webHooksFilter?.tableOrderFilter) &&
          (hooks.webHooksFilter.tableOrderFilter.orderStatuses == null ||
            (Array.isArray(hooks.webHooksFilter.tableOrderFilter.orderStatuses) &&
              ['Closed', 'Deleted'].every(status => hooks.webHooksFilter.tableOrderFilter.orderStatuses.includes(status)))) };
    },
    async fetchReceipt(orderId) {
      if (!nonzeroUuid(orderId)) throw malformed();
      const reply = await authorized('/api/1/order/by_id', { organizationIds: [config.organizationId], orderIds: [orderId.toLowerCase()] });
      if (!Array.isArray(reply.orders)) throw malformed();
      const matches = reply.orders.filter(item => sameId(item?.id, orderId) && sameId(item?.organizationId, config.organizationId));
      if (matches.length !== 1) throw new IikoError('IIKO_ORDER_MISSING', 'Заказ ещё не доступен в iiko или доступ ограничен', { retryable: true });
      return normalizeIikoOrder(matches[0], config);
    },
  };
}
