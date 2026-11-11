import { test, expect, Browser, Page, APIRequestContext } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import sharp from 'sharp';
import jsQR from 'jsqr';

const testToken = '123456:local-live-test-secret-do-not-deploy';
const origin = 'http://127.0.0.1:8094';
let userNumber = Date.now();
let phoneNumber = 0;
function identity(firstName: string) { return { id: ++userNumber, first_name: firstName, last_name: 'Проверка' }; }
type Identity = ReturnType<typeof identity>;
const developerIdentity: Identity = { id: 900000001, first_name: 'Разработчик', last_name: 'Проверка' };
const phoneUsers = new WeakMap<Page, Identity>();
function signed(user: Identity) {
  const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: randomUUID(), user: JSON.stringify(user) });
  const check = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const key = createHmac('sha256', 'WebAppData').update(testToken).digest();
  p.set('hash', createHmac('sha256', key).update(check).digest('hex'));
  return p.toString();
}
async function phone(browser: Browser, user?: Identity, width = 390) {
  // The local server trusts its loopback proxy. Model independent phones instead
  // of exhausting one IP's production login limit across unrelated UI scenarios.
  const context = await browser.newContext({ baseURL: origin, viewport: { width, height: 844 }, isMobile: true, hasTouch: true, extraHTTPHeaders: { 'X-Forwarded-For': `198.51.100.${++phoneNumber}` } });
  await context.route('https://telegram.org/js/telegram-web-app.js*', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
  if (user) await context.addInitScript(({ initData }) => {
    const noop = () => {};
    (window as any).Telegram = { WebApp: { initData, platform: 'android', version: '8.0', ready: noop, expand: noop, setHeaderColor: noop, setBackgroundColor: noop, onEvent: noop, offEvent: noop, BackButton: { show: noop, hide: noop, onClick: noop, offClick: noop }, HapticFeedback: { notificationOccurred: noop } } };
  }, { initData: signed(user) });
  const page = await context.newPage();
  if (user) phoneUsers.set(page, user);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  return { context, page, errors };
}
async function profile(page: Page) { await page.getByRole('button', { name: 'Профиль и настройки', exact: true }).click(); }
async function close(page: Page) { await page.getByRole('button', { name: 'Закрыть', exact: true }).click(); }
async function resultOf(page: Page, type: string, action: () => Promise<unknown>) {
  const reply = page.waitForResponse(response => response.url().endsWith('/api/commands') && response.request().postDataJSON()?.type === type);
  await action(); const response = await reply; expect(response.status()).toBe(200); return response.json();
}
async function createVenue(page: Page, name: string) {
  const account = await session(page.request, phoneUsers.get(page)!);
  const created = await createForManager(page.request, account.token, name);
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Гости', exact: true })).toBeVisible();
  return created;
}
async function apiCommand(request: APIRequestContext, token: string, type: string, fields: Record<string, unknown> = {}) {
  const response = await request.post('/api/commands', { headers: { Authorization: `Bearer ${token}` }, data: { type, idempotencyKey: randomUUID(), ...fields } });
  expect(response.status()).toBe(200); return response.json();
}
async function createForManager(request: APIRequestContext, managerToken: string, name: string, details: { kind?: string; address?: string } = {}) {
  const developer = await session(request, developerIdentity);
  const created = await apiCommand(request, developer.token, 'createVenue', { name, kind: 'Кафе', address: 'Тестовая улица, 1', ...details });
  const invitation = await apiCommand(request, developer.token, 'createManagerInvite', { venueId: created.result.venueId });
  await apiCommand(request, managerToken, 'acceptStaffInvite', { code: invitation.result.code });
  return created;
}
async function session(request: APIRequestContext, user: Identity) {
  const response = await request.post('/api/session', { data: { initData: signed(user) } });
  expect(response.status()).toBe(200); return response.json();
}
async function state(request: APIRequestContext, token: string) {
  const response = await request.get('/api/state', { headers: { Authorization: `Bearer ${token}` } });
  expect(response.status()).toBe(200); return response.json();
}

test('320px: browser requires Telegram; verified new profile has no demo data', async ({ browser, request }) => {
  const anonymous = await phone(browser, undefined, 320);
  const logged = await phone(browser, identity('Щ'.repeat(100)), 320);
  try {
    await expect(anonymous.page.getByRole('button', { name: 'Войти через Telegram', exact: true })).toBeVisible();
    expect((await request.get('/api/state')).status()).toBe(401);
    await expect(logged.page.getByRole('button', { name: 'Я владелец заведения', exact: true })).toHaveCount(0);
    await expect(logged.page.getByRole('button', { name: 'Панель разработчика', exact: true })).toHaveCount(0);
    await expect(logged.page.getByRole('button', { name: 'Я гость', exact: true })).toBeVisible();
    await expect(logged.page.getByText('Александр Миронов', { exact: true })).toHaveCount(0);
    await expect(logged.page.getByRole('tab')).toHaveCount(0);
    for (const p of [anonymous.page, logged.page]) expect(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect([...anonymous.errors, ...logged.errors]).toEqual([]);
  } finally { await anonymous.context.close(); await logged.context.close(); }
});

test('developer appoints manager, manager invites staff, guest QR requires explicit visit confirmation', async ({ browser, request }) => {
  test.setTimeout(180000);
  const developer = await phone(browser, developerIdentity, 320);
  const managerIdentity = identity('Руководитель QR'); const staffIdentity = identity('Сотрудник QR'); const guestIdentity = identity('Гость QR');
  const manager = await phone(browser, managerIdentity);
  const staff = await phone(browser, staffIdentity);
  const guest = await phone(browser, guestIdentity, 320);
  try {
    await developer.page.getByRole('button', { name: 'Панель разработчика', exact: true }).click();
    await developer.page.getByRole('button', { name: 'Добавить заведение', exact: true }).click();
    await developer.page.getByLabel('Название заведения', { exact: true }).fill('Место для своих');
    await developer.page.getByLabel('Адрес', { exact: true }).fill('Москва, Лесная, 7');
    const created = await resultOf(developer.page, 'createVenue', () => developer.page.getByRole('button', { name: 'Создать заведение', exact: true }).click());
    expect(created.isDeveloper).toBe(true); expect(created.staffVenues).toEqual([]);
    const managerCode = await resultOf(developer.page, 'createManagerInvite', () => developer.page.getByRole('button', { name: 'Код руководителю · Место для своих', exact: true }).click());
    await expect(developer.page.getByText('Код приглашения руководителя', { exact: true })).toBeVisible();
    await developer.page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { (window as any).__copiedInvite = value; } } });
    });
    await developer.page.getByRole('button', { name: 'Скопировать приглашение руководителя', exact: true }).click();
    await expect(developer.page.getByRole('button', { name: 'Код скопирован', exact: true })).toBeVisible();
    expect(await developer.page.evaluate(() => (window as any).__copiedInvite)).toBe(managerCode.result.code);
    expect(await developer.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await developer.page.screenshot({ path: resolve('../svoi-developer-preview.png') });
    await manager.page.getByRole('button', { name: 'Я сотрудник', exact: true }).click();
    await manager.page.getByLabel('Код приглашения', { exact: true }).fill(managerCode.result.code);
    await manager.page.getByRole('button', { name: 'Принять приглашение', exact: true }).click();
    await profile(manager.page);
    await expect(manager.page.getByRole('button', { name: 'Панель разработчика', exact: true })).toHaveCount(0);
    await manager.page.getByRole('button', { name: 'Управление командой', exact: true }).click();
    const staffCode = await resultOf(manager.page, 'createStaffInvite', () => manager.page.getByRole('button', { name: 'Создать приглашение сотрудника', exact: true }).click());
    await manager.page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Permission denied'); } } });
    });
    await manager.page.getByRole('button', { name: 'Скопировать приглашение сотрудника', exact: true }).click();
    await expect(manager.page.getByText(/Зажмите код выше/)).toBeVisible();
    await staff.page.getByRole('button', { name: 'Я сотрудник', exact: true }).click();
    await staff.page.getByLabel('Код приглашения', { exact: true }).fill(staffCode.result.code);
    await staff.page.getByRole('button', { name: 'Принять приглашение', exact: true }).click();
    const guestAccount = await session(request, guestIdentity);
    await expect(guest.page.getByRole('img', { name: 'Личный QR гостя', exact: true })).toBeVisible();
    const qrScreenshot = await guest.page.getByTestId('guest-qr').screenshot({ path: resolve('../../work/guest-qr-ui.png') });
    const qrPixels = await sharp(qrScreenshot).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(jsQR(new Uint8ClampedArray(qrPixels.data), qrPixels.info.width, qrPixels.info.height)?.data).toBe(guestAccount.guestQr);
    await guest.page.screenshot({ path: resolve('../svoi-guest-qr-preview.png') });
    expect(await guest.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await staff.page.evaluate(() => {
      const target = window as any;
      target.__scanOpened = 0;
      target.Telegram.WebApp.showScanQrPopup = (_options: unknown, callback: (value: string) => boolean) => { target.__scanOpened++; target.__scanGuestCallback = callback; };
      target.Telegram.WebApp.closeScanQrPopup = () => {};
    });
    await staff.page.getByRole('button', { name: 'Сканировать QR гостя', exact: true }).click();
    expect(await staff.page.evaluate(() => (window as any).__scanOpened)).toBe(0);
    await staff.page.getByRole('button', { name: 'Открыть камеру', exact: true }).click();
    expect(await staff.page.evaluate(() => (window as any).__scanOpened)).toBe(1);
    expect(await staff.page.evaluate(() => (window as any).__scanGuestCallback('https://unrelated.example/'))).toBe(false);
    const scanned = await resultOf(staff.page, 'scanGuest', () => staff.page.evaluate(qr => {
      (window as any).__scanGuestCallback(qr);
      (window as any).__scanGuestCallback(qr);
    }, guestAccount.guestQr));
    expect(scanned.result.guestId).toBe(guestAccount.guestId);
    await expect(staff.page.getByText('Гость QR Проверка', { exact: true }).last()).toBeVisible();
    let guestState = await state(request, guestAccount.token);
    expect(guestState.db.memberships).toHaveLength(1); expect(guestState.db.visits).toHaveLength(0); expect(guestState.db.transactions).toHaveLength(0);
    await staff.page.getByLabel('Сумма чека, ₽', { exact: true }).fill('0');
    await staff.page.getByRole('button', { name: 'Сохранить визит', exact: true }).click();
    await expect(staff.page.getByText('Сумма чека: от 0,01 до 1 000 000 ₽.', { exact: true })).toBeVisible();
    expect((await state(request, guestAccount.token)).db.visits).toHaveLength(0);
    await staff.page.getByLabel('Сумма чека, ₽', { exact: true }).fill('900');
    await staff.page.getByLabel('Чаевые, ₽', { exact: true }).fill('0');
    await resultOf(staff.page, 'recordVisit', () => staff.page.getByRole('button', { name: 'Сохранить визит', exact: true }).click());
    guestState = await state(request, guestAccount.token);
    expect(guestState.db.visits).toHaveLength(1); expect(guestState.db.memberships[0].balance).toBe(45);
    await expect(guest.page.getByRole('tab')).toHaveCount(0);
    await guest.page.getByRole('button', { name: 'Открыть заведение Место для своих', exact: true }).click();
    await expect(guest.page.getByText('45 Б', { exact: true }).first()).toBeVisible();
    await close(staff.page);
    await staff.page.getByRole('button', { name: 'Сканировать QR гостя', exact: true }).click();
    await staff.page.getByLabel('Код гостя или текст QR', { exact: true }).fill(guestAccount.guestCode);
    await resultOf(staff.page, 'addGuest', () => staff.page.getByRole('button', { name: 'Найти гостя по коду', exact: true }).click());
    expect((await state(request, guestAccount.token)).db.visits).toHaveLength(1);
    expect([...developer.errors, ...manager.errors, ...staff.errors, ...guest.errors]).toEqual([]);
  } finally { await Promise.all([developer.context.close(), manager.context.close(), staff.context.close(), guest.context.close()]); }
});

