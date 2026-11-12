import { test, expect, APIRequestContext, Browser } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { feedbackQuestions } from '../../src/feedback';

const origin = 'http://127.0.0.1:8097';
const testToken = '123456:local-live-test-secret-do-not-deploy';
let counter = Date.now();
let phones = 100;
type Identity = { id: number; first_name: string };
const identity = (first_name: string): Identity => ({ id: ++counter, first_name });
const developer: Identity = { id: 900000001, first_name: 'Разработчик' };
function signed(user: Identity) {
  const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: randomUUID(), user: JSON.stringify(user) });
  const check = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n');
  const key = createHmac('sha256', 'WebAppData').update(testToken).digest();
  p.set('hash', createHmac('sha256', key).update(check).digest('hex')); return p.toString();
}
async function session(request: APIRequestContext, user: Identity) {
  const response = await request.post('/api/session', { data: { initData: signed(user) } });
  expect(response.status()).toBe(200); return response.json();
}
async function command(request: APIRequestContext, token: string, type: string, fields: Record<string, unknown>) {
  const response = await request.post('/api/commands', { headers: { Authorization: `Bearer ${token}` }, data: { type, idempotencyKey: randomUUID(), ...fields } });
  expect(response.status(), await response.text()).toBe(200); return response.json();
}
async function state(request: APIRequestContext, token: string) {
  const response = await request.get('/api/state', { headers: { Authorization: `Bearer ${token}` } });
  expect(response.status()).toBe(200); return response.json();
}
async function phone(browser: Browser, user: Identity, width: number) {
  const context = await browser.newContext({ baseURL: origin, viewport: { width, height: 844 }, isMobile: true, hasTouch: true, extraHTTPHeaders: { 'X-Forwarded-For': `198.51.100.${++phones}` } });
  await context.route('https://telegram.org/js/telegram-web-app.js*', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
  await context.addInitScript(initData => {
    const noop = () => {};
    (window as any).Telegram = { WebApp: { initData, platform: 'android', version: '8.0', ready: noop, expand: noop, setHeaderColor: noop, setBackgroundColor: noop, onEvent: noop, offEvent: noop, BackButton: { show: noop, hide: noop, onClick: noop, offClick: noop }, HapticFeedback: { notificationOccurred: noop } } };
  }, signed(user));
  const page = await context.newPage(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); return { context, page, errors };
}

for (const [theme, width] of [['svoi', 390], ['elpastor', 320]] as const) test(`${width}px ${theme}: confirmed visit → private guest questionnaire → team response; no financial actions`, async ({ browser, request }) => {
  const admin = await session(request, developer);
  const manager = await session(request, identity('Команда'));
  const user = identity('Анна'); const guest = await session(request, user);
  const venueName = theme === 'elpastor' ? 'Эль Пастор · анкеты' : 'Кофейня · анкеты';
  const created = await command(request, admin.token, 'createVenue', { name: venueName, kind: 'Гастробар', address: 'Тестовый адрес' });
  const venueId = created.result.venueId;
  await command(request, admin.token, 'updateVenueProfile', { venueId, guestProfile: { published: true, demo: true, theme, feedbackEnabled: true, tagline: 'Место для ваших впечатлений', description: 'Изолированная карточка для проверки анкет.', highlights: ['Кухня', 'Атмосфера'], terms: '', links: {}, features: { loyalty: false, visits: false, reviews: false } } });
  const invitation = await command(request, admin.token, 'createManagerInvite', { venueId });
  await command(request, manager.token, 'acceptStaffInvite', { code: invitation.result.code });
  await command(request, manager.token, 'scanGuest', { venueId, qr: guest.guestQr });
  const view = await phone(browser, user, width);
  try {
    await view.page.getByRole('button', { name: `Открыть заведение ${venueName}`, exact: true }).click();
    await expect(view.page.getByRole('tab', { name: 'Бонусы', exact: true })).toHaveCount(0);
    await expect(view.page.getByRole('button', { name: 'Оценить визит', exact: true })).toHaveCount(0);
    await view.page.getByRole('button', { name: 'Показать мой QR', exact: true }).click();
    await expect(view.page.getByRole('img', { name: 'Личный QR гостя', exact: true })).toBeVisible();
    expect(await view.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await view.page.getByRole('button', { name: 'Закрыть', exact: true }).click();
    const visit = await command(request, manager.token, 'recordFeedbackVisit', { venueId, guestId: guest.guestId, preferences: ['Тихое место'], experience: 'pleasant', comment: 'Внутренняя запись команды' });
    await expect(view.page.getByRole('button', { name: 'Оценить визит', exact: true })).toBeVisible({ timeout: 20000 });
    await view.page.getByRole('button', { name: 'Оценить визит', exact: true }).click();
    await expect(view.page.getByRole('button', { name: 'Далее', exact: true })).toBeDisabled();
    await view.page.screenshot({ path: resolve(`../svoi-feedback-${theme}-${width}.png`), animations: 'disabled' });
    for (const [index, question] of feedbackQuestions.entries()) {
      const label = index === 1 ? 'Не понравилось' : index === 4 ? 'Не могу оценить' : 'Понравилось';
      await view.page.getByRole('radio', { name: `${question.label}: ${label}`, exact: true }).click();
      await expect(view.page.getByRole('radio', { name: `${question.label}: ${label}`, exact: true })).toBeChecked();
      expect(await view.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await view.page.getByRole('button', { name: index === 4 ? 'К комментарию' : 'Далее', exact: true }).click();
    }
    await view.page.getByLabel('Комментарий к визиту', { exact: true }).fill('Вкусная еда. Хотелось бы быстрее получить заказ.');
    await view.page.getByRole('button', { name: 'Изменить ответ: Еда', exact: true }).click();
    await expect(view.page.getByRole('radio', { name: 'Еда: Понравилось', exact: true })).toBeChecked();
    for (let i = 0; i < 5; i++) await view.page.getByRole('button', { name: i === 4 ? 'К комментарию' : 'Далее', exact: true }).click();
    await expect(view.page.getByLabel('Комментарий к визиту', { exact: true })).toHaveValue('Вкусная еда. Хотелось бы быстрее получить заказ.');
    const stale = await state(request, guest.token);
    expect(JSON.stringify(stale)).not.toContain('Внутренняя запись команды');
    expect(stale.db.staffFeedback).toEqual([]);
    const keys: string[] = [];
    if (theme === 'elpastor') {
      // Commit succeeds but its response is lost. Freeze polling to exercise an actual retry.
      await view.page.route('**/api/state', route => route.fulfill({ json: stale }));
      await view.page.route('**/api/commands', async route => {
        const body = route.request().postDataJSON();
        if (body.type !== 'submitGuestFeedback') return route.continue();
        keys.push(body.idempotencyKey);
        if (keys.length === 1) { const response = await route.fetch(); expect(response.status()).toBe(200); await route.abort('failed'); }
        else await route.continue();
      });
    }
    await view.page.getByRole('button', { name: 'Отправить отзыв', exact: true }).click();
    if (theme === 'elpastor') {
      await expect(view.page.getByText('Нет связи с сервером. Проверьте интернет и повторите попытку.', { exact: true })).toBeVisible();
      await expect(view.page.getByLabel('Комментарий к визиту', { exact: true })).toHaveValue('Вкусная еда. Хотелось бы быстрее получить заказ.');
      await expect(view.page.getByLabel('Комментарий к визиту', { exact: true })).not.toBeEditable();
      await expect(view.page.getByRole('button', { name: 'Назад', exact: true })).toBeDisabled();
      await view.page.getByRole('button', { name: 'Отправить отзыв', exact: true }).click();
    }
    await expect(view.page.getByText('Спасибо! Ваш отзыв отправлен команде заведения.', { exact: true })).toBeVisible();
    if (theme === 'elpastor') { expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]); await view.page.unroute('**/api/state'); }
    const saved = await state(request, guest.token);
    const reviews = saved.db.guestFeedback.filter((r: any) => r.visitId === visit.result.visitId);
    expect(reviews).toHaveLength(1); expect(reviews[0].answers).toEqual({ food: 'liked', service: 'disliked', atmosphere: 'liked', cleanliness: 'liked', value: 'not_used' });
    const staffState = await state(request, manager.token); expect(staffState.db.guestFeedback.some((r: any) => r.id === reviews[0].id)).toBe(true);
    await command(request, manager.token, 'replyGuestFeedback', { venueId, feedbackId: reviews[0].id, response: 'Спасибо за отзыв, учтём пожелания к скорости.' });
    await expect(view.page.getByText('Спасибо за отзыв, учтём пожелания к скорости.', { exact: true })).toBeVisible({ timeout: 20000 });
    await expect(view.page.getByText('Внутренняя запись команды', { exact: true })).toHaveCount(0);
    await expect(view.page.getByRole('button', { name: /Открыть.*бонус/i })).toHaveCount(0);
    expect(await view.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(view.errors).toEqual([]);
    const outsider = await session(request, identity('Другой гость'));
    expect(JSON.stringify(outsider)).not.toContain(reviews[0].comment);
  } finally { await view.context.close(); }
});
