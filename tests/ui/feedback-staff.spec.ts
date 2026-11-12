import { test, expect, APIRequestContext, Browser, Page } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

const origin = 'http://127.0.0.1:8097';
const testToken = '123456:local-live-test-secret-do-not-deploy';
let counter = Date.now() + 100000; let phones = 170;
type Identity = { id: number; first_name: string };
const identity = (first_name: string): Identity => ({ id: ++counter, first_name });
function signed(user: Identity) {
  const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: randomUUID(), user: JSON.stringify(user) });
  const check = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n');
  const key = createHmac('sha256', 'WebAppData').update(testToken).digest();
  p.set('hash', createHmac('sha256', key).update(check).digest('hex')); return p.toString();
}
async function session(request: APIRequestContext, user: Identity) { const response = await request.post('/api/session', { data: { initData: signed(user) } }); expect(response.status()).toBe(200); return response.json(); }
async function command(request: APIRequestContext, token: string, type: string, fields: Record<string, unknown>) { const response = await request.post('/api/commands', { headers: { Authorization: `Bearer ${token}` }, data: { type, idempotencyKey: randomUUID(), ...fields } }); expect(response.status(), await response.text()).toBe(200); return response.json(); }
async function state(request: APIRequestContext, token: string) { const response = await request.get('/api/state', { headers: { Authorization: `Bearer ${token}` }, maxRetries: 1 }); expect(response.status()).toBe(200); return response.json(); }
async function setup(request: APIRequestContext, name: string) {
  const admin = await session(request, { id: 900000001, first_name: 'Разработчик' }); const managerIdentity = identity('Команда анкет'); const manager = await session(request, managerIdentity); const guest = await session(request, identity('Гость анкет'));
  const created = await command(request, admin.token, 'createVenue', { name, kind: 'Кафе', address: 'Тестовый адрес' }); const venueId = created.result.venueId;
  await command(request, admin.token, 'updateVenueProfile', { venueId, guestProfile: { published: true, demo: false, theme: 'svoi', feedbackEnabled: true, tagline: 'Место для своих', description: '', highlights: [], terms: '', links: {}, features: { loyalty: false, visits: false, reviews: false } } });
  const invitation = await command(request, admin.token, 'createManagerInvite', { venueId }); await command(request, manager.token, 'acceptStaffInvite', { code: invitation.result.code });
  return { managerIdentity, manager, guest, venueId };
}
async function phone(browser: Browser, user: Identity, width = 320) {
  const context = await browser.newContext({ baseURL: origin, viewport: { width, height: 744 }, isMobile: true, hasTouch: true, extraHTTPHeaders: { 'X-Forwarded-For': `198.51.100.${++phones}` } });
  await context.route('https://telegram.org/js/telegram-web-app.js*', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
  await context.addInitScript(initData => { const noop = () => {}; (window as any).Telegram = { WebApp: { initData, platform: 'android', version: '8.0', ready: noop, expand: noop, setHeaderColor: noop, setBackgroundColor: noop, onEvent: noop, offEvent: noop, BackButton: { show: noop, hide: noop, onClick: noop, offClick: noop }, HapticFeedback: { notificationOccurred: noop } } }; }, signed(user));
  const page = await context.newPage(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); await page.goto('/'); return { context, page, errors };
}
async function scan(page: Page, code: string) { await page.getByRole('button', { name: 'Сканировать QR гостя', exact: true }).click(); await page.getByLabel('Код гостя или текст QR', { exact: true }).fill(code); await page.getByRole('button', { name: 'Найти гостя по коду', exact: true }).click(); await expect(page.getByText('Предпочтения гостя', { exact: true })).toBeVisible(); }
async function fillSurvey(page: Page, comment: string) { await page.getByRole('button', { name: 'Завершить визит', exact: true }).click(); await page.getByRole('checkbox', { name: 'Тихое место', exact: true }).click(); await page.getByRole('radio', { name: 'Приятное общение', exact: true }).click(); await page.getByLabel('Заметка для команды · необязательно', { exact: true }).fill(comment); }
async function resultOf(page: Page, type: string, action: () => Promise<unknown>) { const reply = page.waitForResponse(response => response.url().endsWith('/api/commands') && response.request().postDataJSON()?.type === type); await action(); const response = await reply; expect(response.status()).toBe(200); return response.json(); }

test('320px staff: QR opens private profile; small questionnaire records visit without finance or POS actions', async ({ browser, request }) => {
  const { managerIdentity, manager, guest, venueId } = await setup(request, 'Тихое место · анкеты'); const view = await phone(browser, managerIdentity);
  try {
    await expect(view.page.getByRole('tab', { name: 'Смена', exact: true })).toBeVisible();
    expect(await view.page.getByRole('tab').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')))).toEqual(['Смена', 'Гости', 'Отзывы']);
    await expect(view.page.getByRole('button', { name: /бонус|iiko|r_keeper|Waiter/i })).toHaveCount(0);
    await scan(view.page, guest.guestCode);
    expect((await state(request, manager.token)).db.feedbackVisits).toHaveLength(0);
    await expect(view.page.getByTestId('guest-visit-count').getByText('0', { exact: true })).toBeVisible();
    await expect(view.page.getByLabel('Номер стола', { exact: true })).toHaveCount(0);
    await view.page.getByRole('button', { name: 'Завершить визит', exact: true }).click();
    await expect(view.page.getByRole('button', { name: 'Сохранить визит и заметку', exact: true })).toBeDisabled();
    await expect(view.page.getByRole('checkbox')).toHaveCount(8);
    await view.page.getByRole('checkbox', { name: 'Неострые блюда', exact: true }).click(); await view.page.getByRole('checkbox', { name: 'Тихое место', exact: true }).click();
    await view.page.getByRole('radio', { name: 'Приятное общение', exact: true }).click();
    const input = view.page.getByLabel('Заметка для команды · необязательно', { exact: true }); await input.fill('Попросил подать напиток после еды. Учитывать при следующем визите.');
    await expect(input).toHaveValue('Попросил подать напиток после еды. Учитывать при следующем визите.'); expect(await input.evaluate(element => element.getBoundingClientRect().height >= 100)).toBe(true);
    expect(await view.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await view.page.getByRole('button', { name: 'Сохранить визит и заметку', exact: true }).scrollIntoViewIfNeeded();
    await view.page.screenshot({ path: resolve('../svoi-feedback-staff-320.png') });
    const saved = await resultOf(view.page, 'recordFeedbackVisit', () => view.page.getByRole('button', { name: 'Сохранить визит и заметку', exact: true }).click());
    expect(saved.db.feedbackVisits).toHaveLength(1); expect(saved.db.staffFeedback).toHaveLength(1); expect(saved.db.staffFeedback[0]).toMatchObject({ venueId, guestId: guest.guestId, preferences: ['Неострые блюда', 'Тихое место'], experience: 'pleasant' });
    expect(saved.db.visits).toHaveLength(0); expect(saved.db.transactions).toHaveLength(0);
    await expect(view.page.getByTestId('guest-visit-count').getByText('1', { exact: true })).toBeVisible(); await expect(view.page.getByText('Попросил подать напиток после еды. Учитывать при следующем визите.', { exact: true })).toBeVisible();
    const guestState = await state(request, guest.token); expect(guestState.db.feedbackVisits).toHaveLength(1); expect(guestState.db.staffFeedback).toEqual([]); expect(JSON.stringify(guestState)).not.toContain('Попросил подать напиток');
    await view.page.getByRole('button', { name: 'Закрыть', exact: true }).click(); await view.page.getByRole('button', { name: 'Профиль и настройки', exact: true }).click();
    await expect(view.page.getByRole('button', { name: 'Управление командой', exact: true })).toBeVisible(); await expect(view.page.getByRole('button', { name: /бонус|iiko|r_keeper|Waiter|Столы/i })).toHaveCount(0);
    expect(view.errors).toEqual([]);
  } finally { await view.context.close(); }
});

test('staff questionnaire: lost save response retries same request, later explicit visit gets a new identity', async ({ browser, request }) => {
  const { managerIdentity, manager, guest, venueId } = await setup(request, 'Повтор анкеты'); const view = await phone(browser, managerIdentity, 390); const inputs: any[] = [];
  try {
    await view.page.route('**/api/commands', async route => { const input = route.request().postDataJSON(); if (input.type !== 'recordFeedbackVisit') return route.continue(); inputs.push(input); if (inputs.length === 1) { const response = await route.fetch(); expect(response.status()).toBe(200); await route.abort('failed'); } else await route.continue(); });
    await scan(view.page, guest.guestCode); await fillSurvey(view.page, 'Любит спокойную подачу.');
    await view.page.getByRole('button', { name: 'Сохранить визит и заметку', exact: true }).click(); await expect(view.page.getByText('Нет связи с сервером. Проверьте интернет и повторите попытку.', { exact: true })).toBeVisible();
    await expect(view.page.getByLabel('Заметка для команды · необязательно', { exact: true })).not.toBeEditable(); await expect(view.page.getByRole('checkbox', { name: 'Тихое место', exact: true })).toBeDisabled();
    const saved = await resultOf(view.page, 'recordFeedbackVisit', () => view.page.getByRole('button', { name: 'Проверить сохранение анкеты', exact: true }).click());
    expect(inputs[0]).toEqual(inputs[1]); expect(saved.db.feedbackVisits).toHaveLength(1); expect(saved.db.staffFeedback).toHaveLength(1);
    await fillSurvey(view.page, 'Любит спокойную подачу.'); const second = await resultOf(view.page, 'recordFeedbackVisit', () => view.page.getByRole('button', { name: 'Сохранить визит и заметку', exact: true }).click());
    expect(inputs[2].previousVisitId).toBe(saved.result.visitId); expect(inputs[2].idempotencyKey).not.toBe(inputs[0].idempotencyKey); expect(second.result.visitId).not.toBe(saved.result.visitId); expect(second.db.feedbackVisits).toHaveLength(2);
    const own = await state(request, manager.token); expect(own.db.feedbackVisits.filter((visit: any) => visit.venueId === venueId)).toHaveLength(2); expect(view.errors).toEqual([]);
  } finally { await view.context.close(); }
});

test('staff reviews: team replies to guest questionnaire and retains historical notes and reviews', async ({ browser, request }) => {
  const { managerIdentity, manager, guest, venueId } = await setup(request, 'Диалог с гостем');
  await command(request, manager.token, 'scanGuest', { venueId, qr: guest.guestQr }); const visit = await command(request, manager.token, 'recordFeedbackVisit', { venueId, guestId: guest.guestId, preferences: ['Не торопить'], experience: 'neutral', comment: 'Внутренний комментарий' });
  const feedback = await command(request, guest.token, 'submitGuestFeedback', { venueId, visitId: visit.result.visitId, answers: { food: 'liked', service: 'disliked', atmosphere: 'liked', cleanliness: 'liked', value: 'not_used' }, comment: 'Спасибо за ужин, хотелось бы меньше ждать.' });
  const view = await phone(browser, managerIdentity);
  try {
    // Migration display fixture: old records remain readable, while all new
    // questionnaire operations above and below use the real isolated backend.
    await view.context.route('**/api/**', async route => { const response = await route.fetch(); const body = await response.json(); if (body.db && body.user?.id === managerIdentity.id) { body.db.notes.push({ id: 'legacy-note', venueId, guestId: guest.guestId, text: 'Старая заметка команды', kind: 'note', createdAt: new Date().toISOString(), author: 'Команда' }); body.db.reviews.push({ id: 'legacy-review', venueId, guestId: guest.guestId, visitId: 'legacy-visit', text: 'Старый отзыв гостя', rating: 5, createdAt: new Date().toISOString(), response: 'Ранний ответ команды' }); } await route.fulfill({ response, json: body }); });
    await view.page.reload(); await view.page.getByRole('tab', { name: 'Отзывы', exact: true }).click();
    await expect(view.page.getByText('Старый отзыв гостя', { exact: true })).toBeVisible(); await expect(view.page.getByText('Ранний ответ команды', { exact: true })).toBeVisible();
    await view.page.getByRole('button', { name: 'Ответить гостю', exact: true }).click(); await view.page.getByLabel('Ответ гостю', { exact: true }).fill('Спасибо, учтём ваше пожелание к скорости.');
    await resultOf(view.page, 'replyGuestFeedback', () => view.page.getByRole('button', { name: 'Сохранить ответ гостю', exact: true }).click());
    expect((await state(request, guest.token)).db.guestFeedback.find((item: any) => item.id === feedback.result.feedbackId).response).toBe('Спасибо, учтём ваше пожелание к скорости.');
    await view.page.getByRole('tab', { name: 'Смена', exact: true }).click(); await scan(view.page, guest.guestCode); await expect(view.page.getByText('Старая заметка команды', { exact: true })).toBeVisible();
    await expect(view.page.getByText('Внутренний комментарий', { exact: true })).toBeVisible(); expect(await view.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(view.errors).toEqual([]);
  } finally { await view.context.close(); }
});
