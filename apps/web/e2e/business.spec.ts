import { expect, test, type Page } from '@playwright/test';

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

async function postJson(page: Page, p: string, data: unknown) {
  const session = await (await page.request.get('/api/auth/session')).json();
  const r = await page.request.post(`/api${p}`, {
    data,
    headers: { 'x-csrf-token': session.csrfToken as string },
  });
  return r.json();
}

test('bank statement: import a CSV, match a line to an expense, unmatch, ignore', async ({
  page,
}) => {
  const stamp = Date.now();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Guernsey' }).format(
    new Date(),
  );
  const [y, m, d] = today.split('-');
  const pence = 1000 + (stamp % 9000);
  const pounds = (pence / 100).toFixed(2);
  await postJson(page, '/expenses', {
    date: today,
    payee: `Fuel ${stamp}`,
    account: '449',
    amountPence: pence,
  });
  await page.goto('/business');
  await page.getByRole('link', { name: /Bank statement: import and match/ }).click();
  await expect(page.getByRole('heading', { name: 'Bank Statement', level: 1 })).toBeVisible();
  const csv = [
    'Date,Description,Amount',
    `${d}/${m}/${y},FUEL ${stamp} STATION,-${pounds}`,
    `${d}/${m}/${y},TRANSFER ${stamp},-5.00`,
    `${d}/${m}/${y},FERRY ${stamp},-12.34`,
    'nonsense,row,1',
  ].join('\n');
  await page.getByLabel('Bank statement CSV file').setInputFiles({
    name: 'statement.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv),
  });
  await expect(page.getByText('3 bank lines imported')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Last import' })).toContainText('Line 5 skipped');

  const lines = page.getByRole('list', { name: 'Bank lines' });
  await expect(lines).toContainText(`FUEL ${stamp} STATION`);
  await page
    .getByRole('button', { name: new RegExp(`^Match FUEL ${stamp} STATION to Fuel ${stamp}`) })
    .click();
  await expect(page.getByText('Matched', { exact: true }).last()).toBeVisible();
  await expect(page.getByText(`FUEL ${stamp} STATION`)).toHaveCount(0);
  // Money out the app doesn't have: add it as an expense from the line (date and amount are the bank's).
  await page.getByRole('button', { name: `Add FERRY ${stamp} as an expense` }).click();
  const sheet = page.getByRole('dialog', { name: 'Add Expense' });
  await expect(sheet.getByLabel('Paid to')).toHaveValue(`Ferry ${stamp}`);
  await expect(sheet.getByLabel('Amount (£)')).toHaveValue('12.34');
  await sheet.getByLabel('What for').selectOption({ label: 'Travel and ferries' });
  await sheet.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Expense added · £12.34')).toBeVisible();
  await expect(page.getByText(`FERRY ${stamp}`)).toHaveCount(0);
  await page.getByRole('button', { name: `Ignore TRANSFER ${stamp}` }).click();
  await expect(page.getByText(`TRANSFER ${stamp}`)).toHaveCount(0);

  await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'Matched' }).click();
  await expect(lines).toContainText(`Fuel ${stamp}`);
  await page.getByRole('button', { name: `Unmatch FUEL ${stamp} STATION` }).click();
  await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'To Match' }).click();
  await expect(lines).toContainText(`FUEL ${stamp} STATION`);

  // With a balance column, the screen checks the bank's balance against the app's Bank and Cash.
  await page.getByLabel('Bank statement CSV file').setInputFiles({
    name: 'balance.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      `Date,Description,Amount,Balance\n${d}/${m}/${y},BAL ${stamp},0.01,123.45\n`,
    ),
  });
  const check = page.getByRole('list', { name: 'Bank check' });
  await expect(check).toContainText('£123.45');
  await expect(check).toContainText('The app’s Bank and Cash');
  await expect(check).toContainText('Difference');

  // Importing the same file again adds nothing twice.
  await page.getByLabel('Bank statement CSV file').setInputFiles({
    name: 'statement.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv),
  });
  await expect(page.getByText('Nothing new: these lines were already imported')).toBeVisible();
});

test('bank statement: record a customer payment from money in', async ({ page }) => {
  const stamp = Date.now();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Guernsey' }).format(
    new Date(),
  );
  const [y, m, d] = today.split('-');
  await page.goto('/business/bank');
  await expect(page.getByRole('heading', { name: 'Bank Statement', level: 1 })).toBeVisible();
  await page.getByLabel('Bank statement CSV file').setInputFiles({
    name: 'in.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(`Date,Description,Amount\n${d}/${m}/${y},FP PAYIN ${stamp},0.01\n`),
  });
  await page
    .getByRole('button', { name: `Record FP PAYIN ${stamp} as a customer payment` })
    .click();
  const sheet = page.getByRole('dialog', { name: 'Record Payment' });
  await expect(sheet).toContainText('recorded as a bank transfer on that day');
  await sheet.getByRole('list', { name: 'Invoices to pay' }).getByRole('radio').first().check();
  await sheet.getByRole('button', { name: 'Record', exact: true }).click();
  await expect(page.getByText(/^Payment recorded on /)).toBeVisible();
  await expect(page.getByText(`FP PAYIN ${stamp}`)).toHaveCount(0);
  await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'Matched' }).click();
  await expect(page.getByRole('list', { name: 'Bank lines' })).toContainText(`FP PAYIN ${stamp}`);
});
