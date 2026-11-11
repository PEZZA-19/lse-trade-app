import { expect, test, type Page } from '@playwright/test';

/** Adds an enquiry by hand, as Joe would after a phone call, and opens it. */
async function addEnquiry(page: Page, f: { name: string; email?: string; message: string }) {
  await page.goto('/enquiries');
  await page.getByRole('button', { name: 'New enquiry' }).click();
  const sheet = page.getByRole('dialog', { name: 'New Enquiry' });
  await sheet.getByLabel('Name').fill(f.name);
  await sheet.getByLabel('Phone').fill('07700 900' + String(Date.now()).slice(-3));
  if (f.email) await sheet.getByLabel('Email').fill(f.email);
  await sheet.getByLabel('What they need').fill(f.message);
  await sheet.getByRole('button', { name: 'Add' }).click();
  await expect(page).toHaveURL(/\/enquiries\/[0-9a-f-]+$/);
  await expect(page.getByText(f.message).first()).toBeVisible();
}

test('an AI reply draft waits for approval, holds two minutes, and Stop sends nothing', async ({
  page,
}) => {
  const name = `E2E Reply ${Date.now()}`;
  await addEnquiry(page, {
    name,
    email: 'e2e.reply@example.test',
    message: 'Kitchen downlights keep flickering.',
  });
  await page.getByRole('button', { name: 'Draft a Reply' }).click();
  await expect(page).toHaveURL(/\/approvals\/[0-9a-f-]+$/);
  await expect(page.getByRole('note')).toContainText('Will do:');
  await expect(page.getByLabel('Email preview')).toContainText('e2e.reply@example.test');
  await expect(page.locator('.pill', { hasText: 'Waiting for you' })).toBeVisible();
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: /Sending in 1:5\d|Sending in 2:00/ }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.locator('.pill', { hasText: 'Waiting for you' })).toBeVisible();
  await page.getByRole('button', { name: 'Discard' }).click();
  await expect(page.getByText('Discarded', { exact: true }).first()).toBeVisible();
  const log = page.getByRole('list', { name: 'Log' });
  for (const step of [/Drafted/i, /Approved/i, /Stopped/i, /Discarded/i])
    await expect(log).toContainText(step);
});

test('a quote draft from an enquiry becomes a draft quote when approved', async ({ page }) => {
  const name = `E2E Quote ${Date.now()}`;
  await addEnquiry(page, { name, message: 'Two double sockets and an outside light, please.' });
  await page.getByRole('button', { name: 'Draft a Quote' }).click();
  await expect(page).toHaveURL(/\/approvals\/[0-9a-f-]+$/);
  await expect(page.getByRole('list', { name: 'Quote lines' })).toBeVisible();
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.locator('.pill', { hasText: 'Done' })).toBeVisible();
  await page.goto('/enquiries');
  await page
    .getByRole('radio', { name: 'Done' })
    .or(page.getByRole('button', { name: 'Done' }))
    .first()
    .click();
  await expect(page.getByRole('link', { name: new RegExp(name) })).toBeVisible();
});

test('convert to a job, and reject with a private reason', async ({ page }) => {
  const job = `E2E Job ${Date.now()}`;
  await addEnquiry(page, { name: job, message: 'Fuse board buzzing.' });
  await page.getByRole('button', { name: 'Job', exact: true }).click();
  await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]+$/);
  await expect(page.getByText(job).first()).toBeVisible();

  const no = `E2E Reject ${Date.now()}`;
  await addEnquiry(page, { name: no, message: 'Can you fix my car radio?' });
  await page.getByRole('button', { name: 'Reject…' }).click();
  const sheet = page.getByRole('dialog', { name: 'Reject Enquiry' });
  await sheet.getByLabel('Reason (optional)').fill('Not electrical work we do');
  await sheet.getByRole('button', { name: 'Reject' }).click();
  await expect(page.getByText('Not electrical work we do')).toBeVisible();
});
