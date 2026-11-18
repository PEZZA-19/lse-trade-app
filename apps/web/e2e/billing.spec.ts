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

/** An accepted quote turned into a job, for a customer with a bill-payer email. */
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

test('invoice a quoted job: draft, owner approves, marks sent, records payment; job completes', async ({
  page,
}) => {
  const { api, job } = await quotedJob(page, `Invoice test ${Date.now()}`);
  await page.goto(`/jobs/${job.id}`);
  const section = page.getByRole('list', { name: 'Invoices for this job' });
  await section.getByRole('button', { name: 'New invoice…' }).click();
  const sheet = page.getByRole('dialog', { name: 'New Invoice' });
  await sheet.getByRole('button', { name: /Whole quote/ }).click();
  await sheet.getByRole('button', { name: 'Create' }).click();

  await expect(page.getByRole('heading', { name: 'Draft Invoice' })).toBeVisible();
  await expect(page.getByText('£102.50').first()).toBeVisible(); // 2h × £45 + £12.50
  // Nothing has a number or is sent until the owner taps.
  await page.getByRole('button', { name: 'Approve Invoice…' }).click();
  const approve = page.getByRole('dialog', { name: 'Approve Invoice' });
  await expect(approve.getByText(`It becomes invoice ${job.number}`)).toBeVisible();
  await expect(approve.getByText('Nothing is sent to the customer.')).toBeVisible();
  await approve.getByRole('button', { name: 'Approve' }).last().click();
  await expect(page.getByRole('heading', { name: `Invoice ${job.number}` })).toBeVisible();

  await page.getByRole('button', { name: 'Mark as Sent…' }).click();
  const send = page.getByRole('dialog', { name: 'Mark as Sent' });
  await expect(send.getByText(/doesn’t email it/)).toBeVisible();
  await send.getByRole('button', { name: 'Mark as Sent' }).last().click();
  await expect(page.getByText(`Invoice ${job.number} marked as sent`)).toBeVisible();

  // Part payment first, then the rest.
  await page.getByRole('button', { name: 'Record Payment', exact: true }).click();
  const pay = page.getByRole('dialog', { name: 'Record Payment' });
  await pay.getByLabel('Amount (£)').fill('50');
  await expect(pay.getByText(/£52.50 will still be owed/)).toBeVisible();
  await pay.getByRole('button', { name: 'Record £50.00' }).click();
  await expect(page.getByText('£50.00 recorded · £52.50 still owed')).toBeVisible();
  expect((await api.get(`/jobs/${job.id}`)).stage.systemKey).not.toBe('complete');

  await page.getByRole('button', { name: 'Record Payment', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Record Payment' })
    .getByRole('button', { name: 'Record £52.50' })
    .click();
  await expect(
    page.getByText(`Invoice ${job.number} paid in full · Job ${job.number} moved to Complete`),
  ).toBeVisible();
  expect((await api.get(`/jobs/${job.id}`)).stage.systemKey).toBe('complete');
  await expect(page.getByRole('list', { name: 'Payments' }).getByRole('listitem')).toHaveCount(2);
});

test('deposit by percentage from the job, listed under More → Invoices', async ({ page }) => {
  const { job } = await quotedJob(page, `Deposit test ${Date.now()}`);
  await page.goto(`/jobs/${job.id}`);
  await page.getByRole('button', { name: 'New invoice…' }).click();
  const sheet = page.getByRole('dialog', { name: 'New Invoice' });
  await sheet.getByRole('button', { name: /Percentage/ }).click();
  await sheet.getByLabel('Percentage (%)').fill('40');
  await expect(sheet.getByText('£41.00 of £102.50')).toBeVisible();
  await sheet.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByText(/40% of quote/)).toBeVisible();
  await page.goto('/more');
  await page
    .getByRole('main')
    .getByRole('link', { name: /Invoices/ })
    .click();
  await page.getByRole('button', { name: 'Drafts' }).click();
  await expect(
    page.getByRole('link', { name: new RegExp(`Draft · job ${job.number}`) }),
  ).toBeVisible();
});

test('price change recalculates kits and shows old and new cost; CSV import previews first', async ({
  page,
}) => {
  const api = await apiFor(page);
  const stamp = Date.now();
  const item = await api.post('/price-list', {
    code: `E2E${stamp}`,
    description: `E2E cable ${stamp}`,
    unit: 'm',
    unitCostPence: 100,
  });
  const kit = await api.post('/kits', {
    name: `E2E kit ${stamp}`,
    lines: [{ itemId: item.id, qtyMilli: 10000 }],
  });

  await page.goto(`/price-list/${item.id}`);
  await page.getByRole('button', { name: 'Edit' }).click();
  const sheet = page.getByRole('dialog', { name: 'Edit Item' });
  await sheet.getByLabel('Cost (£)').fill('1.25');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved · 1 kit recalculated')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Price history' }).getByText('Edited')).toBeVisible();

  await page.goto(`/kits/${kit.id}`);
  const changes = page.getByRole('list', { name: 'Kit cost changes' });
  await expect(changes.getByLabel('Cost was £10.00, now £12.50')).toBeVisible();

  await page.goto('/price-list');
  await page.getByRole('button', { name: 'Import' }).click();
  const imp = page.getByRole('dialog', { name: 'Import Price List' });
  await imp
    .getByRole('textbox', { name: 'CSV' })
    .fill(
      `Code,Description,Cost\nE2E${stamp},E2E cable ${stamp},1.40\nNEW${stamp},E2E new item ${stamp},2.00\n`,
    );
  await imp.getByRole('button', { name: 'Preview' }).click();
  await expect(imp.getByText('1 new · 1 updated · 0 unchanged')).toBeVisible();
  await expect(imp.getByText('Nothing is saved yet')).toBeVisible();
  expect((await api.get(`/price-list/${item.id}`)).unitCostPence).toBe(125);
  await imp.getByRole('button', { name: 'Import' }).click();
  await expect(page.getByText(/Imported: 1 new, 1 updated · 1 kit recalculated/)).toBeVisible();
  expect((await api.get(`/price-list/${item.id}`)).unitCostPence).toBe(140);
});

