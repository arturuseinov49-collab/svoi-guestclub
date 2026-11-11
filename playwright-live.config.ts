import { defineConfig } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const directory = resolve('../../work/live-test-data');
mkdirSync(directory, { recursive: true });
const database = resolve(directory, `${randomUUID()}.sqlite`);
export default defineConfig({
  testDir: './tests/ui', testMatch: ['live.spec.ts', 'qr.spec.ts'], outputDir: '../../work/playwright-live-results',
  timeout: 90000, expect: { timeout: 15000 }, workers: 1,
  use: { baseURL: 'http://127.0.0.1:8094', browserName: 'chromium', channel: 'chrome', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: {
    command: 'node server/index.mjs', url: 'http://127.0.0.1:8094/api/health', reuseExistingServer: false, timeout: 20000,
    env: { PORT: '8094', HOST: '127.0.0.1', PUBLIC_APP_URL: 'http://127.0.0.1:8094', TELEGRAM_BOT_TOKEN: '123456:local-live-test-secret-do-not-deploy', DEVELOPER_TELEGRAM_IDS: '900000001', POS_MASTER_KEY: Buffer.alloc(32, 17).toString('base64'), DATABASE_PATH: database, DATA_PATH: database },
  },
});