test('two phones share visits and reviews while guest cannot read internal notes', async ({ browser, request }) => {
  const ownerId = identity('Владелец'); const guestId = identity('Гость');
  const owner = await phone(browser, ownerId); const guest = await phone(browser, guestId);
  try {
    const created = await createVenue(owner.page, 'Клуб двух телефонов');
    await guest.page.getByLabel('Код клуба', { exact: true }).fill(created.result.joinCode);
    await guest.page.getByRole('button', { name: 'Вступить в клуб', exact: true }).click();
    await expect(guest.page.getByText('0 Б', { exact: true }).first()).toBeVisible();
    await owner.page.getByRole('tab', { name: 'Гости', exact: true }).click();
    await owner.page.getByRole('button', { name: 'Гость Гость Проверка', exact: true }).click();
    await owner.page.getByRole('button', { name: 'Визит', exact: true }).click();
    await owner.page.getByLabel('Сумма чека, ₽', { exact: true }).fill('1000,50');
    await owner.page.getByLabel('Чаевые, ₽', { exact: true }).fill('150');
    await owner.page.getByRole('button', { name: 'Сохранить визит', exact: true }).click();
    await expect(owner.page.getByRole('dialog').getByText('75 Б', { exact: true })).toBeVisible();
    await expect(guest.page.getByText('75 Б', { exact: true }).first()).toBeVisible();
    await owner.page.getByRole('button', { name: 'Добавить', exact: true }).click();
    await owner.page.getByLabel('Комментарий о госте', { exact: true }).fill('Внутренняя заметка только для команды');
    await owner.page.getByRole('button', { name: 'Сохранить заметку', exact: true }).click();
    await expect(owner.page.getByText('Внутренняя заметка только для команды', { exact: true })).toBeVisible();
    await guest.page.getByRole('tab', { name: 'Визиты', exact: true }).click();
    await expect(guest.page.getByText('1 000,5 ₽', { exact: true }).first()).toBeVisible();
    await guest.page.getByRole('button', { name: 'Оставить отзыв', exact: true }).click();
    await guest.page.getByLabel('Ваш отзыв о заведении', { exact: true }).fill('Отзыв с другого телефона');
    await guest.page.getByRole('button', { name: 'Сохранить отзыв', exact: true }).click();
    await close(owner.page); await owner.page.getByRole('tab', { name: 'Отзывы', exact: true }).click();
    await expect(owner.page.getByText('Отзыв с другого телефона', { exact: true })).toBeVisible();
    const guestSession = await session(request, guestId); const guestState = await state(request, guestSession.token);
    expect(guestState.db.notes).toEqual([]); expect(guestState.db.guests).toHaveLength(1);
    expect(guestState.db.visits[0].rating).toBeNull(); expect(guestState.db.reviews).toHaveLength(1);
    expect(guestState.staffVenues).toEqual([]);
    await guest.page.reload();
    await expect(guest.page.getByRole('tab')).toHaveCount(0);
    await guest.page.getByRole('button', { name: 'Открыть заведение Клуб двух телефонов', exact: true }).click();
    await guest.page.getByRole('tab', { name: 'Заведение', exact: true }).click();
    await expect(guest.page.getByText('75 Б', { exact: true }).first()).toBeVisible();
    expect([...owner.errors, ...guest.errors]).toEqual([]);
  } finally { await owner.context.close(); await guest.context.close(); }
});

