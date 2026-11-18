import { expect, test, type Page } from '@playwright/test';

async function apiFor(page: Page) {
  const session = await (await page.request.get('/api/auth/session')).json();
  const headers = { 'x-csrf-token': session.csrfToken as string };
  return {
    get: async (p: string) => (await page.request.get(`/api${p}`)).json(),
    post: async (p: string, data?: unknown) =>
      (await page.request.post(`/api${p}`, { data: data ?? {}, headers })).json(),
    patch: async (p: string, data: unknown) =>
      (await page.request.patch(`/api${p}`, { data, headers })).json(),
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

test('kit labour is optional: items only (labour switched off) or labour only (no items)', async ({
  page,
}) => {
  const api = await apiFor(page);
  const stamp = Date.now();
  const a = await api.post('/price-list', { description: `Gland ${stamp}`, unitCostPence: 200 });
  const withTime = await api.post('/kits', {
    name: `Gland kit ${stamp}`,
    labourMinutes: 30,
    lines: [{ itemId: a.id, qtyMilli: 1000 }],
  });
  const labourOnly = await api.post('/kits', {
    name: `Test and inspect ${stamp}`,
    labourMinutes: 90,
    lines: [],
  });
  const customers = await api.get('/customers?q=Demo%20Farm');
  const q = await api.post('/quotes', {
    customerId: customers.items[0].id,
    title: `Optional kit labour ${stamp}`,
  });
  const saved = async () =>
    (await api.get(`/quotes/${q.id}`)).current.lines.map(
      (l: { kind: string; qtyMilli: number }) => `${l.kind}:${l.qtyMilli}`,
    );
  const pick = async (name: string) => {
    await page.getByRole('button', { name: 'Add kit' }).click();
    await page
      .getByRole('dialog', { name: 'Add Kit' })
      .getByRole('button', { name: new RegExp(name) })
      .click();
    return page.getByRole('dialog', { name });
  };

  await page.goto(`/quotes/${q.id}`);
  // Items only: the kit has fitting time, but labour is switched off for this quote.
  const add = await pick(withTime.name);
  const sw = add.getByRole('switch', { name: 'Include labour' });
  await expect(sw).toBeChecked();
  await sw.uncheck();
  await expect(add.getByLabel('Labour hours per kit')).toHaveCount(0);
  await add.getByRole('button', { name: 'Add' }).click();
  await expect.poll(saved).toEqual(['material:1000']);

  // Labour only: a kit with no items adds just its labour line (1.5 h).
  const add2 = await pick(labourOnly.name);
  await expect(add2.getByRole('switch', { name: 'Include labour' })).toBeChecked();
  await expect(add2.getByText('Labour only: this kit has no items.')).toBeVisible();
  await add2.getByRole('button', { name: 'Add' }).click();
  await expect.poll(saved).toEqual(['material:1000', 'labour:1500']);
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
  await edit.getByRole('button', { name: 'Cancel' }).click();

  // A quote can never come to less than £0 (Joe, 18 Nov 2026): the line isn't added, and it says why.
  await page.getByRole('button', { name: 'Add line' }).click();
  const more = page.getByRole('dialog', { name: 'Add Line' });
  await more.getByLabel('Description').fill('More rent');
  await more.getByRole('switch', { name: 'Minus line (credit)' }).check();
  await more.getByLabel('Amount off (£)').fill('400');
  await more.getByRole('button', { name: 'Add' }).click();
  await expect(
    page.getByText(/A quote can’t come to less than £0\. This one comes to -£70\.00/),
  ).toBeVisible();
  await expect(page.getByLabel('Total £330.00')).toBeVisible();
  await expect.poll(async () => (await api.get(`/quotes/${q.id}`)).current.lines.length).toBe(2);
});

test('a job below £0 is issued as a customer credit and comes off the next invoice', async ({
  page,
}) => {
  const api = await apiFor(page);
  const stamp = Date.now();
  const cust = await api.post('/customers', {
    name: `Credit customer ${stamp}`,
    email: `credit-${stamp}@example.com`,
  });
  const jobFor = async (lines: unknown[]) => {
    const q = await api.post('/quotes', { customerId: cust.id, title: `Job ${stamp}`, lines });
    await api.post(`/quotes/${q.id}/send`);
    await api.post(`/quotes/${q.id}/accept`, { acceptedOptions: [] });
    const job = await api.post(`/quotes/${q.id}/convert`);
    return api.post(`/jobs/${job.id}/invoices`, { source: 'quote', mode: 'whole' });
  };
  // Quotes can't go below £0, so the minus line goes on the draft invoice (like jobs 14 and 108).
  const work = await jobFor([
    { kind: 'labour', description: 'Work', qtyMilli: 1000, unitPricePence: 10000 },
  ]);
  const credit = await api.patch(`/invoices/${work.id}`, {
    lines: [
      { kind: 'labour', description: 'Work', qtyMilli: 1000, unitPricePence: 10000 },
      { kind: 'material', description: 'Rent payments', qtyMilli: 1000, unitPricePence: -25000 },
    ],
  });
  await page.goto(`/invoices/${credit.id}`);
  await expect(page.getByRole('heading', { name: 'Draft Credit Note' })).toBeVisible();
  await page.getByRole('button', { name: 'Issue Customer Credit…' }).click();
  await page
    .getByRole('dialog', { name: 'Issue Customer Credit' })
    .getByRole('button', {
      name: 'Issue Credit',
      exact: true,
    })
    .last()
    .click();
  await expect(page.getByRole('heading', { name: /^Credit Note CN-\d+$/ })).toBeVisible();
  // A credit has no due date or payment terms: it comes off the next invoice.
  await expect(page.getByText('Credit date')).toBeVisible();
  await expect(page.getByText(/comes off this customer’s next invoice/)).toBeVisible();
  await expect(page.getByText(/days after approval|Payment is due/)).toHaveCount(0);

  await page.goto(`/customers/${cust.id}`);
  await expect(page.getByRole('list', { name: 'Customer credit' })).toContainText('£150.00 to use');

  const next = await jobFor([
    { kind: 'labour', description: 'Lights', qtyMilli: 1000, unitPricePence: 20000 },
  ]);
  await page.goto(`/invoices/${next.id}`);
  await page.getByRole('button', { name: 'Approve Invoice…' }).click();
  const sheet = page.getByRole('dialog', { name: 'Approve Invoice' });
  // Never silent: the sheet asks, with the credit on by default and saying what it does.
  const use = sheet.getByRole('switch', { name: 'Use their credit on this invoice' });
  await expect(use).toBeChecked();
  await expect(sheet).toContainText(
    '£150.00 of their customer credit comes off it, so they owe £50.00',
  );
  await use.uncheck();
  await expect(sheet).toContainText('stays on their account for a later invoice');
  await use.check();
  await sheet.getByRole('button', { name: 'Approve', exact: true }).last().click();
  await expect(page.getByText(/Customer credit CN-\d+ used/)).toBeVisible();
  await expect.poll(async () => (await api.get(`/invoices/${next.id}`)).balancePence).toBe(5000);

  // Joe, 18 Nov 10:27: the choice can be made on a quote not yet invoiced, and carries through.
  const more = await jobFor([
    { kind: 'labour', description: 'Credit back', qtyMilli: 1000, unitPricePence: 10000 },
  ]);
  void more; // A second credit for this customer: £100 labour less £250 rent.
  const credit2 = await api.patch(`/invoices/${more.id}`, {
    lines: [
      { kind: 'labour', description: 'Work', qtyMilli: 1000, unitPricePence: 10000 },
      { kind: 'material', description: 'Rent payments', qtyMilli: 1000, unitPricePence: -25000 },
    ],
  });
  await api.post(`/invoices/${credit2.id}/approve`);
  const q2 = await api.post('/quotes', {
    customerId: cust.id,
    title: 'Garden lights',
    lines: [{ kind: 'labour', description: 'Garden', qtyMilli: 1000, unitPricePence: 30000 }],
  });
  await page.goto(`/quotes/${q2.id}`);
  const onQuote = page.getByRole('switch', { name: 'Use their credit when this work is invoiced' });
  await expect(onQuote).not.toBeChecked();
  await onQuote.click();
  await expect(onQuote).toBeChecked();
  await expect(
    page.getByText('Their credit will be used on the invoice for this work'),
  ).toBeVisible();
  await expect(page.getByText(/of their credit comes off the invoice for this work/)).toBeVisible();
  // The quote itself isn't reduced.
  await expect(page.getByText('£300.00').first()).toBeVisible();
  await onQuote.click();
  await expect(onQuote).not.toBeChecked();
  await expect(page.getByText('Their credit stays on their account')).toBeVisible();
  await api.post(`/quotes/${q2.id}/send`);
  await api.post(`/quotes/${q2.id}/accept`, { acceptedOptions: [] });
  const job2 = await api.post(`/quotes/${q2.id}/convert`);
  const inv2 = await api.post(`/jobs/${job2.id}/invoices`, { source: 'quote', mode: 'whole' });
  await page.goto(`/invoices/${inv2.id}`);
  await page.getByRole('button', { name: 'Approve Invoice…' }).click();
  const sheet2 = page.getByRole('dialog', { name: 'Approve Invoice' });
  // "Keep it" on the quote: off here by default, and still asked.
  await expect(
    sheet2.getByRole('switch', { name: 'Use their credit on this invoice' }),
  ).not.toBeChecked();
  await expect(sheet2).toContainText('stays on their account for a later invoice');
  await sheet2.getByRole('button', { name: 'Approve', exact: true }).last().click();
  // Joe, 11:34: once invoiced, it lowers the job's costs; the invoice and what's owed stay as billed.
  await page.getByRole('button', { name: 'Use Customer Credit…' }).click();
  const use2 = page.getByRole('dialog', { name: 'Use Customer Credit' });
  await expect(use2).toContainText('stays as billed');
  await expect(use2).toContainText('the job’s profit goes up');
  await use2.getByRole('button', { name: 'Use Credit', exact: true }).last().click();
  await expect(page.getByText('Customer credit used · the job’s costs are lower')).toBeVisible();
  await expect(page.getByText(/lowers the job’s costs, not what’s owed/)).toBeVisible();
});
