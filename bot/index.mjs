import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
const token = process.env.TELEGRAM_BOT_TOKEN;
const appUrl = process.env.PUBLIC_APP_URL;
if (!token || !appUrl) { console.error('Set TELEGRAM_BOT_TOKEN and PUBLIC_APP_URL in .env.local. See README.md.'); process.exit(1); }
if (new URL(appUrl).protocol !== 'https:') { console.error('PUBLIC_APP_URL must use HTTPS.'); process.exit(1); }
let stopping = false;
process.on('SIGINT', () => { stopping = true; }); process.on('SIGTERM', () => { stopping = true; });
async function api(method, data = {}) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal: AbortSignal.timeout(40000) });
  const result = await response.json();
  if (!result.ok) throw new Error(`Telegram ${method} failed (${result.error_code || response.status})`);
  return result.result;
}
const menu = { type: 'web_app', text: 'Открыть «Свои»', web_app: { url: appUrl } };
const keyboard = { inline_keyboard: [[{ text: '🌿 Открыть «Свои»', web_app: { url: appUrl } }]] };
const webhook = await api('getWebhookInfo');
if (webhook.url) { console.error('This bot already has a webhook. It was not removed. Use a dedicated bot or configure polling yourself.'); process.exit(1); }
const me = await api('getMe');
const expectedUsername = process.env.EXPECTED_BOT_USERNAME || 'svoi_guestclub_demo_bot';
if (me.username?.toLowerCase() !== expectedUsername.toLowerCase()) {
  console.error('Bot identity does not match EXPECTED_BOT_USERNAME. No bot settings were changed.'); process.exit(1);
}
await api('setMyDescription', { description: 'Свои — бонусы, визиты и отзывы любимого заведения. Гостю — личный QR и свой баланс. Команде — доступ по приглашению руководителя. Заведения добавляет разработчик платформы. Вход через Telegram, данные доступны с разных телефонов. Реальные кассы iiko и r_keeper пока не подключены.' });
await api('setMyShortDescription', { short_description: 'Свои: бонусы, визиты и отзывы. Вход через Telegram, общая база гостей и команды заведения.' });
await api('setChatMenuButton', { menu_button: menu });
await api('setMyCommands', { commands: [{ command: 'start', description: 'Открыть «Свои»' }, { command: 'help', description: 'Гостям и командам заведений' }, { command: 'privacy', description: 'Как хранятся ваши данные' }] });
await mkdir('data', { recursive: true });
let offset = 0;
try { offset = JSON.parse(await readFile('data/bot-offset.json', 'utf8')).offset || 0; } catch {}
console.log(`Bot @${me.username} is running. Shared accounts; no POS connections.`);
async function handle(update) {
  const message = update.message;
  if (!message || message.chat.type !== 'private' || !message.text) return;
  const command = message.text.split(/[\s@]/)[0];
  const text = command === '/privacy'
    ? 'При открытии Mini App сервер проверяет подпись Telegram и создаёт профиль по вашему Telegram ID и имени. Бонусы, визиты и отзывы хранятся в общей базе сервиса и доступны с разных телефонов после входа в тот же Telegram-аккаунт.\n\nГость видит свои записи. Сотрудники видят гостей и внутренние заметки только своих заведений; доступ в команду выдаётся по приглашению руководителя. Пароль Telegram и телефон для входа не нужны.\n\nСервисы iiko и r_keeper пока не подключены: кассовые данные автоматически не запрашиваются. Не сообщайте посторонним приглашения в команду.'
    : command === '/help'
      ? 'Откройте Mini App кнопкой ниже — вход выполняется через ваш Telegram.\n\nГостю: покажите сотруднику личный QR. Он проверит имя и подтвердит визит — история и бонусы появятся в вашем аккаунте. Само сканирование не начисляет бонусы. Без камеры можно назвать короткий код под QR.\n\nРуководителю: заведение добавляет разработчик «Своих». Полученный от него код введите через «Я сотрудник». После этого в настройках доступно управление командой и создание приглашений сотрудникам.\n\nСотруднику: получите личный код у руководителя и примите его через «Я сотрудник». Приглашение одноразовое и действует 24 часа. Код клуба предназначен для гостей и не даёт доступа в команду.\n\nДанные общие для разных телефонов. Подключение реальных касс iiko и r_keeper — отдельный этап; сейчас визиты отмечает команда.'
      : command === '/start'
        ? '🌿 Свои — место, где помнят гостей.\n\nОткройте приложение: вход через Telegram произойдёт автоматически.\n\nГостю — покажите сотруднику личный QR при визите. Команде — примите приглашение руководителя через «Я сотрудник». Заведения добавляет разработчик «Своих».\n\nВаши бонусы и история доступны с разных телефонов. Первый вход создаёт новый профиль без вымышленных визитов и бонусов.'
        : 'Нажмите кнопку, чтобы открыть «Свои». Помощь — /help.';
  await api('sendMessage', { chat_id: message.chat.id, text, reply_markup: keyboard });
}
while (!stopping) {
  try {
    const updates = await api('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] });
    for (const update of updates) {
      await handle(update); offset = update.update_id + 1;
      await writeFile('data/bot-offset.json.tmp', JSON.stringify({ offset })); await rename('data/bot-offset.json.tmp', 'data/bot-offset.json');
    }
  } catch { if (!stopping) { console.error('Telegram temporarily unavailable; retrying.'); await new Promise(resolve => setTimeout(resolve, 3000)); } }
}
