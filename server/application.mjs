import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, resolve, sep } from 'node:path';
import { isIP } from 'node:net';
import { validateInitData } from './telegram-auth.mjs';
import { Store, ApiError } from './database.mjs';
import { PosRuntime } from './pos/runtime.mjs';
import { readReleaseInfo } from './release-info.mjs';

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ttf': 'font/ttf', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };
function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  response.end(JSON.stringify(value));
}
async function readBody(request, { maxSize = 20000, array = false } = {}) {
  if (!String(request.headers['content-type'] || '').startsWith('application/json')) throw new ApiError(415, 'Ожидается JSON');
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > maxSize) throw new ApiError(413, 'Запрос слишком большой'); chunks.push(chunk); }
  try { const result = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!result || typeof result !== 'object' || (array ? !Array.isArray(result) : Array.isArray(result))) throw new Error(); return result; }
  catch { throw new ApiError(400, 'Некорректный JSON'); }
}
export function createApplication({ dataPath = process.env.DATABASE_PATH || process.env.DATA_PATH || resolve('data/svoi.sqlite'), botToken = process.env.TELEGRAM_BOT_TOKEN, publicUrl = process.env.PUBLIC_APP_URL, root = fileURLToPath(new URL('../dist/', import.meta.url)), clock = Date.now, rateLimits = true, posOptions = {}, developerIds = process.env.DEVELOPER_TELEGRAM_IDS || [] } = {}) {
  const release = readReleaseInfo();
  const store = new Store(dataPath, { clock, developerIds }); const attempts = new Map(); const allowedOrigin = publicUrl ? new URL(publicUrl).origin : null;
  const pos = new PosRuntime(store, { publicUrl, clock, ...posOptions });
  function rate(key, limit) {
    if (!rateLimits) return;
    const now = clock(); let bucket = attempts.get(key);
    if (!bucket || now - bucket.since >= 60000) { bucket = { since: now, count: 0 }; attempts.set(key, bucket); }
    if (++bucket.count > limit) throw new ApiError(429, 'Слишком много запросов. Попробуйте через минуту');
    if (attempts.size > 10000) for (const [id, item] of attempts) if (now - item.since >= 60000) attempts.delete(id);
    if (attempts.size > 20000) throw new ApiError(503, 'Сервис занят. Попробуйте позже');
  }
  const server = createServer(async (request, response) => {
    let pathname;
    try {
      pathname = new URL(request.url, 'http://localhost').pathname;
      if (pathname === '/api/health' && request.method === 'GET') {
        const databaseSchema = store.sql.prepare('PRAGMA user_version').get().user_version;
        store.sql.prepare('SELECT id FROM app_state WHERE id=1').get();
        json(response, 200, { app: 'svoi-telegram', mode: 'live', database: 'ready', databaseSchema, release, telegramAuthConfigured: !!botToken }); return;
      }
      const webhookMatch = /^\/api\/pos\/webhooks\/iiko\/([a-f0-9-]{36})$/.exec(pathname);
      if (webhookMatch && request.method === 'POST') {
        if (request.headers.origin) throw new ApiError(403, 'Ожидается серверное кассовое событие');
        rate(`webhook:${webhookMatch[1]}`, 300);
        const body = await readBody(request, { maxSize: 262144, array: true });
        json(response, 200, pos.webhook(webhookMatch[1], request.headers.authorization, body)); return;
      }
      if (pathname.startsWith('/api/')) {
        const address = request.socket.remoteAddress || 'unknown'; const forwarded = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address) ? String(request.headers['x-forwarded-for'] || '').split(',').at(-1).trim() : '';
        const remote = isIP(forwarded) ? forwarded : address; const origin = request.headers.origin; const localOrigin = `http://${request.headers.host}`;
        if (origin && origin !== (allowedOrigin || localOrigin)) throw new ApiError(403, 'Запрос с другого сайта отклонён'); rate(`ip:${remote}`, 600);
        if (pathname === '/api/session' && request.method === 'POST') {
          rate(`login:${remote}`, 30); if (!botToken) throw new ApiError(503, 'Вход через Telegram ещё не настроен'); const body = await readBody(request); let user;
          try { user = validateInitData(body.initData, botToken, Math.floor(clock() / 1000)); }
          catch { throw new ApiError(401, 'Не удалось подтвердить Telegram. Закройте приложение и откройте снова через бота'); }
          json(response, 200, store.login(user)); return;
        }
        const authorization = request.headers.authorization || ''; const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
        const userId = store.authenticate(token); rate(`user:${userId}`, 180);
        if (pathname === '/api/session' && request.method === 'DELETE') { store.logout(token); json(response, 200, { ok: true }); return; }
        if (pathname === '/api/state' && request.method === 'GET') { json(response, 200, store.snapshot(userId)); return; }
        if (pathname === '/api/pos/status' && request.method === 'GET') {
          json(response, 200, pos.status(userId, new URL(request.url, 'http://localhost').searchParams.get('venueId'))); return;
        }
        if (pathname.startsWith('/api/pos/') && request.method === 'POST') {
          rate(`pos:${userId}`, 20); const body = await readBody(request); let result;
          if (pathname === '/api/pos/configure') result = pos.save(userId, body);
          else if (pathname === '/api/pos/probe') { rate(`probe:${userId}`, 5); result = await pos.probe(userId, body.connectionId); }
          else if (pathname === '/api/pos/enabled') result = pos.setEnabled(userId, body.connectionId, body.enabled);
          else if (pathname === '/api/pos/bind') result = pos.bind(userId, body);
          else if (pathname === '/api/pos/webhook-setup') result = pos.setup(userId, body.connectionId);
          else throw new ApiError(404, 'Адрес не найден');
          json(response, 200, result); return;
        }
        if (pathname === '/api/commands' && request.method === 'POST') {
          rate(`command:${userId}`, 60); const body = await readBody(request);
          try { json(response, 200, store.command(userId, body)); }
          catch (error) { if (error instanceof ApiError) throw error; if (error instanceof Error && !error.code) throw new ApiError(400, error.message); throw error; } return;
        }
        throw new ApiError(404, 'Адрес не найден');
      }
      if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
      const path = decodeURIComponent(pathname); let file = resolve(root, `.${path === '/' ? '/index.html' : path}`);
      if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) { response.writeHead(403); response.end(); return; }
      try { if ((await stat(file)).isDirectory()) file = resolve(file, 'index.html'); const data = request.method === 'HEAD' ? '' : await readFile(file);
        response.writeHead(200, { 'Content-Type': mime[extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }); response.end(data);
      } catch { response.writeHead(404); response.end('Not found'); }
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 500;
      if (!response.headersSent) json(response, status, { error: status === 500 ? 'Не удалось выполнить запрос. Попробуйте позже' : error.message }); else response.end();
      if (status === 500) console.error('Request failed', pathname, error?.code || error?.name || 'Error');
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  return { server, store, pos, close: async () => { await pos.close(); return new Promise((resolveClose, reject) => server.close(error => { if (error) reject(error); else { store.close(); resolveClose(); } })); } };
}