test('add a kit to a draft quote as one block, then expand it', async ({ page }) => {
  const api = await apiFor(page);
  const stamp = Date.now();
  const a = await api.post('/price-list', { description: `Socket ${stamp}`, unitCostPence: 300 });
  const b = await api.post('/price-list', { description: `Box ${stamp}`, unitCostPence: 50 });
  const kit = await api.post('/kits', {
    name: `Socket kit ${stamp}`,
    lines: [
      { itemId: a.id, qtyMilli: 1000 },
      { itemId: b.id, qtyMilli: 2000 },
    ],
  });
  const customers = await api.get('/customers?q=Demo%20Farm');
  const q = await api.post('/quotes', {
    customerId: customers.items[0].id,
    title: `Kit quote ${stamp}`,
  });

  await page.goto(`/quotes/${q.id}`);
  await page.getByRole('button', { name: 'Add kit' }).click();
  await page
    .getByRole('dialog', { name: 'Add Kit' })
    .getByRole('button', { name: new RegExp(kit.name) })
    .click();
  const add = page.getByRole('dialog', { name: kit.name });
  await add.getByLabel('How many kits').fill('3');
  await add.getByRole('button', { name: 'Add' }).click();
  const lines = page.getByRole('list', { name: 'Quote lines' });
  await expect(
    lines.getByRole('button', { name: new RegExp(`${kit.name}.*Kit.*3 × £5.20`) }),
  ).toBeVisible();
  await expect
    .poll(async () => (await api.get(`/quotes/${q.id}`)).current.lines[0]?.kit?.kitId)
    .toBe(kit.id);

  await lines.getByRole('button', { name: new RegExp(kit.name) }).click();
  await page
    .getByRole('dialog', { name: kit.name })
    .getByRole('button', { name: 'Expand into Items' })
    .click();
  await expect(lines.getByRole('button', { name: new RegExp(`Socket ${stamp}`) })).toBeVisible();
  await expect(lines.getByRole('button', { name: new RegExp(`Box ${stamp}`) })).toBeVisible();
  await expect
    .poll(async () =>
      (await api.get(`/quotes/${q.id}`)).current.lines.map((l: { qtyMilli: number }) => l.qtyMilli),
    )
    .toEqual([3000, 6000]);
});

