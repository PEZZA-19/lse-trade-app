import { expect, test } from '@playwright/test';

/** The core loop against the real API and Postgres: customer → quote → sent → accepted → job. */
test('quote to job, end to end', async ({ page }) => {
  const name = `E2E Customer ${Date.now()}`;

  await page.goto('/customers');
  await page.getByRole('button', { name: 'Add customer' }).click();
  const sheet = page.getByRole('dialog', { name: 'New Customer' });
  await sheet.getByLabel('Name').fill(name);
  await sheet.getByLabel('Address').fill('1 Test Lane, Sark');
  await sheet.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();

  await page.getByRole('button', { name: 'New quote' }).click();
  const q = page.getByRole('dialog', { name: 'New Quote' });
  await q.getByLabel('Title').fill('Garage sockets');
  await q.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: /^Q-\d{4}$/ })).toBeVisible();

  // Mark as sent is disabled until the quote has a price.
  await expect(page.getByRole('button', { name: 'Mark as sent' })).toBeDisabled();

  await page.getByRole('button', { name: 'Add line' }).click();
  const line = page.getByRole('dialog', { name: 'Add Line' });
  await line.getByRole('button', { name: 'Labour' }).click();
  await line.getByLabel('Description').fill('Fit two double sockets');
  await line.getByLabel('Hours').fill('3');
  await expect(line.getByText('£135.00').last()).toBeVisible(); // 3h × £45 default rate
  await line.getByRole('button', { name: 'Add' }).click();

  // Honest save state: only "Saved" after the server confirms.
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  await expect(page.getByLabel('Total £135.00')).toBeVisible();

  await page.getByRole('button', { name: 'Mark as sent' }).click();
  await expect(page.getByText('Sent', { exact: true }).first()).toBeVisible();

  await page.getByRole('button', { name: 'Customer said yes' }).click();
  await page
    .getByRole('dialog', { name: 'Customer Said Yes' })
    .getByRole('button', { name: 'Accept' })
    .click();

  await page.getByRole('button', { name: 'Create job' }).click();
  await expect(page.getByRole('heading', { name: /^Job \d+$/ })).toBeVisible();
  await expect(page.getByText('Fit two double sockets')).toBeVisible();
  await expect(page.getByText(/From quote Q-\d{4}/)).toBeVisible();

  // The quote now points at the job and can't be converted again.
  await page.getByText(/From quote Q-\d{4}/).click();
  await expect(page.getByRole('button', { name: 'Create job' })).toHaveCount(0);
  await expect(page.getByText('Created from this quote. Make changes on the job.')).toBeVisible();
});

test('jobs list shows seeded jobs and filters', async ({ page }) => {
  await page.goto('/jobs');
  await expect(page.getByRole('heading', { name: 'Jobs', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'All' }).click();
  await expect(page.getByText('Annual PAT testing')).toBeVisible();
  await page.getByRole('searchbox').fill('PAT');
  await expect(page.getByText('Annual PAT testing')).toBeVisible();
  await expect(page.getByText('Barn rewire and LED lighting')).toHaveCount(0);
});
