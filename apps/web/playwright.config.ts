import { defineConfig, devices } from '@playwright/test';

/**
 * E2E against the real stack: Vite dev server + Node API + local Postgres (seeded).
 * Start the database first: `pnpm db:start && pnpm db:seed`.
 * Locally uses the system Chrome; CI uses Playwright's Chromium.
 */
const channel = process.env.CI ? undefined : 'chrome';
export const AUTH_FILE = 'test-results/.auth/owner.json';
export default defineConfig({
  testDir: 'e2e',
  testIgnore: /(?:screenshots|schedule-picker)\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    ...(channel ? { channel } : {}),
  },
  projects: [
    // Signs in once through the real magic-link flow and saves the session cookie.
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'mobile',
      dependencies: ['setup'],
      use: {
        ...devices['iPhone 14'],
        browserName: 'chromium',
        storageState: AUTH_FILE,
        ...(channel ? { channel } : {}),
      },
    },
    {
      name: 'desktop',
      dependencies: ['setup'],
      use: { viewport: { width: 1280, height: 800 }, storageState: AUTH_FILE },
    },
  ],
  webServer: [
    {
      command: 'DEV_RELAX_RATE_LIMITS=1 pnpm --filter @lse/api dev',
      url: 'http://127.0.0.1:8787/api/health',
      reuseExistingServer: true,
      cwd: '../..',
    },
    { command: 'pnpm dev', url: 'http://127.0.0.1:5173', reuseExistingServer: true },
  ],
});
