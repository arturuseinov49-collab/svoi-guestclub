import { test, expect, Page } from '@playwright/test';
async function boot(page: Page) { await page.goto('/'); await expect(page.getByText('НЕ ПРОСТО\nГОСТИ. СВОИ.')).toBeVisible(); }
async function role(page: Page, name: 'гостя' | 'сотрудника') { await page.getByRole('button', { name: 'Профиль и настройки', exact: true }).click(); await page.getByRole('button', { name: `Режим ${name}`, exact: true }).click(); }
async function close(page: Page) { await page.getByRole('button', { name: 'Закрыть', exact: true }).click(); }
test('staff flow: add guest, visit, comment and appreciation persist on reload', async ({ page }) => {
  await boot(page); await page.getByRole('tab', { name: 'Гости', exact: true }).click();
  await page.getByRole('button', { name: 'Добавить гостя', exact: true }).click();
  await page.getByLabel('Имя и фамилия', { exact: true }).fill('Тестовый Гость'); await page.getByLabel('Телефон', { exact: true }).fill('+7 999 555 44 33');
  await page.getByRole('button', { name: 'Добавить гостя', exact: true }).last().click();
  await expect(page.getByText('Карточка гостя', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Визит', exact: true }).click();
  await page.getByLabel('Сумма чека, ₽', { exact: true }).fill('1000,50'); await page.getByLabel('Чаевые, ₽', { exact: true }).fill('150');
  await page.getByRole('button', { name: 'Сохранить визит', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('75 Б', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Добавить', exact: true }).click();
  await page.getByLabel('Комментарий о госте', { exact: true }).fill('Спасибо за внимательное отношение к команде');
  await page.getByRole('button', { name: 'Сохранить заметку', exact: true }).click();
  await expect(page.getByText('Спасибо за внимательное отношение к команде', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Бонусы', exact: true }).click(); await page.getByRole('button', { name: 'Подарить бонусы', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('175 Б', { exact: true })).toBeVisible();
  await page.reload(); await expect(page.getByText('НЕ ПРОСТО\nГОСТИ. СВОИ.')).toBeVisible();
  await page.getByRole('tab', { name: 'Гости', exact: true }).click(); await page.getByLabel('Поиск гостей', { exact: true }).fill('9995554433');
  await page.getByRole('button', { name: 'Гость Тестовый Гость', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('175 Б', { exact: true })).toBeVisible(); await expect(page.getByText('Спасибо за внимательное отношение к команде')).toBeVisible();
});
test('guest mode shows own visits, venue-specific balance, redemption and reviews', async ({ page }) => {
  await boot(page); await role(page, 'гостя');
  await expect(page.getByText('740 Б', { exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Гости', exact: true })).toHaveCount(0);
  await expect(page.getByText('Заметки команды', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Сменить заведение, сейчас Лист', exact: true }).click(); await page.getByRole('button', { name: 'Выбрать заведение Мох', exact: true }).click();
  await expect(page.getByText('230 Б', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Бонусы', exact: true }).click();
  await page.getByRole('button', { name: 'Получить комплимент', exact: true }).first().click(); await page.getByRole('button', { name: 'Подтвердить списание 150 Б', exact: true }).click();
  await expect(page.getByText('80 Б', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Отзывы', exact: true }).click(); await page.getByRole('button', { name: 'Поделиться впечатлением', exact: true }).click();
  await page.getByLabel('Ваш отзыв о заведении', { exact: true }).fill('Прекрасный кофе после прогулки'); await page.getByRole('button', { name: 'Сохранить отзыв', exact: true }).click();
  await expect(page.getByText('Прекрасный кофе после прогулки', { exact: true })).toBeVisible();
});
for (const provider of ['iiko', 'r_keeper']) {
  test(`${provider}: UI imports receipt, prevents replay and persists log`, async ({ page }) => {
    await boot(page); await page.getByRole('button', { name: 'Открыть интеграции', exact: true }).click();
    await page.getByRole('button', { name: `Демо ${provider}`, exact: true }).click();
    await page.getByRole('button', { name: 'Подготовить тестовый чек', exact: true }).click();
    await page.getByRole('button', { name: 'Обработать чек', exact: true }).click();
    await expect(page.getByText('Чек учтён', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Повтор', exact: true }).click(); await page.getByRole('button', { name: 'Подготовить тестовый чек', exact: true }).click();
    await page.getByRole('button', { name: 'Обработать чек', exact: true }).click(); await expect(page.getByText('Повтор защищён', { exact: true })).toBeVisible();
    await close(page); await page.getByRole('tab', { name: 'Гости', exact: true }).click(); await page.getByRole('button', { name: 'Гость Александр Миронов', exact: true }).click();
    await expect(page.getByRole('dialog').getByText(provider === 'iiko' ? '855 Б' : '860 Б', { exact: true })).toBeVisible();
    await expect(page.getByRole('dialog').getByText('5.0', { exact: true })).toBeVisible();
  });
}
test('validation prevents empty visit and negative points', async ({ page }) => {
  await boot(page); await page.getByRole('button', { name: 'Отметить визит', exact: true }).click(); await page.getByRole('button', { name: 'Выбрать гостя Александр Миронов', exact: true }).click();
  await page.getByRole('button', { name: 'Сохранить визит', exact: true }).click(); await expect(page.getByText(/Сумма чека: от/)).toBeVisible();
  await close(page); await page.getByRole('tab', { name: 'Гости', exact: true }).click(); await page.getByRole('button', { name: 'Гость Александр Миронов', exact: true }).click();
  await page.getByRole('button', { name: 'Бонусы', exact: true }).click(); await page.getByLabel('Количество бонусов', { exact: true }).fill('-100'); await page.getByRole('button', { name: 'Подарить бонусы', exact: true }).click();
  await expect(page.getByText(/Количество бонусов: от/)).toBeVisible();
});
test('narrow phone: navigation remains visible without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 }); await boot(page);
  for (const tab of ['Гости', 'Бонусы', 'Отзывы', 'Обзор']) { await page.getByRole('tab', { name: tab, exact: true }).click(); await expect(page.getByRole('tab', { name: tab, exact: true })).toBeVisible(); }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('application has no runtime errors during navigation and role switching', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await boot(page); for (const tab of ['Гости', 'Бонусы', 'Отзывы']) await page.getByRole('tab', { name: tab, exact: true }).click();
  await role(page, 'гостя'); for (const tab of ['Визиты', 'Бонусы', 'Отзывы']) await page.getByRole('tab', { name: tab, exact: true }).click();
  await role(page, 'сотрудника'); expect(errors).toEqual([]);
});
test('unmatched POS receipt can be linked; open, refund and offline do not accrue', async ({ page }) => {
  await boot(page); await page.getByRole('button', { name: 'Открыть интеграции', exact: true }).click();
  await page.getByRole('button', { name: 'Без гостя', exact: true }).click(); await page.getByRole('button', { name: 'Подготовить тестовый чек', exact: true }).click(); await page.getByRole('button', { name: 'Обработать чек', exact: true }).click();
  await expect(page.getByText('Нужна привязка гостя', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Привязать чек Александр Миронов', exact: true }).click(); await page.getByRole('button', { name: 'Импортировать с выбранным гостем', exact: true }).click();
  await expect(page.getByText('Чек учтён', { exact: true })).toBeVisible();
  for (const [scenario, expected] of [['Открытый', 'Начисление пропущено'], ['Возврат', 'Нужна сверка возврата']]) {
    await page.getByRole('button', { name: scenario, exact: true }).click(); await page.getByRole('button', { name: 'Подготовить тестовый чек', exact: true }).click(); await page.getByRole('button', { name: 'Обработать чек', exact: true }).click(); await expect(page.getByText(expected, { exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Нет связи', exact: true }).click(); await page.getByRole('button', { name: 'Проверить без подключения', exact: true }).click(); await expect(page.getByText('Симуляция: касса недоступна', { exact: true })).toBeVisible();
  await close(page); await role(page, 'гостя'); await expect(page.getByText('855 Б', { exact: true })).toBeVisible();
});
test('program changes stay scoped; staff can respond to a venue review', async ({ page }) => {
  await boot(page); await page.getByRole('tab', { name: 'Бонусы', exact: true }).click(); await page.getByRole('button', { name: 'Настроить', exact: true }).click();
  await page.getByLabel('Кешбэк с чека, % (0–30)', { exact: true }).fill('9'); await page.getByRole('button', { name: 'Сохранить программу', exact: true }).click();
  await expect(page.getByText('9% с каждого чека', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Сменить заведение, сейчас Лист', exact: true }).click(); await page.getByRole('button', { name: 'Выбрать заведение Мох', exact: true }).click(); await page.getByRole('tab', { name: 'Бонусы', exact: true }).click();
  await expect(page.getByText('7% с каждого чека', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Отзывы', exact: true }).click(); await page.getByRole('button', { name: 'Ответить на отзыв Александр Миронов', exact: true }).click();
  await page.getByLabel('Ответ гостю', { exact: true }).fill('Спасибо, будем рады видеть вас снова!'); await page.getByRole('button', { name: 'Сохранить ответ', exact: true }).click();
  await expect(page.getByText('Спасибо, будем рады видеть вас снова!', { exact: true })).toBeVisible();
});
test('own venue can be created and export contains the local database', async ({ page }) => {
  await boot(page); await page.getByRole('button', { name: 'Профиль и настройки', exact: true }).click();
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Экспортировать данные', exact: true }).click(); expect((await download).suggestedFilename()).toMatch(/^svoi-.*\.json$/);
  await page.getByRole('button', { name: 'Создать своё заведение', exact: true }).click(); await page.getByLabel('Название заведения', { exact: true }).fill('Демо-ресторан'); await page.getByLabel('Адрес', { exact: true }).fill('Центральная, 10');
  await page.getByRole('button', { name: 'Создать заведение', exact: true }).click(); await expect(page.getByRole('button', { name: 'Сменить заведение, сейчас Демо-ресторан', exact: true })).toBeVisible();
  await role(page, 'гостя'); await expect(page.getByText('0 Б', { exact: true })).toBeVisible();
});
test('Telegram container initializes, native Back returns home and closes sheets', async ({ page }) => {
  await page.route('https://telegram.org/js/**', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
  await page.addInitScript(() => {
    const w = window as any; w.__tgCalls = []; w.__tgBack = null;
    w.Telegram = { WebApp: { initData: 'test-not-a-real-session', platform: 'android', version: '9.0', viewportStableHeight: 844, safeAreaInset: { top: 0, bottom: 0 }, contentSafeAreaInset: { top: 0, bottom: 0 }, ready: () => w.__tgCalls.push('ready'), expand: () => w.__tgCalls.push('expand'), setHeaderColor: () => {}, setBackgroundColor: () => {}, onEvent: () => {}, offEvent: () => {}, BackButton: { show: () => w.__tgCalls.push('show'), hide: () => w.__tgCalls.push('hide'), onClick: (fn: any) => w.__tgBack = fn, offClick: () => w.__tgBack = null } } };
  });
  await boot(page); expect(await page.evaluate(() => (window as any).__tgCalls)).toContain('ready');
  await page.getByRole('tab', { name: 'Бонусы', exact: true }).click();
  await page.evaluate(() => (window as any).__tgBack()); await expect(page.getByText('НЕ ПРОСТО\nГОСТИ. СВОИ.')).toBeVisible();
  await page.getByRole('button', { name: 'Профиль и настройки', exact: true }).click(); await expect(page.getByText('Telegram · android', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).__tgBack()); await expect(page.getByRole('dialog')).toHaveCount(0);
});
