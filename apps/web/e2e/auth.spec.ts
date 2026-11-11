import { expect, test } from '@playwright/test';
import { signInThroughUi } from './sign-in';

test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('the app asks you to sign in, and a used link cannot be reused', async ({ page }) => {
    await page.goto('/jobs');
    await expect(page).toHaveURL(/\/sign-in$/);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

    const link = await signInThroughUi(page);
    // The token is removed from the address bar after use.
    expect(page.url()).not.toContain('token=');

    // Opening the same link again does not sign anyone in.
    await page.goto(link);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('alert')).toContainText('expired or was already used');

    await page.goto('/settings');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
    await page.goto('/jobs');
    await expect(page).toHaveURL(/\/sign-in$/);
  });
});

test('settings: change the labour rate, and the change is really saved', async ({ page }) => {
  await page.goto('/settings');
  const rate = page.getByLabel('Labour rate (£/hr)');
  await expect(rate).toHaveValue('45.00');
  await rate.fill('47.50');
  await expect(page.getByRole('status').filter({ hasText: 'Unsaved changes' })).toBeVisible();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Labour rate (£/hr)')).toHaveValue('47.50');
  // Put it back for the other tests.
  await page.getByLabel('Labour rate (£/hr)').fill('45');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
});