test('owner invites staff and revocation removes access on another phone', async ({ browser, request }) => {
  const owner = await phone(browser, identity('Управляющий')); const staffId = identity('Официант'); const staff = await phone(browser, staffId);
  try {
    await createVenue(owner.page, 'Команда по приглашению');
    await profile(owner.page); await owner.page.getByRole('button', { name: 'Управление командой', exact: true }).click();
    const invitation = await resultOf(owner.page, 'createStaffInvite', () => owner.page.getByRole('button', { name: 'Создать приглашение сотрудника', exact: true }).click());
    await staff.page.getByRole('button', { name: 'Я сотрудник', exact: true }).click();
    await staff.page.getByLabel('Код приглашения', { exact: true }).fill(invitation.result.code);
    await staff.page.getByRole('button', { name: 'Принять приглашение', exact: true }).click();
    await expect(staff.page.getByRole('tab', { name: 'Гости', exact: true })).toBeVisible();
    await profile(staff.page); await expect(staff.page.getByRole('button', { name: 'Управление командой', exact: true })).toHaveCount(0); await close(staff.page);
    await owner.page.getByRole('button', { name: 'Показать состав команды', exact: true }).click();
    await owner.page.getByRole('button', { name: 'Закрыть доступ: Официант Проверка', exact: true }).click();
    const beforeConfirmation = await session(request, staffId);
    expect(beforeConfirmation.staffVenues).toHaveLength(1);
    await owner.page.getByRole('button', { name: 'Подтвердить закрытие доступа сотрудника', exact: true }).click();
    await expect(staff.page.getByRole('tab', { name: 'Гости', exact: true })).toHaveCount(0);
    const updated = await session(request, staffId); expect(updated.staffVenues).toEqual([]); expect(updated.db.venues).toEqual([]);
    expect([...owner.errors, ...staff.errors]).toEqual([]);
  } finally { await owner.context.close(); await staff.context.close(); }
});

