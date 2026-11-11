import { defineConfig } from '@playwright/test';

/**
 * Production build + service worker: the app must reopen with no signal and show cached data.
 * Needs `pnpm build` first (the script does it). Uses the real local API and Postgres.
 */
const channel = process.env.CI ? undefined : 'chrome';
export default defineConfig({
  testDir: 'e2e-pwa',
  workers: 1,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:4173', ...(channel ? { channel } : {}) },
  webServer: [
    {
      command: 'DEV_RELAX_RATE_LIMITS=1 pnpm --filter @lse/api dev',
      url: 'http://127.0.0.1:8787/api/health',
      reuseExistingServer: true,
      cwd: '../..',
    },
    {
      command: 'pnpm exec vite preview --host 127.0.0.1',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: true,
    },
  ],
});
