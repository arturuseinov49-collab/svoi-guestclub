import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import './build-server.mjs';
const result = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['node_modules/expo/bin/cli', 'export', '--platform', 'web', '--output-dir', 'dist'], { stdio: 'inherit', env: { ...process.env, CI: '1' } });
  child.on('error', reject); child.on('exit', code => resolve(code));
});
if (result !== 0) process.exit(Number(result) || 1);
let html = await readFile('dist/index.html', 'utf8');
const effects = await readFile('src/effects.css', 'utf8');
html = html.replace('</head>', `<style id="svoi-effects">${effects}</style></head>`);
html = html.replace('<head>', `<head>\n<script src="https://telegram.org/js/telegram-web-app.js?64"></script>\n<meta name="description" content="Свои — гости, благодарности и бонусы любимого заведения. Вход через Telegram, ваши данные на всех устройствах."/>\n<style>html,body,#root{height:var(--svoi-height,100dvh);min-height:0;overscroll-behavior:none}body{margin:0;background:#E8EDE3}*{-webkit-tap-highlight-color:transparent}input,textarea{font-size:16px!important}button,input,textarea,a{touch-action:manipulation}</style>`);
html = html.replace(/<title>[^<]*<\/title>/, '<title>Свои · Telegram Mini App</title>');
html = html.replace(/name="viewport" content="[^"]*"/, 'name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"');
await writeFile('dist/index.html', html);
await mkdir('dist/legal', { recursive: true });
await copyFile('assets/fonts/CormorantGaramond-OFL.txt', 'dist/legal/CormorantGaramond-OFL.txt');
console.log('Telegram Mini App ready in dist/.');