test('mobile connection recovery keeps QR visible and works without AbortSignal.timeout', async ({ browser, request }) => {
  const guestIdentity = identity('Без сети'); const guest = await phone(browser, guestIdentity, 320);
  try {
    await guest.context.addInitScript(() => { Object.defineProperty(AbortSignal, 'timeout', { value: undefined, configurable: true }); });
    await guest.page.reload();
    await expect(guest.page.getByRole('img', { name: 'Личный QR гостя', exact: true })).toBeVisible();
    const guestAccount = await session(request, guestIdentity);
    await guest.context.setOffline(true);
    await expect(guest.page.getByRole('button', { name: 'Повторить синхронизацию', exact: true })).toBeVisible();
    await expect(guest.page.getByText(/Последнее обновление:/)).toBeVisible();
    await guest.page.getByRole('img', { name: 'Личный QR гостя', exact: true }).scrollIntoViewIfNeeded();
    await expect(guest.page.getByRole('img', { name: 'Личный QR гостя', exact: true })).toBeVisible();
    const manager = await session(request, identity('Менеджер связи'));
    const venue = await createForManager(request, manager.token, 'Клуб связи');
    await apiCommand(request, manager.token, 'scanGuest', { venueId: venue.result.venueId, qr: guestAccount.guestQr });
    await apiCommand(request, manager.token, 'recordVisit', { venueId: venue.result.venueId, guestId: guestAccount.guestId, bill: 1000, tips: 0, rating: 5 });
    await guest.context.setOffline(false);
    await expect(guest.page.getByText('50 Б', { exact: true }).first()).toBeVisible();
    await expect(guest.page.getByRole('button', { name: 'Повторить синхронизацию', exact: true })).toHaveCount(0);
    await guest.page.getByRole('button', { name: 'Открыть заведение Клуб связи', exact: true }).click();
    await guest.context.setOffline(true);
    await expect(guest.page.getByRole('button', { name: 'Повторить синхронизацию', exact: true })).toBeVisible();
    await expect(guest.page.getByText('50 Б', { exact: true }).first()).toBeVisible();
    await guest.page.screenshot({ path: resolve('../svoi-connection-preview.png') });
    expect(await guest.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await guest.context.setOffline(false);
    await expect(guest.page.getByRole('button', { name: 'Повторить синхронизацию', exact: true })).toHaveCount(0);
    const final = await state(request, guestAccount.token);
    expect(final.db.visits).toHaveLength(1); expect(final.db.transactions).toHaveLength(1); expect(final.db.memberships[0].balance).toBe(50);
    expect(guest.errors).toEqual([]);
  } finally { await guest.context.close(); }
});

test('POS sandbox exercises both providers without writing fictional visits to live database', async ({ browser, request }) => {
  const user = identity('Интегратор'); const owner = await phone(browser, user);
  try {
    await createVenue(owner.page, 'Изолированные кассы');
    const account = await session(request, user); const before = await state(request, account.token);
    const mutations: string[] = [];
    owner.page.on('request', req => { if (req.url().endsWith('/api/commands')) mutations.push(req.postDataJSON()?.type); });
    await owner.page.getByRole('button', { name: 'Открыть интеграции', exact: true }).click();
    await owner.page.getByRole('button', { name: 'Открыть тестовую песочницу', exact: true }).click();
    for (const provider of ['iiko', 'r_keeper']) {
      await owner.page.getByRole('button', { name: `Демо ${provider}`, exact: true }).click();
      await owner.page.getByRole('button', { name: 'Подготовить тестовый чек', exact: true }).click();
      await owner.page.getByRole('button', { name: 'Обработать чек', exact: true }).click();
      await expect(owner.page.getByText('Чек учтён', { exact: true })).toBeVisible();
      await owner.page.getByRole('button', { name: 'Повтор', exact: true }).click();
      await owner.page.getByRole('button', { name: 'Подготовить тестовый чек', exact: true }).click();
      await owner.page.getByRole('button', { name: 'Обработать чек', exact: true }).click();
      await expect(owner.page.getByText('Повтор защищён', { exact: true })).toBeVisible();
      await owner.page.getByRole('button', { name: 'Закрытый чек', exact: true }).click();
    }
    expect(mutations).toEqual([]); const after = await state(request, account.token); expect(after.db).toEqual(before.db);
    await close(owner.page); await owner.page.getByRole('tab', { name: 'Гости', exact: true }).click();
    await expect(owner.page.getByRole('button', { name: 'Гость Александр Миронов', exact: true })).toHaveCount(0);
    expect(owner.errors).toEqual([]);
  } finally { await owner.context.close(); }
});

test('320px: real POS setup stays a draft, masks keys and limits configuration to each venue owner', async ({ browser, request }) => {
  const ownerIdentity = identity('Кассовый владелец'); const staffIdentity = identity('Кассовый сотрудник');
  const owner = await phone(browser, ownerIdentity, 320); let staff: Awaited<ReturnType<typeof phone>> | undefined;
  try {
    const created = await createVenue(owner.page, 'Настоящие подключения'); const venueId = created.result.venueId;
    const ownerSession = await session(request, ownerIdentity); const staffSession = await session(request, staffIdentity);
    const foreign = await session(request, identity('Другой владелец'));
    const post = (token: string, path: string, data: Record<string, unknown>) => request.post(path, { headers: { Authorization: `Bearer ${token}` }, data });
    const command = (token: string, type: string, data: Record<string, unknown>) => post(token, '/api/commands', { type, idempotencyKey: randomUUID(), ...data });
    const inviteResponse = await command(ownerSession.token, 'createStaffInvite', { venueId }); expect(inviteResponse.status()).toBe(200);
    const invite = await inviteResponse.json();
    expect((await command(staffSession.token, 'acceptStaffInvite', { code: invite.result.code })).status()).toBe(200);
    const otherVenue = await createForManager(request, foreign.token, 'Посторонний клуб');
    const posActions: string[] = [];
    owner.page.on('request', req => { if (req.method() === 'POST' && req.url().includes('/api/pos/')) posActions.push(new URL(req.url()).pathname); });
    await owner.page.getByRole('button', { name: 'Открыть интеграции', exact: true }).click();
    await expect(owner.page.getByText('Кассы пока не подключены', { exact: true })).toBeVisible();
    await expect(owner.page.getByRole('button', { name: 'Подготовить тестовый чек', exact: true })).toHaveCount(0);
    await expect(owner.page.getByText('Александр Миронов', { exact: true })).toHaveCount(0);
    await owner.page.getByRole('button', { name: 'Настроить iiko', exact: true }).click();
    await owner.page.getByLabel('iiko: organizationId', { exact: true }).fill('invalid-scope');
    await owner.page.getByLabel('iiko: terminalGroupIds', { exact: true }).fill('22222222-2222-4222-8222-222222222222');
    await owner.page.getByLabel('iiko: appId', { exact: true }).fill('local-ui-test-app');
    await owner.page.getByLabel('iiko: clientSecret', { exact: true }).fill('FAKE-LOCAL-UI-SECRET-NEVER-DEPLOY');
    await owner.page.getByLabel('iiko: API-ключ', { exact: true }).fill('FAKE-LOCAL-UI-API-KEY-NEVER-DEPLOY');
    for (const label of ['iiko: clientSecret', 'iiko: API-ключ']) await expect(owner.page.getByLabel(label, { exact: true })).toHaveAttribute('type', 'password');
    const badSave = owner.page.waitForResponse(response => response.url().endsWith('/api/pos/configure'));
    await owner.page.getByRole('button', { name: 'Сохранить подключение', exact: true }).click(); expect((await badSave).status()).toBe(400);
    await expect(owner.page.getByText('Проверьте формат ключей, идентификаторов и полей кассы', { exact: true })).toBeVisible();
    await owner.page.getByLabel('iiko: organizationId', { exact: true }).fill('11111111-1111-4111-8111-111111111111');
    const goodSave = owner.page.waitForResponse(response => response.url().endsWith('/api/pos/configure'));
    await owner.page.getByRole('button', { name: 'Сохранить подключение', exact: true }).click();
    const savedResponse = await goodSave; expect(savedResponse.status()).toBe(200); const saved = await savedResponse.json();
    await expect(owner.page.getByText('Требуется настройка', { exact: true })).toBeVisible();
    await expect(owner.page.getByRole('button', { name: 'Включить обмен iiko', exact: true })).toBeDisabled();
    expect(posActions).toEqual(['/api/pos/configure', '/api/pos/configure']);
    const statusResponse = await request.get(`/api/pos/status?venueId=${venueId}`, { headers: { Authorization: `Bearer ${ownerSession.token}` } });
    expect(statusResponse.status()).toBe(200); const status = await statusResponse.json();
    expect(status.receipts).toEqual([]); expect(status.connections).toHaveLength(1); expect(status.connections[0].enabled).toBe(false); expect(status.connections[0].verifiedAt).toBeNull();
    expect(JSON.stringify(status)).not.toContain('FAKE-LOCAL-UI');
    expect((await state(request, ownerSession.token)).db.visits).toEqual([]);
    expect((await post(ownerSession.token, '/api/pos/enabled', { connectionId: saved.connectionId, enabled: true })).status()).toBe(409);
    await owner.page.getByRole('button', { name: 'Параметры вебхука iiko', exact: true }).click();
    await expect(owner.page.getByLabel('Адрес вебхука', { exact: true })).toHaveValue(`${origin}/api/pos/webhooks/iiko/${saved.connectionId}`);
    await expect(owner.page.getByLabel('Токен вебхука — секрет', { exact: true })).toHaveAttribute('type', 'password');
    await owner.page.getByRole('button', { name: 'Показать токен для копирования', exact: true }).click();
    await expect(owner.page.getByLabel('Токен вебхука — секрет', { exact: true })).toHaveJSProperty('type', 'text');
    await owner.page.getByRole('button', { name: 'Скрыть токен', exact: true }).click();
    await expect(owner.page.getByLabel('Токен вебхука — секрет', { exact: true })).toHaveAttribute('type', 'password');
    await owner.page.getByRole('button', { name: 'Скрыть параметры', exact: true }).click();
    await expect(owner.page.getByLabel('Токен вебхука — секрет', { exact: true })).toHaveCount(0);
    const storage = await owner.page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    expect(storage).not.toContain('FAKE-LOCAL-UI');
    await owner.page.getByRole('button', { name: 'Открыть тестовую песочницу', exact: true }).scrollIntoViewIfNeeded();
    expect(await owner.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await owner.page.screenshot({ path: resolve('../../work/pos-connections-320.png') });
    staff = await phone(browser, staffIdentity, 320);
    await staff.page.getByRole('button', { name: 'Открыть интеграции', exact: true }).click();
    await expect(staff.page.getByText('Требуется настройка', { exact: true })).toBeVisible();
    await expect(staff.page.getByRole('button', { name: 'Настроить iiko', exact: true })).toHaveCount(0);
    await expect(staff.page.getByRole('button', { name: 'Проверить iiko', exact: true })).toHaveCount(0);
    await expect(staff.page.getByRole('button', { name: 'Параметры вебхука iiko', exact: true })).toHaveCount(0);
    for (const [path, data] of [
      ['configure', { venueId, provider: 'iiko', config: {} }], ['probe', { connectionId: saved.connectionId }],
      ['enabled', { connectionId: saved.connectionId, enabled: true }], ['webhook-setup', { connectionId: saved.connectionId }],
    ] as [string, Record<string, unknown>][]) expect((await post(staffSession.token, `/api/pos/${path}`, data)).status()).toBe(403);
    expect((await request.get(`/api/pos/status?venueId=${otherVenue.result.venueId}`, { headers: { Authorization: `Bearer ${ownerSession.token}` } })).status()).toBe(403);
    expect((await request.get(`/api/pos/status?venueId=${venueId}`, { headers: { Authorization: `Bearer ${foreign.token}` } })).status()).toBe(403);
    expect((await post(foreign.token, '/api/pos/webhook-setup', { connectionId: saved.connectionId })).status()).toBe(403);
    expect([...owner.errors, ...staff.errors]).toEqual([]);
  } finally { await owner.context.close(); await staff?.context.close(); }
});

test('lost award response remains idempotent after closing form and after page reload', async ({ browser, request }) => {
  const ownerIdentity = identity('Повтор'); const guestIdentity = identity('Получатель'); const owner = await phone(browser, ownerIdentity);
  try {
    const venue = await createVenue(owner.page, 'Проверка повторов');
    const account = await session(request, ownerIdentity); const guest = await session(request, guestIdentity);
    const added = await request.post('/api/commands', { headers: { Authorization: `Bearer ${account.token}` }, data: { type: 'addGuest', idempotencyKey: randomUUID(), venueId: venue.result.venueId, guestCode: guest.guestCode } });
    expect(added.status()).toBe(200);
    const openAward = async (amount: string) => {
      await owner.page.getByRole('tab', { name: 'Гости', exact: true }).click();
      await owner.page.getByRole('button', { name: 'Гость Получатель Проверка', exact: true }).click();
      await owner.page.getByRole('button', { name: 'Бонусы', exact: true }).click();
      await owner.page.getByLabel('Количество бонусов', { exact: true }).fill(amount);
    };
    const dropNext = new Set([100, 200]); let rateLimitNext = false;
    await owner.page.route('**/api/commands', async route => {
      const command = route.request().postDataJSON();
      if (command.type === 'awardBonus' && command.amount === 200 && rateLimitNext) {
        rateLimitNext = false;
        await route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: 'Тест: слишком много запросов' }) }); return;
      }
      if (command.type === 'awardBonus' && dropNext.delete(command.amount)) {
        const response = await route.fetch(); expect(response.status()).toBe(200);
        if (command.amount === 200) rateLimitNext = true;
        await route.abort('connectionfailed');
      } else await route.continue();
    });
    await openAward('100'); await owner.page.getByRole('button', { name: 'Подарить бонусы', exact: true }).click();
    await expect(owner.page.getByText(/Нет связи с сервером/).last()).toBeVisible();
    await close(owner.page); await openAward('100');
    await owner.page.getByRole('button', { name: 'Подарить бонусы', exact: true }).click();
    await expect(owner.page.getByRole('dialog').getByText('100 Б', { exact: true })).toBeVisible();
    await close(owner.page); await openAward('200');
    await owner.page.getByRole('button', { name: 'Подарить бонусы', exact: true }).click();
    await expect(owner.page.getByText(/Нет связи с сервером/).last()).toBeVisible();
    await owner.page.getByRole('button', { name: 'Подарить бонусы', exact: true }).click();
    await expect(owner.page.getByText('Тест: слишком много запросов', { exact: true })).toBeVisible();
    await owner.page.reload(); await openAward('200');
    await owner.page.getByRole('button', { name: 'Подарить бонусы', exact: true }).click();
    await expect(owner.page.getByRole('dialog').getByText('300 Б', { exact: true })).toBeVisible();
    const updated = await state(request, guest.token);
    expect(updated.db.memberships[0].balance).toBe(300); expect(updated.db.transactions).toHaveLength(2);
    expect(owner.errors).toEqual([]);
  } finally { await owner.context.close(); }
});

