import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const sample = (name: string) =>
  fileURLToPath(new URL(`../public/samples/${name}`, import.meta.url));

/** Synthetic sample references: clear earlier runs' drafts so the test can repeat. */
async function clearSampleDrafts(page: Page) {
  const session = await (await page.request.get('/api/auth/session')).json();
  const headers = { 'x-csrf-token': session.csrfToken as string };
  const drafts = await (await page.request.get('/api/supplier-bills?status=draft')).json();
  for (const b of drafts as { id: string; reference: string }[])
    if (/^GUR\/9001|^900530$/.test(b.reference))
      await page.request.delete(`/api/supplier-bills/${b.id}`, { headers });
}

test('a CEF PDF with four invoices becomes four checked drafts', async ({ page }) => {
  await clearSampleDrafts(page);
  await page.goto('/bills');
  await page.getByRole('button', { name: 'New bill' }).click();
  const sheet = page.getByRole('dialog', { name: 'New Bill' });
  await sheet.getByRole('button', { name: 'PDF' }).click();
  await sheet.getByLabel('Bill PDF').setInputFiles(sample('sample-cef-invoices.pdf'));
  await expect(sheet.getByRole('status')).toHaveText('4 invoices found in this PDF.');
  const second = sheet.getByRole('list', { name: 'CEF GUR/900102' });
  await expect(second).toContainText('10 × £0.70 less 35% · F4P AA1000');
  await expect(second).toContainText('£16.90');
  await expect(sheet.getByText('Adds up')).toHaveCount(4);
  await sheet.getByRole('button', { name: 'Save 4 Drafts' }).click();
  await expect(page).toHaveURL(/\/bills$/);
  for (const ref of ['GUR/900101', 'GUR/900102', 'GUR/900151', 'GUR/900152'])
    await expect(page.getByRole('link', { name: new RegExp(ref) })).toBeVisible();
  await page.getByRole('link', { name: /GUR\/900102/ }).click();
  await expect(page.getByText(/due 7 Dec/)).toBeVisible();
});

test('a DOCI PDF reads RRP and the order reference, and saves a draft', async ({ page }) => {
  await clearSampleDrafts(page);
  await page.goto('/bills');
  await page.getByRole('button', { name: 'New bill' }).click();
  const sheet = page.getByRole('dialog', { name: 'New Bill' });
  await sheet.getByRole('button', { name: 'PDF' }).click();
  await sheet.getByLabel('Bill PDF').setInputFiles(sample('sample-doci-invoice.pdf'));
  const bill = sheet.getByRole('list', { name: 'DOCI 900530' });
  await expect(bill).toContainText('RRP £61.19');
  await expect(bill).toContainText('OLD BAKERY REWIRE');
  await expect(bill).toContainText('£85.26');
  await sheet.getByRole('button', { name: 'Save as Draft' }).click();
  await expect(page.getByRole('heading', { name: 'DOCI 900530' })).toBeVisible();
});

test('a CI Lighting statement opens the reconciliation with the balance due', async ({ page }) => {
  await page.goto('/bills');
  await page.getByLabel('Statement PDF').setInputFiles(sample('sample-cilighting-statement.pdf'));
  await expect(page).toHaveURL(/\/suppliers\/statement$/);
  await expect(page.getByText('Balance checks')).toBeVisible();
  const summary = page.getByRole('list', { name: 'Statement summary' });
  await expect(summary).toContainText('£747.15');
  await expect(page.getByRole('list', { name: 'Not in the app' })).toContainText('91585:1');
  await expect(page.getByRole('list', { name: 'Payments' })).toContainText('BACS');
});
