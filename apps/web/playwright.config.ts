import { defineConfig, devices } from '@playwright/test';

/**
 * E2E against the real stack: Vite dev server + Node API + local Postgres (seeded).
 * Start the database first: `pnpm db:start && pnpm db:seed`.
 * Locally uses the system Chrome; CI uses Playwright's Chromium.
 */
const channel = process.env.CI ? undefined : 'chrome';
export default defineConfig({
  testDir: 'e2e',
  testIgnore: /screenshots\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    ...(channel ? { channel } : {}),
  },
  projects: [
    {
      name: 'mobile',
      use: { ...devices['iPhone 14'], browserName: 'chromium', ...(channel ? { channel } : {}) },
    },
    { name: 'desktop', use: { viewport: { width: 1280, height: 800 } } },
  ],
  webServer: [
    {
      command: 'pnpm --filter @lse/api dev',
      url: 'http://127.0.0.1:8787/api/health',
      reuseExistingServer: true,
      cwd: '../..',
    },
    { command: 'pnpm dev', url: 'http://127.0.0.1:5173', reuseExistingServer: true },
  ],
});
