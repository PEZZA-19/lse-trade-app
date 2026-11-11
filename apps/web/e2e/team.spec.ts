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
  await sheet.getByLabel('Tax and on-costs', { exact: true }).fill('4.55');
  await expect(sheet.getByText('£24.55/h')).toBeVisible();
  await expect(sheet.getByText('£20.45')).toBeVisible(); // left per hour charged
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(team.getByRole('button', { name: /Joe/ })).toContainText('£24.55/h cost');
  await expect(team.getByRole('button', { name: /Joe/ })).not.toContainText('Placeholder');

  await page.goto('/jobs');
  await page.getByText('Barn rewire and LED lighting').click();
  const qva = page.getByRole('list', { name: 'Quote vs actual' });
  await expect(qva).toContainText('Labour at cost');
  await expect(qva).toContainText(/Joe · .* × £24\.55\/h cost/);

  await page.goto('/reports');
  await page.getByRole('button', { name: 'This Year' }).click();
  await expect(page.getByText(/1 Jan 2026 –/)).toBeVisible(); // calendar year until 2027
  await expect(page.getByRole('list', { name: 'Profit per job' })).toContainText('at cost');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  expect((await download).suggestedFilename()).toMatch(/^lse-reports-2026-01-01-to-.*\.csv$/);
});
