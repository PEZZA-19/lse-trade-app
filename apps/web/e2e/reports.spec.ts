import { expect, test } from '@playwright/test';

test('owner reports: money, profit per job and time, from More', async ({ page, isMobile }) => {
  await page.goto('/more');
  await page
    .getByRole('link', { name: /Reports/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { name: 'Reports', level: 1 })).toBeVisible();
  const money = page.getByRole('list', { name: 'Money' });
  await expect(money).toContainText('Money in');
  await expect(money).toContainText('Owed now');
  await page.getByRole('button', { name: 'This Year' }).click();
  const jobs = page.getByRole('list', { name: 'Profit per job' });
  await expect(jobs).toContainText('Barn rewire and LED lighting');
  await expect(jobs).toContainText(/Time at cost\s*\d+ h \d+ min · £[\d.,]+/);
  await expect(jobs).toContainText('Charge-out');
  await expect(page.getByRole('list', { name: 'Time by person' })).toContainText('Joe');
  await jobs.getByRole('link', { name: /Barn rewire/ }).click();
  await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]+$/);
  if (isMobile)
    await expect(page.locator('nav.tabbar').getByRole('link', { name: 'Jobs' })).toBeVisible();
});
