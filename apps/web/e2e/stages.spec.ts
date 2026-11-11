import { expect, test } from '@playwright/test';

/** Job stages end to end: swipe action → stage sheet, history on the job, Active filter. */
test('change a job’s stage from the list and the job screen; history and Active filter follow', async ({
  page,
}) => {
  const session = await (await page.request.get('/api/auth/session')).json();
  const headers = { 'x-csrf-token': session.csrfToken as string };
  const customers = await (await page.request.get('/api/customers?q=Demo%20Farm')).json();
  const title = `Stage test ${Date.now()}`;
  const job = await (
    await page.request.post('/api/jobs', {
      data: { customerId: customers.items[0].id, title },
      headers,
    })
  ).json();

  await page.goto('/jobs');
  await page.getByRole('searchbox').fill(title);
  const row = page.getByRole('listitem').filter({ hasText: title });
  await expect(row.getByText('Unassigned')).toBeVisible();

  // The swipe actions are real buttons under the row: "Stage" opens the stage sheet.
  await row.getByRole('button', { name: 'Stage' }).focus();
  await page.keyboard.press('Enter');
  const sheet = page.getByRole('dialog', { name: `Move job ${job.number}` });
  await sheet.getByRole('button', { name: /On Hold/ }).click();
  await expect(page.getByText(`Job ${job.number} moved to On Hold`)).toBeVisible();
  await expect(row.getByText('On Hold', { exact: true })).toBeVisible();

  // Job screen: history shows the change, then a manual change from the stage picker.
  await row.getByRole('link').click();
  const history = page.getByRole('list', { name: 'Stage history' });
  await expect(history.getByText('Unassigned → On Hold')).toBeVisible();
  await expect(history.getByText(/Changed by hand · Joe/)).toBeVisible();
  await page.getByRole('combobox', { name: 'Stage' }).selectOption({ label: 'Cancelled' });
  await expect(history.getByText('On Hold → Cancelled')).toBeVisible();

  // Cancelled drops off the Active list but is still under All.
  await page.getByRole('link', { name: 'Jobs' }).first().click();
  await page.getByRole('searchbox').fill(title);
  await expect(page.getByRole('heading', { name: 'No matches' })).toBeVisible();
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await expect(row.getByText('Cancelled')).toBeVisible();
});
