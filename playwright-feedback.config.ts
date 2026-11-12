import { defineConfig } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const directory = resolve('../../work/feedback-ui-data');
mkdirSync(directory, { recursive: true });
const database = resolve(directory, `${randomUUID()}.sqlite`);
export default defineConfig({
  testDir: './tests/ui', testMatch: ['feedback-guest.spec.ts', 'feedback-staff.spec.ts', 'qr.spec.ts'], outputDir: '../../work/playwright-feedback-results',
  timeout: 90000, expect: { timeout: 15000 }, workers: 1,
  use: { baseURL: 'http://127.0.0.1:8097', browserName: 'chromium', channel: 'chrome', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: {
    command: 'node server/index.mjs', url: 'http://127.0.0.1:8097/api/health', reuseExistingServer: false, timeout: 20000,
    env: { PORT: '8097', HOST: '127.0.0.1', PUBLIC_APP_URL: 'http://127.0.0.1:8097', TELEGRAM_BOT_TOKEN: '123456:local-live-test-secret-do-not-deploy', DEVELOPER_TELEGRAM_IDS: '900000001', DATABASE_PATH: database, DATA_PATH: database },
  },
});
