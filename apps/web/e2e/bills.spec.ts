import { expect, test, type Page } from '@playwright/test';

async function apiFor(page: Page) {
  const session = await (await page.request.get('/api/auth/session')).json();
  const headers = { 'x-csrf-token': session.csrfToken as string };
  return {
    get: async (p: string) => (await page.request.get(`/api${p}`)).json(),
    post: async (p: string, data?: unknown) =>
      (await page.request.post(`/api${p}`, { data: data ?? {}, headers })).json(),
  };
}

async function quotedJob(page: Page, title: string) {
  const api = await apiFor(page);
  const customers = await api.get('/customers?q=Demo%20Farm');
  const q = await api.post('/quotes', {
    customerId: customers.items[0].id,
    title,
    lines: [
      { kind: 'labour', description: 'Install and test', qtyMilli: 2000 },
      { kind: 'material', description: 'Fused spur', unitPricePence: 1250 },
    ],
  });
  await api.post(`/quotes/${q.id}/send`);
  await api.post(`/quotes/${q.id}/accept`, { acceptedOptions: [] });
  const job = await api.post(`/quotes/${q.id}/convert`);
  return { api, job };
}

test('invoice PDF: draft preview can’t be shared; approved invoice shares the LSE layout', async ({
  page,
}) => {
  const { api, job } = await quotedJob(page, `PDF test ${Date.now()}`);
  const inv = await api.post(`/jobs/${job.id}/invoices`, { source: 'quote', mode: 'whole' });

  await page.goto(`/invoices/${inv.id}`);
  await page.getByRole('button', { name: /Preview PDF/ }).click();
  let sheet = page.getByRole('dialog', { name: 'Draft Invoice' });
  await expect(sheet.getByRole('note')).toContainText('Approve the invoice');
  await expect(sheet.getByRole('button', { name: 'Share' })).toHaveCount(0);
  await expect(sheet.getByText('How to pay')).toBeVisible();
  await sheet.getByRole('button', { name: 'Done' }).click();

  const approved = await api.post(`/invoices/${inv.id}/approve`);
  await page.reload();
  await page.getByRole('button', { name: /Preview PDF/ }).click();
  sheet = page.getByRole('dialog', { name: `Invoice ${approved.number}` });
  await expect(sheet.getByRole('button', { name: 'Share' })).toBeEnabled();
  await expect(sheet.getByText(`INV ${approved.number}`)).toBeVisible();
  await expect(sheet.getByText(/VAT/)).toHaveCount(0);

  const pdf = await page.request.get(`/api/invoices/${inv.id}/pdf`);
  expect(pdf.headers()['content-type']).toBe('application/pdf');
  expect(pdf.headers()['cache-control']).toContain('no-store');
  expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');
});

test('supplier bill from CSV: matches the price list, previews cost changes, owner applies to a job', async ({
  page,
}) => {
  const { api, job } = await quotedJob(page, `Bill test ${Date.now()}`);
  const stamp = Date.now();
  const supplier = `E2E Merchant ${stamp}`;
  const item = await api.post('/price-list', {
    code: `BL${stamp}`,
    description: `E2E bill cable ${stamp}`,
    unit: 'm',
    supplier,
    unitCostPence: 100,
  });
  const kit = await api.post('/kits', {
    name: `E2E bill kit ${stamp}`,
    lines: [{ itemId: item.id, qtyMilli: 10000 }],
  });

  await page.goto('/bills');
  await page.getByRole('button', { name: 'New bill' }).click();
  const sheet = page.getByRole('dialog', { name: 'New Bill' });
  await sheet.getByLabel('Supplier').fill(supplier);
  await sheet.getByLabel('Bill reference').fill(`INV-${stamp}`);
  await sheet.getByLabel('Job').selectOption(job.id);
  await sheet.getByRole('button', { name: 'CSV' }).click();
  await sheet
    .getByRole('textbox', { name: 'Bill CSV' })
    .fill(`Code,Description,Qty,Unit cost\nBL${stamp},Cable,10,1.30\n,Odd fixing,1,5.00\n`);
  await expect(sheet.getByText('2 lines read · £18.00')).toBeVisible();
  await sheet.getByRole('button', { name: 'Add' }).click();

  await expect(page.getByText('2 lines · 1 matched to the price list')).toBeVisible();
  await expect(page.getByRole('heading', { name: `${supplier} INV-${stamp}` })).toBeVisible();
  const lines = page.getByRole('list', { name: 'Bill lines' });
  await expect(lines.getByText('On list', { exact: true })).toBeVisible();
  await expect(lines.getByText('Not on list')).toBeVisible();

  await page.getByRole('button', { name: 'Review and Apply…' }).click();
  const review = page.getByRole('dialog', { name: 'Review Changes' });
  await expect(review.getByText('Nothing has changed yet')).toBeVisible();
  await expect(review.getByLabel(`E2E bill cable ${stamp} was £1.00, now £1.30`)).toBeVisible();
  await expect(review.getByLabel(`${kit.name} cost was £10.00, now £13.00`)).toBeVisible();
  expect((await api.get(`/price-list/${item.id}`)).unitCostPence).toBe(100);

  await review.getByRole('button', { name: 'Apply Bill' }).click();
  await expect(
    page.getByText(`Applied · 1 price updated · 2 added to job ${job.number}`),
  ).toBeVisible();
  expect((await api.get(`/price-list/${item.id}`)).unitCostPence).toBe(130);

  await page.goto(`/jobs/${job.id}`);
  await expect(page.getByText('Odd fixing')).toBeVisible();
  await expect(page.getByText('From supplier bill').first()).toBeVisible();

  await page.goto('/suppliers');
  await page.getByRole('link', { name: new RegExp(supplier) }).click();
  await expect(page.getByRole('link', { name: new RegExp(`INV-${stamp}`) })).toBeVisible();
});
