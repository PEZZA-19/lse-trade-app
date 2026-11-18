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

test('expenses and wages: add one, it shows in the totals and the P&L, remove it', async ({
  page,
}) => {
  const stamp = Date.now();
  await page.goto('/business');
  await page.getByRole('link', { name: 'Expenses and wages' }).click();
  await expect(page.getByRole('heading', { name: 'Expenses and Wages', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Add Expense or Wages' }).click();
  const sheet = page.getByRole('dialog', { name: 'Add Expense' });
  await sheet.getByLabel('What for').selectOption({ label: 'Travel and ferries' });
  await sheet.getByLabel('Paid to').fill(`Ferry ${stamp}`);
  await sheet.getByLabel('Amount (£)').fill('23.50');
  // Every expense is the business's (Joe, 18 Nov 2026): no "paid personally" choice.
  await expect(sheet.getByRole('button', { name: 'Paid personally' })).toHaveCount(0);
  await expect(sheet).toContainText('Comes out of the business account and off the profit.');
  await sheet.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Expense added · £23.50')).toBeVisible();
  const list = page.getByRole('list', { name: 'Expenses', exact: true });
  await expect(list).toContainText(`Ferry ${stamp}`);
  await expect(list).not.toContainText('paid personally');
  await expect(page.getByRole('list', { name: 'Expenses by account' })).toContainText(
    'Travel and ferries',
  );

  await page.goto('/business/reports/profit-and-loss');
  await expect(page.getByRole('table')).toContainText('Travel and ferries');
  await expect(page.getByRole('table')).toContainText('Total operating expenses');

  await page.goto('/business/expenses');
  await page.getByRole('button', { name: `Remove Ferry ${stamp} £23.50` }).click();
  await page
    .getByRole('dialog', { name: 'Remove Expense' })
    .getByRole('button', { name: 'Remove', exact: true })
    .last()
    .click();
  await expect(page.getByText('Expense removed')).toBeVisible();
  await expect(page.getByText(`Ferry ${stamp}`)).toHaveCount(0);
});
