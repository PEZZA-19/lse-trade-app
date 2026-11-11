import { defineConfig } from '@playwright/test';

/** Screenshots of the static preview build (demo data). Run: pnpm screenshots */
const channel = process.env.CI ? undefined : 'chrome';
export default defineConfig({
  testDir: 'e2e',
  testMatch: /screenshots\.spec\.ts/,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4174',
    ...(channel ? { channel } : {}),
    // Native date/time pickers follow the browser language, not the page locale: match Joe (en-GB).
    launchOptions: {
      args: ['--lang=en-GB'],
      env: { ...process.env, LANGUAGE: 'en_GB', LANG: 'en_GB.UTF-8' },
    },
  },
  webServer: {
    command: 'pnpm preview:static',
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: true,
  },
});
