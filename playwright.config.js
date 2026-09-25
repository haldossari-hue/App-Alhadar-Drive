import { defineConfig, devices } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3199;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-e2e-'));
/* في بيئات يكون فيها Chromium مثبت مسبقاً بإصدار مختلف */
const executablePath = process.env.CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: 'test/e2e',
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    ...devices['Pixel 7'],
    locale: 'ar-SA',
    launchOptions: executablePath ? { executablePath } : {},
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node --disable-warning=ExperimentalWarning src/server.js',
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    env: { PORT: String(PORT), DATA_DIR: dataDir, PAYMENT_PROVIDER: 'fake', PUBLIC_URL: `http://localhost:${PORT}`, INITIAL_ADMIN_PIN: '1234' },
  },
});