test('a kit with fitting time adds its own labour line, kept in step and editable per quote', async ({
  page,
}) => {
  const api = await apiFor(page);
  const stamp = Date.now();
  const a = await api.post('/price-list', { description: `Spur ${stamp}`, unitCostPence: 300 });
  const kit = await api.post('/kits', {
    name: `Spur kit ${stamp}`,
    labourMinutes: 30,
    lines: [{ itemId: a.id, qtyMilli: 2000, labourMinutes: 15 }],
  });
  expect(kit.labourMinutes).toBe(60);
  const customers = await api.get('/customers?q=Demo%20Farm');
  const q = await api.post('/quotes', {
    customerId: customers.items[0].id,
    title: `Kit labour quote ${stamp}`,
  });

  await page.goto(`/quotes/${q.id}`);
  await page.getByRole('button', { name: 'Add kit' }).click();
  await page
    .getByRole('dialog', { name: 'Add Kit' })
    .getByRole('button', { name: new RegExp(kit.name) })
    .click();
  const add = page.getByRole('dialog', { name: kit.name });
  await expect(add.getByLabel('Labour hours per kit')).toHaveValue('1');
  await add.getByLabel('How many kits').fill('2');
  await add.getByRole('button', { name: 'Add' }).click();
  const saved = async () =>
    (await api.get(`/quotes/${q.id}`)).current.lines.map(
      (l: { kind: string; qtyMilli: number; unitPricePence: number | null }) =>
        `${l.kind}:${l.qtyMilli}`,
    );
  await expect.poll(saved).toEqual(['material:2000', 'labour:2000']);

  // Three kits and 1.5 h each at £60/h: the labour line follows.
  const lines = page.getByRole('list', { name: 'Quote lines' });
  await lines.getByRole('button', { name: new RegExp(`^${kit.name}`) }).click();
  const edit = page.getByRole('dialog', { name: kit.name });
  await edit.getByLabel('How many kits').fill('3');
  await edit.getByLabel('Labour hours per kit').fill('1.5');
  await edit.getByLabel('Charge-out rate (£/h)').fill('60');
  await edit.getByRole('button', { name: 'Done' }).click();
  await expect.poll(saved).toEqual(['material:3000', 'labour:4500']);
  const labour = (await api.get(`/quotes/${q.id}`)).current.lines[1];
  expect(labour).toMatchObject({ description: `Labour: ${kit.name}`, unitPricePence: 6000 });

  // Removing the kit takes its labour line with it.
  await lines.getByRole('button', { name: new RegExp(`^${kit.name}`) }).click();
  await page
    .getByRole('dialog', { name: kit.name })
    .getByRole('button', { name: 'Remove Kit' })
    .click();
  await expect.poll(saved).toEqual([]);
});

test('a minus (credit) line on a quote takes money off the total', async ({ page }) => {
  const api = await apiFor(page);
  const stamp = Date.now();
  const customers = await api.get('/customers?q=Demo%20Farm');
  const q = await api.post('/quotes', {
    customerId: customers.items[0].id,
    title: `Credit quote ${stamp}`,
    lines: [{ kind: 'labour', description: 'Rewire', qtyMilli: 10000, unitPricePence: 4500 }],
  });
  await page.goto(`/quotes/${q.id}`);
  await page.getByRole('button', { name: 'Add line' }).click();
  const line = page.getByRole('dialog', { name: 'Add Line' });
  await line.getByLabel('Description').fill('Rent payments');
  await line.getByRole('switch', { name: 'Minus line (credit)' }).check();
  await line.getByLabel('Amount off (£)').fill('120');
  await expect(line.getByText('-£120.00').last()).toBeVisible();
  await line.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByLabel('Total £330.00')).toBeVisible();
  await expect
    .poll(async () => (await api.get(`/quotes/${q.id}`)).current.lines[1]?.unitPricePence)
    .toBe(-12000);
  // Editing keeps it a minus line.
  await page
    .getByRole('list', { name: 'Quote lines' })
    .getByRole('button', { name: /Rent payments/ })
    .click();
  const edit = page.getByRole('dialog', { name: 'Edit Line' });
  await expect(edit.getByRole('switch', { name: 'Minus line (credit)' })).toBeChecked();
  await expect(edit.getByLabel('Amount off (£)')).toHaveValue('120.00');
});
