import { expect, test } from '@playwright/test';
import { signInThroughUi } from '../e2e/sign-in';

test('production build: app reopens offline with cached jobs', async ({ page, context }) => {
  await signInThroughUi(page);
  await expect(page.getByText('Barn rewire and LED lighting')).toBeVisible();
  // Let the service worker take control and the cache persist.
  await page
    .waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 15000 })
    .catch(() => {});
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, {
    timeout: 15000,
  });
  await page.waitForTimeout(1500);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByText('You’re offline.')).toBeVisible();
  await expect(page.getByText('Barn rewire and LED lighting')).toBeVisible();
});