test('320px: developer publishes individual venue cards, guest chooses first and keeps venue data separate', async ({ browser, request }) => {
  test.setTimeout(180000);
  const developer = await phone(browser, developerIdentity, 320);
  const guestIdentity = identity('Амиго'); const guest = await phone(browser, guestIdentity, 320);
  const admin = await session(request, developerIdentity);
  const manager = await session(request, identity('Руководитель двух мест'));
  const guestAccount = await session(request, guestIdentity);
  const firstName = 'Эль Пастор'; const secondName = 'Клуб с отдельной программой';
  const first = await createForManager(request, manager.token, firstName, { kind: 'Мексиканский гастробар', address: 'Симферополь, ул. Ушинского, 4' });
  const second = await createForManager(request, manager.token, secondName);
  const firstId = first.result.venueId; const secondId = second.result.venueId;
  const firstTerms = 'Тестовая карточка: условия клуба согласуются отдельно.';
  const secondTerms = 'В этом клубе действует своя программа и отдельный бонусный счёт.';
  const secondProfile = { published: true, demo: false, theme: 'svoi', tagline: 'Своя история, свои бонусы', description: 'Другое место с независимой программой.', highlights: ['Кофе и встречи'], terms: secondTerms, links: {}, features: { loyalty: true, visits: true, reviews: true } };
  try {
    await developer.page.getByRole('button', { name: 'Панель разработчика', exact: true }).click();
    await developer.page.getByRole('button', { name: `Карточка для гостей · ${firstName}`, exact: true }).click();
    await developer.page.getByRole('switch', { name: 'Показывать в каталоге', exact: true }).click();
    await developer.page.getByRole('switch', { name: 'Тестовая карточка', exact: true }).click();
    await developer.page.getByRole('button', { name: 'Эль Пастор · бордо', exact: true }).click();
    await developer.page.getByLabel('Короткая фраза на карточке', { exact: true }).fill('Мексиканская кухня · гастроужины · музыка');
    await developer.page.getByLabel('Описание заведения', { exact: true }).fill('Hola, amigo. Мексиканский гастробар на улице Ушинского в Симферополе: мексиканская кухня, гастроужины и музыкальные вечера.');
    await developer.page.getByLabel('Особенности — каждая с новой строки', { exact: true }).fill('Мексиканская кухня\nГастроужины\nМузыкальные вечера');
    await developer.page.getByLabel('Условия для гостей', { exact: true }).fill(firstTerms);
    for (const name of ['Бонусная программа', 'Визиты гостей', 'Отзывы гостей']) await developer.page.getByRole('switch', { name, exact: true }).click();
    await developer.page.getByLabel('Ссылка на бронирование', { exact: true }).fill('javascript:alert(1)');
    await developer.page.getByRole('button', { name: 'Сохранить карточку заведения', exact: true }).click();
    await expect(developer.page.getByText('Ссылка на бронирование: укажите полный адрес https:// без логина и пароля.', { exact: true })).toBeVisible();
    expect((await state(request, guestAccount.token)).catalog.some((venue: any) => venue.id === firstId)).toBe(false);
    await developer.page.getByLabel('Ссылка на бронирование', { exact: true }).fill('https://elp.restoplace.ws/');
    await developer.page.getByLabel('Telegram заведения', { exact: true }).fill('https://t.me/ElPastorBar');
    await resultOf(developer.page, 'updateVenueProfile', () => developer.page.getByRole('button', { name: 'Сохранить карточку заведения', exact: true }).click());
    await expect(developer.page.getByText('Карточка сохранена и доступна в каталоге гостей.', { exact: true })).toBeVisible();
    await apiCommand(request, admin.token, 'updateVenueProfile', { venueId: secondId, guestProfile: secondProfile });
    const current = await state(request, guestAccount.token);
    const firstCard = current.catalog.find((venue: any) => venue.id === firstId);
    expect(firstCard.guestProfile).toMatchObject({ published: true, demo: true, theme: 'elpastor', terms: firstTerms, features: { loyalty: false, visits: false, reviews: false } });
    expect(current.db.memberships).toEqual([]); expect(current.db.venues).toEqual([]);
    expect(current.catalog.every((venue: any) => !('joinCode' in venue) && !('managers' in venue))).toBe(true);

    await guest.page.reload();
    await expect(guest.page.getByRole('button', { name: `Открыть заведение ${firstName}`, exact: true })).toBeVisible();
    await expect(guest.page.getByRole('button', { name: `Открыть заведение ${secondName}`, exact: true })).toBeVisible();
    await expect(guest.page.getByRole('tab')).toHaveCount(0);
    const art = guest.page.getByTestId('elpastor-art');
    await expect(art.getByText('ПАСТОР', { exact: true })).toBeVisible();
    await expect(art.locator('img')).toHaveCount(0);
    expect(await guest.page.evaluate(() => document.fonts.check('53px CormorantGaramondBold', 'ПАСТОР'))).toBe(true);
    const glow = art.locator('[data-fx="elpastor-glow"]');
    await expect(glow).toHaveCSS('animation-name', 'elpastor-glow');
    const before = await glow.evaluate(element => getComputedStyle(element).transform);
    await expect.poll(() => glow.evaluate(element => getComputedStyle(element).transform)).not.toBe(before);
    await guest.page.screenshot({ path: resolve('../../work/catalog-320.png'), animations: 'disabled' });
    expect(await guest.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await guest.page.getByRole('button', { name: `Открыть заведение ${firstName}`, exact: true }).click();
    await expect(guest.page.getByRole('tab', { name: 'Заведение', exact: true })).toBeVisible();
    await expect(guest.page.getByRole('tab')).toHaveCount(1);
    await expect(guest.page.getByText(firstTerms, { exact: true })).toBeVisible();
    await expect(guest.page.getByText(secondTerms, { exact: true })).toHaveCount(0);
    await expect(guest.page.getByRole('button', { name: 'Забронировать стол', exact: true })).toBeVisible();
    await expect(guest.page.getByTestId('elpastor-club-page')).toBeVisible();
    await guest.page.screenshot({ path: resolve('../../work/elpastor-club-320.png'), animations: 'disabled' });
    await guest.page.setViewportSize({ width: 390, height: 844 });
    expect(await guest.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await guest.page.screenshot({ path: resolve('../../work/elpastor-club-390.png'), animations: 'disabled' });
    await guest.page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(guest.page.getByTestId('elpastor-art').locator('[data-fx="elpastor-glow"]')).toHaveCSS('animation-name', 'none');
    expect(await guest.page.getByTestId('elpastor-art').evaluate(element => getComputedStyle(element, '::after').animationName)).toBe('none');
    await guest.page.emulateMedia({ reducedMotion: 'no-preference' });
    await guest.page.setViewportSize({ width: 320, height: 844 });
    await expect(guest.page.getByRole('button', { name: 'Афиша и новости', exact: true })).toBeVisible();
    await expect(guest.page.getByRole('button', { name: 'Открыть мои бонусы', exact: true })).toHaveCount(0);
    // Decode the pixels guests actually see: styling must not change the opaque
    // payload or reduce contrast/quiet zones on either common phone width.
    for (const width of [320, 390]) {
      await guest.page.setViewportSize({ width, height: 844 });
      await guest.page.getByRole('button', { name: 'Мой QR', exact: true }).click();
      await expect(guest.page.getByTestId('elpastor-qr-card')).toBeVisible();
      const qr = guest.page.getByRole('dialog').getByRole('img', { name: 'Личный QR гостя', exact: true });
      await expect(qr).toBeVisible();
      const bounds = await qr.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      const pixels = await sharp(await qr.screenshot()).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      expect(jsQR(new Uint8ClampedArray(pixels.data), pixels.info.width, pixels.info.height)?.data).toBe(guestAccount.guestQr);
      expect(await guest.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await guest.page.screenshot({ path: resolve(`../../work/elpastor-club-qr-${width}.png`), animations: 'disabled' });
      await close(guest.page);
      await expect(guest.page.getByRole('dialog')).toHaveCount(0);
    }
    await guest.page.setViewportSize({ width: 320, height: 844 });
    expect((await state(request, guestAccount.token)).db.memberships).toEqual([]);
    await guest.page.getByRole('button', { name: 'Все заведения', exact: true }).click();
    await expect(guest.page.getByRole('tab')).toHaveCount(0);
    await expect(guest.page.getByTestId('elpastor-club-page')).toHaveCount(0);
    await guest.page.getByRole('button', { name: `Открыть заведение ${secondName}`, exact: true }).click();
    await expect(guest.page.getByTestId('elpastor-club-page')).toHaveCount(0);
    await expect(guest.page.getByRole('tab')).toHaveCount(4);
    await expect(guest.page.getByText(secondTerms, { exact: true })).toBeVisible();
    await expect(guest.page.getByText(firstTerms, { exact: true })).toHaveCount(0);
    await expect(guest.page.getByRole('button', { name: 'Забронировать стол', exact: true })).toHaveCount(0);
    expect((await state(request, guestAccount.token)).db.memberships).toEqual([]);
    await guest.page.getByRole('button', { name: 'Мой QR', exact: true }).click();
    await expect(guest.page.getByTestId('elpastor-qr-card')).toHaveCount(0);
    const plainQr = guest.page.getByRole('dialog').getByRole('img', { name: 'Личный QR гостя', exact: true });
    const plainPixels = await sharp(await plainQr.screenshot()).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(jsQR(new Uint8ClampedArray(plainPixels.data), plainPixels.info.width, plainPixels.info.height)?.data).toBe(guestAccount.guestQr);
    await close(guest.page);

    // Enrollment is an explicit staff action, never a side effect of browsing.
    for (const venueId of [firstId, secondId]) await apiCommand(request, manager.token, 'scanGuest', { venueId, qr: guestAccount.guestQr });
    await apiCommand(request, manager.token, 'recordVisit', { venueId: secondId, guestId: guestAccount.guestId, bill: 2000, tips: 0, rating: 5 });
    await expect(guest.page.getByText('100 Б', { exact: true }).first()).toBeVisible();
    await guest.page.getByRole('tab', { name: 'Визиты', exact: true }).click();
    await expect(guest.page.getByText('2 000 ₽', { exact: true }).first()).toBeVisible();
    await guest.page.getByRole('button', { name: 'Оставить отзыв', exact: true }).click();
    await expect(guest.page.getByLabel('Ваш отзыв о заведении', { exact: true })).toBeVisible();
    await close(guest.page);
    await guest.page.getByRole('button', { name: 'Все заведения', exact: true }).click();
    await guest.page.getByRole('button', { name: `Открыть заведение ${firstName}`, exact: true }).click();
    await expect(guest.page.getByRole('tab')).toHaveCount(1);
    await expect(guest.page.getByText('100 Б', { exact: true })).toHaveCount(0);
    await expect(guest.page.getByText('2 000 ₽', { exact: true })).toHaveCount(0);
    await guest.page.reload();
    await expect(guest.page.getByRole('tab')).toHaveCount(0);
    await expect(guest.page.getByRole('button', { name: `Открыть заведение ${firstName}`, exact: true })).toBeVisible();
    const final = await state(request, guestAccount.token);
    expect(final.db.memberships.find((item: any) => item.venueId === firstId).balance).toBe(0);
    expect(final.db.memberships.find((item: any) => item.venueId === secondId).balance).toBe(100);
    expect(final.db.visits).toHaveLength(1); expect(final.db.visits[0].venueId).toBe(secondId);
    expect([...developer.errors, ...guest.errors]).toEqual([]);
  } finally {
    // Keep publication state local to this scenario so standalone and full runs agree.
    const latest = await state(request, admin.token);
    for (const venueId of [firstId, secondId]) {
      const card = latest.catalog.find((item: any) => item.id === venueId);
      if (card) await apiCommand(request, admin.token, 'updateVenueProfile', { venueId, guestProfile: { ...card.guestProfile, published: false } });
    }
    await developer.context.close(); await guest.context.close();
  }
});
