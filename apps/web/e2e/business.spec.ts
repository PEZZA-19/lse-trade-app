import { expect, test } from '@playwright/test';

test('business overview and Xero-style reports, from More', async ({ page }) => {
  await page.goto('/more');
  await page.getByRole('link', { name: /Business Overview/ }).click();
  await expect(page.getByRole('heading', { name: 'Business', level: 1 })).toBeVisible();
  for (const h of [
    'Bank and Cash',
    'Owed to You',
    'You Owe',
    'Cash In and Out',
    'Profit',
    'Job Pipeline',
  ])
    await expect(page.getByRole('heading', { name: h, exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: /Money in and out by month/ })).toBeVisible();

  await page.getByRole('link', { name: /Profit and Loss/ }).click();
  await expect(page.getByRole('heading', { name: 'Profit and Loss', level: 1 })).toBeVisible();
  await page.getByLabel('Compare with').selectOption('last_year');
  const table = page.getByRole('table');
  await expect(table).toContainText('Net profit');
  await expect(table.getByRole('columnheader')).toHaveCount(4); // item, this period, last year, change
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: /CSV/ }).click();
  expect((await download).suggestedFilename()).toMatch(/^lse-profit-and-loss-.*\.csv$/);

  // An account line opens its transactions.
  await table.getByRole('link', { name: 'Sales: labour' }).click();
  await expect(page.getByRole('heading', { name: 'Account Transactions', level: 1 })).toBeVisible();
  await expect(page.getByRole('table')).toContainText('Closing balance');

  await page.goto('/business/reports/balance-sheet');
  await expect(page.getByRole('table')).toContainText('Total equity');
});
