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
await api('setMyDescription', { description: 'Свои — обратная связь после визита. Гость оценивает заведение по пунктам и пишет комментарий. Команда отмечает предпочтения гостя в закрытой анкете. Личный QR, вход через Telegram и общая история на разных телефонах. Отзывы доступны автору и команде заведения.' });
await api('setMyShortDescription', { short_description: 'Свои: отзывы после визита и предпочтения гостей. Личный QR и вход через Telegram.' });
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
    ? 'Сервер проверяет подпись Telegram и создаёт профиль по вашему Telegram ID и имени. Визиты и отзывы хранятся в общей базе и доступны с разных телефонов после входа в тот же аккаунт.\n\nОтзывы гостей видят только их авторы и команда соответствующего заведения. Предпочтения и комментарии сотрудников о госте видит только команда этого заведения. Они не показываются гостю, другим заведениям и в публичном каталоге.\n\nДоступ в команду выдаётся по приглашению руководителя. Пароль Telegram и телефон для входа не нужны. Не сообщайте посторонним приглашения в команду.'
    : command === '/help'
      ? 'Гостю: выберите заведение и покажите сотруднику личный QR. После визита сотрудник заполнит короткую анкету. В вашей карточке появится приглашение оценить еду, обслуживание, атмосферу, чистоту и соотношение цены и качества. Можно написать отдельный комментарий. Отзыв увидят только вы и команда.\n\nСотруднику: получите личный код у руководителя и примите его через «Я сотрудник». Отсканируйте QR гостя, проверьте имя и после посещения нажмите «Завершить визит». Отметьте известные предпочтения и добавьте комментарий для команды. Само сканирование визит не создаёт.\n\nРуководителю: заведение добавляет разработчик «Своих». Код руководителя открывает управление командой и приглашения сотрудникам. Данные синхронизируются между телефонами.'
      : command === '/start'
        ? '🌿 Свои — места, где вас слышат.\n\nГостям — короткая анкета после визита и прямой диалог с заведением. Команде — предпочтения гостей и закрытые заметки для следующей встречи.\n\nВыберите заведение и покажите личный QR. Вход через Telegram произойдёт автоматически. Заведения добавляет разработчик «Своих», сотрудников приглашает руководитель.'
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
