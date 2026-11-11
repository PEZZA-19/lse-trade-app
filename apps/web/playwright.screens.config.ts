import { defineConfig } from '@playwright/test';

/** Screenshots of the static preview build (demo data). Run: pnpm screenshots */
const channel = process.env.CI ? undefined : 'chrome';
export default defineConfig({
  testDir: 'e2e',
  testMatch: /screenshots\.spec\.ts/,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:4174', ...(channel ? { channel } : {}) },
  webServer: {
    command: 'pnpm preview:static',
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: true,
  },
});
