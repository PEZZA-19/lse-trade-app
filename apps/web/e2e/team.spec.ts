import { expect, test } from '@playwright/test';

test('owner sets a cost rate (base + on-costs) in Settings › Team; job and reports show true profit', async ({
  page,
}) => {
  await page.goto('/settings');
  const team = page.getByRole('list', { name: 'Team' });
  await team.getByRole('button', { name: /Joe/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Joe' });
  await expect(sheet).toContainText('£45.00/h');
  await sheet.getByLabel('Base cost', { exact: true }).fill('20.00');
  // Fixed £ per hour.
  await sheet.getByRole('button', { name: '£/h', exact: true }).click();
  await sheet.getByLabel('Tax and on-costs (£/h)').fill('4.55');
  await expect(sheet.getByText('£24.55/h')).toBeVisible();
  await expect(sheet.getByText('£20.45')).toBeVisible(); // left per hour charged
  // Switch to a percentage of the base: £20 + 22.5% = £24.50.
  await sheet.getByRole('button', { name: '%', exact: true }).click();
  await sheet.getByLabel('Tax and on-costs (%)').fill('22.5');
  await expect(sheet.getByText('£4.50/h')).toBeVisible();
  await expect(sheet.getByText('£24.50/h')).toBeVisible();
  // Switching back keeps what was typed in each mode.
  await sheet.getByRole('button', { name: '£/h', exact: true }).click();
  await expect(sheet.getByLabel('Tax and on-costs (£/h)')).toHaveValue('4.55');
  await sheet.getByRole('button', { name: '%', exact: true }).click();
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(team.getByRole('button', { name: /Joe/ })).toContainText('£24.50/h cost');
  await expect(team.getByRole('button', { name: /Joe/ })).not.toContainText('Placeholder');
  // Reopening shows the percentage, not just the amount.
  await team.getByRole('button', { name: /Joe/ }).click();
  await expect(sheet.getByRole('button', { name: '%', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(sheet.getByLabel('Tax and on-costs (%)')).toHaveValue('22.5');
  await page.keyboard.press('Escape');

  await page.goto('/jobs');
  await page.getByText('Barn rewire and LED lighting').click();
  const qva = page.getByRole('list', { name: 'Quote vs actual' });
  await expect(qva).toContainText('Labour at cost');
  await expect(qva).toContainText(/Joe · .* × £24\.50\/h cost/);

  await page.goto('/reports');
  await page.getByRole('button', { name: 'This Year' }).click();
  await expect(page.getByText(/1 Jan 2026 –/)).toBeVisible(); // calendar year until 2027
  await expect(page.getByRole('list', { name: 'Profit per job' })).toContainText('at cost');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  expect((await download).suggestedFilename()).toMatch(/^lse-reports-2026-01-01-to-.*\.csv$/);
});
