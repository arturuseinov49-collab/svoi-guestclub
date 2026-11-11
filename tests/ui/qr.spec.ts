import { test, expect, APIRequestContext, Browser } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';

const testToken = '123456:local-live-test-secret-do-not-deploy';
function signed(id: number) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: randomUUID(), user: JSON.stringify({ id, first_name: 'Проверка сканера' }) });
  const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n');
  const key = createHmac('sha256', 'WebAppData').update(testToken).digest();
  params.set('hash', createHmac('sha256', key).update(check).digest('hex'));
  return params.toString();
}
async function session(request: APIRequestContext, id: number) {
  const response = await request.post('/api/session', { data: { initData: signed(id) } });
  expect(response.status()).toBe(200); return response.json();
}
async function command(request: APIRequestContext, token: string, type: string, fields: Record<string, unknown>) {
  const response = await request.post('/api/commands', { headers: { Authorization: `Bearer ${token}` }, data: { type, idempotencyKey: randomUUID(), ...fields } });
  expect(response.status()).toBe(200); return (await response.json()).result;
}
async function scanner(browser: Browser, request: APIRequestContext, version: string, native: boolean) {
  const id = Date.now();
  const account = await session(request, id);
  const guest = await session(request, id + 1);
  const developer = await session(request, 900000001);
  const venue = await command(request, developer.token, 'createVenue', { name: 'Проверка восстановления сканера', kind: 'Кафе', address: 'Тестовая площадка' });
  const invitation = await command(request, developer.token, 'createManagerInvite', { venueId: venue.venueId });
  await command(request, account.token, 'acceptStaffInvite', { code: invitation.code });
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:8094', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.route('https://telegram.org/js/telegram-web-app.js*', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
  await context.addInitScript(({ initData, version, native }) => {
    const target = window as any;
    const noop = () => {};
    target.__scanCallbacks = []; target.__scanCloses = 0;
    target.Telegram = { WebApp: { initData, platform: 'android', version, ready: noop, expand: noop, setHeaderColor: noop, setBackgroundColor: noop, onEvent: noop, offEvent: noop, BackButton: { show: noop, hide: noop, onClick: noop, offClick: noop }, HapticFeedback: { notificationOccurred: noop },
      ...(native ? { showScanQrPopup: (_options: unknown, callback: unknown) => target.__scanCallbacks.push(callback), closeScanQrPopup: () => { target.__scanCloses++; } } : {}),
    } };
  }, { initData: signed(id), version, native });
  const page = await context.newPage();
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Сканировать QR гостя', exact: true }).click();
  return { context, page, guest, errors };
}

test('legacy Telegram scanner can recover after cancel and use a manual code without creating a visit', async ({ browser, request }) => {
  const phone = await scanner(browser, request, '6.4', true);
  try {
    await phone.page.getByRole('button', { name: 'Открыть камеру', exact: true }).click();
    // Old Telegram closes the native popup without a scanQrPopupClosed event.
    await phone.page.getByRole('button', { name: 'Открыть сканер снова', exact: true }).click();
    expect(await phone.page.evaluate(() => (window as any).__scanCallbacks.length)).toBe(2);
    expect(await phone.page.evaluate(() => (window as any).__scanCloses)).toBe(1);
    const mutations: string[] = [];
    phone.page.on('request', req => { if (req.url().endsWith('/api/commands')) mutations.push(req.postDataJSON()?.type); });
    // A late callback from the cancelled scan cannot resolve a different guest.
    await phone.page.evaluate(qr => (window as any).__scanCallbacks[0](qr), phone.guest.guestQr);
    await phone.page.getByLabel('Код гостя или текст QR', { exact: true }).fill(phone.guest.guestCode);
    await phone.page.getByRole('button', { name: 'Найти гостя по коду', exact: true }).click();
    await expect(phone.page.getByText('Предпочтения гостя', { exact: true })).toBeVisible();
    await expect(phone.page.getByLabel('Сумма чека, ₽', { exact: true })).toHaveCount(0);
    expect(mutations).toEqual(['addGuest']);
    const response = await request.get('/api/state', { headers: { Authorization: `Bearer ${phone.guest.token}` } });
    const state = await response.json();
    expect(state.db.visits).toHaveLength(0); expect(state.db.transactions).toHaveLength(0);
    expect(phone.errors).toEqual([]);
  } finally { await phone.context.close(); }
});

test('browser camera releases late permissions and recovers when its track ends', async ({ browser, request }) => {
  const phone = await scanner(browser, request, '8.0', false);
  try {
    await phone.page.evaluate(() => {
      const target = window as any;
      target.BarcodeDetector = class { detect() { return Promise.resolve([]); } };
      target.__cameraCalls = 0;
      const canvas = document.createElement('canvas'); canvas.width = 100; canvas.height = 100;
      const drawing = canvas.getContext('2d')!;
      target.__makeStream = () => { const media = canvas.captureStream(1); drawing.fillRect(0, 0, 100, 100); target.__lastStream = media; return media; };
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: () => {
        target.__cameraCalls++;
        return target.__cameraCalls === 1 ? new Promise(resolve => { target.__grantCamera = () => resolve(target.__makeStream()); }) : Promise.resolve(target.__makeStream());
      } });
    });
    await phone.page.getByRole('button', { name: 'Открыть камеру', exact: true }).click();
    await expect(phone.page.getByRole('button', { name: 'Запрашиваем камеру…', exact: true })).toBeVisible();
    await phone.page.getByRole('button', { name: 'Закрыть камеру', exact: true }).click();
    await phone.page.evaluate(() => (window as any).__grantCamera());
    await expect.poll(() => phone.page.evaluate(() => (window as any).__lastStream.getVideoTracks()[0].readyState)).toBe('ended');
    await phone.page.getByRole('button', { name: 'Открыть камеру', exact: true }).click();
    await expect(phone.page.getByRole('button', { name: 'Камера открыта', exact: true })).toBeVisible();
    await phone.page.evaluate(() => (window as any).__lastStream.getVideoTracks()[0].dispatchEvent(new Event('ended')));
    await expect(phone.page.getByText('Камера отключилась. Откройте её снова или введите код гостя ниже.', { exact: true })).toBeVisible();
    await expect(phone.page.getByRole('button', { name: 'Открыть камеру', exact: true })).toBeEnabled();
    await phone.page.getByRole('button', { name: 'Открыть камеру', exact: true }).click();
    await expect(phone.page.getByRole('button', { name: 'Камера открыта', exact: true })).toBeVisible();
    await phone.page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    await expect.poll(() => phone.page.evaluate(() => (window as any).__lastStream.getVideoTracks()[0].readyState)).toBe('ended');
    expect(phone.errors).toEqual([]);
  } finally { await phone.context.close(); }
});
