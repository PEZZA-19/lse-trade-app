import { describe, expect, it } from 'vitest';
import { client, clientFor, seedCustomer, type Client } from './api-helpers';
import { addMember, adminSql } from './helpers';

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const todayIso = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Guernsey' }).format(new Date());

async function ready(c: Client) {
  const r = await c.req('PATCH', '/api/settings', {
    bankAccountName: 'Test Electrical',
    bankSortCode: '400000',
    bankAccountNumber: '12345678',
  });
  expect(r.status).toBe(200);
}

/** Accepted quote (labour 8h @ £45 = £360, cable £62, carriage £0) converted to a job. Total £422. */
async function quotedJob(c: Client) {
  const cust = await seedCustomer(c);
  const q = (
    await c.req('POST', '/api/quotes', {
      customerId: cust.id,
      title: 'Barn rewire',
      lines: [
        { kind: 'labour', description: 'Install and test', qtyMilli: 8000 },
        {
          kind: 'material',
          description: 'Twin & earth 2.5mm (m)',
          qtyMilli: 50000,
          unitCostPence: 95,
        },
        { kind: 'carriage', description: 'Carriage', unitPricePence: 0 },
      ],
    })
  ).body;
  await c.req('POST', `/api/quotes/${q.id}/send`);
  await c.req('POST', `/api/quotes/${q.id}/accept`, { acceptedOptions: [] });
  const job = (await c.req('POST', `/api/quotes/${q.id}/convert`)).body;
  return { cust, quote: q, job };
}

/** A job with no quote and two timer entries: 90 min and 30 min. */
async function timedJob(c: Client) {
  const cust = await seedCustomer(c);
  const job = (await c.req('POST', '/api/jobs', { customerId: cust.id, title: 'Fault finding' }))
    .body;
  for (const [start, stop] of [
    [300, 210],
    [120, 90],
  ] as const) {
    await c.req('POST', `/api/jobs/${job.id}/timer/start`, { at: ago(start) });
    await c.req('POST', `/api/jobs/${job.id}/timer/stop`, { at: ago(stop) });
  }
  return { cust, job };
}

const pay = (c: Client, id: string, amountPence: number) =>
  c.req('POST', `/api/invoices/${id}/payments`, {
    amountPence,
    paidOn: todayIso(),
    method: 'bank_transfer',
    reference: 'FARM 122',
  });

async function approveAndSend(c: Client, id: string) {
  const a = await c.req('POST', `/api/invoices/${id}/approve`);
  expect(a.status, JSON.stringify(a.body)).toBe(200);
  const s = await c.req('POST', `/api/invoices/${id}/mark-sent`);
  expect(s.status).toBe(200);
  return s.body;
}

describe('invoices from a quote', () => {
  it('deposit, then remainder; numbers follow the job (122, 122-2) and are given on approval', async () => {
    const c = await client();
    await ready(c);
    const { job, quote } = await quotedJob(c);
    expect(job.number).toBe('122');

    const dep = await c.req('POST', `/api/jobs/${job.id}/invoices`, {
      source: 'quote',
      mode: 'deposit',
      amountPence: 10000,
    });
    expect(dep.status).toBe(201);
    expect(dep.body).toMatchObject({
      number: null,
      status: 'draft',
      totalPence: 10000,
      quoteNumber: quote.number,
    });
    expect(dep.body.lines[0]).toMatchObject({
      kind: 'deposit',
      description: `Deposit for quote ${quote.number}: Barn rewire`,
    });
    expect(dep.body.termsText).toMatch(/14 days.*5% per month/);

    const inv1 = await approveAndSend(c, dep.body.id);
    expect(inv1).toMatchObject({
      number: '122',
      status: 'sent',
      approvedByName: 'Test Owner',
      issueDate: todayIso(),
    });
    expect(inv1.dueDate > inv1.issueDate).toBe(true);
    expect(inv1.approvedAt).toBeTruthy();

    // "Whole" no longer allowed once part is invoiced.
    expect(
      (await c.req('POST', `/api/jobs/${job.id}/invoices`, { source: 'quote', mode: 'whole' }))
        .status,
    ).toBe(422);
    const rest = await c.req('POST', `/api/jobs/${job.id}/invoices`, {
      source: 'quote',
      mode: 'remainder',
    });
    expect(rest.status).toBe(201);
    expect(rest.body.totalPence).toBe(32200);
    // Zero carriage line is left off; the deposit is taken off by number.
    expect(rest.body.lines.map((l: { kind: string }) => l.kind)).toEqual([
      'labour',
      'material',
      'adjustment',
    ]);
    expect(rest.body.lines[2].description).toBe('Less already invoiced (122)');
    const inv2 = await approveAndSend(c, rest.body.id);
    expect(inv2.number).toBe('122-2');

    const summary = (await c.req('GET', `/api/jobs/${job.id}/invoicing`)).body;
    expect(summary.quote).toMatchObject({
      totalPence: 42200,
      invoicedPence: 42200,
      remainingPence: 0,
    });
    expect(
      (
        await c.req('POST', `/api/jobs/${job.id}/invoices`, {
          source: 'quote',
          mode: 'percent',
          percentBp: 1000,
        })
      ).status,
    ).toBe(422);
  });

  it('percentage invoices round to the penny and cannot exceed what is left', async () => {
    const c = await client();
    const { job } = await quotedJob(c);
    const r = await c.req('POST', `/api/jobs/${job.id}/invoices`, {
      source: 'quote',
      mode: 'percent',
      percentBp: 3333,
    });
    expect(r.body.totalPence).toBe(14065); // 33.33% of £422 = £140.6526
    expect(r.body.lines[0].description).toMatch(/^33.33% of quote/);
    const tooMuch = await c.req('POST', `/api/jobs/${job.id}/invoices`, {
      source: 'quote',
      mode: 'deposit',
      amountPence: 42200,
    });
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body.error.message).toMatch(/more than the £281.35 left/);
  });

  it('paying everything moves the job to Complete via markFullyInvoicedAndPaid', async () => {
    const c = await client();
    await ready(c);
    const { job } = await quotedJob(c);
    const whole = (
      await c.req('POST', `/api/jobs/${job.id}/invoices`, { source: 'quote', mode: 'whole' })
    ).body;
    expect(whole.totalPence).toBe(42200);
    await approveAndSend(c, whole.id);

    const part = await pay(c, whole.id, 20000);
    expect(part.status).toBe(201);
    expect(part.body).toMatchObject({
      status: 'part_paid',
      paidPence: 20000,
      balancePence: 22200,
      jobCompleted: false,
    });
    expect((await c.req('GET', `/api/jobs/${job.id}`)).body.stage.systemKey).not.toBe('complete');

    expect((await pay(c, whole.id, 22201)).status).toBe(422); // more than owed
    const full = await pay(c, whole.id, 22200);
    expect(full.body).toMatchObject({ status: 'paid', balancePence: 0, jobCompleted: true });
    expect(full.body.payments).toHaveLength(2);
    expect(full.body.payments[0]).toMatchObject({
      method: 'bank_transfer',
      recordedByName: 'Test Owner',
    });
    const after = (await c.req('GET', `/api/jobs/${job.id}`)).body;
    expect(after.stage.systemKey).toBe('complete');
    expect(after.history.map((h: { cause: string }) => h.cause)).toContain('invoiced_and_paid');
    expect((await pay(c, whole.id, 1)).status).toBe(409);
  });

  it('a paid deposit alone does not complete the job', async () => {
    const c = await client();
    await ready(c);
    const { job } = await quotedJob(c);
    const dep = (
      await c.req('POST', `/api/jobs/${job.id}/invoices`, {
        source: 'quote',
        mode: 'deposit',
        amountPence: 5000,
      })
    ).body;
    await approveAndSend(c, dep.id);
    expect((await pay(c, dep.id, 5000)).body).toMatchObject({
      status: 'paid',
      jobCompleted: false,
    });
  });
});

describe('time and materials', () => {
  it('bills unbilled timer entries at the labour rate and reserves them', async () => {
    const c = await client();
    await ready(c);
    const { job } = await timedJob(c);
    const before = (await c.req('GET', `/api/jobs/${job.id}/invoicing`)).body;
    expect(before).toMatchObject({ quote: null, unbilledMinutes: 120, unbilledLabourPence: 9000 });
    const r = await c.req('POST', `/api/jobs/${job.id}/invoices`, { source: 'job' });
    expect(r.status).toBe(201);
    expect(r.body.lines).toHaveLength(2);
    expect(r.body.lines[0]).toMatchObject({
      kind: 'labour',
      qtyMilli: 1500,
      unitPricePence: 4500,
      totalPence: 6750,
    });
    expect(r.body.lines[0].description).toMatch(/Test Owner \(1 h 30 min\)/);
    expect(r.body.totalPence).toBe(9000);
    // Reserved: nothing left to bill, so a second T&M invoice is refused.
    expect((await c.req('POST', `/api/jobs/${job.id}/invoices`, { source: 'job' })).status).toBe(
      422,
    );
    // Deleting the draft frees the time again.
    expect((await c.req('DELETE', `/api/invoices/${r.body.id}`)).status).toBe(204);
    expect((await c.req('GET', `/api/jobs/${job.id}/invoicing`)).body.unbilledMinutes).toBe(120);

    const again = (await c.req('POST', `/api/jobs/${job.id}/invoices`, { source: 'job' })).body;
    await approveAndSend(c, again.id);
    expect(again.number).toBeNull();
    const done = await pay(c, again.id, 9000);
    expect(done.body).toMatchObject({ number: '122', jobCompleted: true });
  });

  it('refuses a quote invoice on a job with no quote', async () => {
    const c = await client();
    const { job } = await timedJob(c);
    expect(
      (await c.req('POST', `/api/jobs/${job.id}/invoices`, { source: 'quote', mode: 'whole' }))
        .status,
    ).toBe(422);
  });
});

describe('drafts, approval and the owner rule', () => {
  it('drafts can be edited; approved invoices are locked and cannot be deleted', async () => {
    const c = await client();
    await ready(c);
    const { job } = await quotedJob(c);
    const d = (
      await c.req('POST', `/api/jobs/${job.id}/invoices`, { source: 'quote', mode: 'whole' })
    ).body;
    const e = await c.req(
      'PATCH',
      `/api/invoices/${d.id}`,
      {
        notes: 'Thanks!',
        lines: [
          { kind: 'material', description: 'Agreed price', qtyMilli: 1000, unitPricePence: 40000 },
        ],
      },
      { 'If-Match': String(d.version) },
    );
    expect(e.status).toBe(200);
    expect(e.body).toMatchObject({ notes: 'Thanks!', totalPence: 40000 });
    const stale = await c.req(
      'PATCH',
      `/api/invoices/${d.id}`,
      { notes: 'x' },
      { 'If-Match': String(d.version) },
    );
    expect(stale.status).toBe(409);
    // Edited quote invoice counts its new amount against the quote.
    expect((await c.req('GET', `/api/jobs/${job.id}/invoicing`)).body.quote.remainingPence).toBe(
      2200,
    );

    await c.req('POST', `/api/invoices/${d.id}/approve`);
    expect((await c.req('PATCH', `/api/invoices/${d.id}`, { notes: 'y' })).status).toBe(409);
    expect((await c.req('DELETE', `/api/invoices/${d.id}`)).status).toBe(409);
    expect((await c.req('POST', `/api/invoices/${d.id}/approve`)).status).toBe(409);
    expect((await pay(c, d.id, 100)).status).toBe(409); // not sent yet
  });

  it('approval needs bank details and a bill-payer email, and numbers never skip', async () => {
    const c = await client();
    const { job, cust } = await quotedJob(c);
    const d = (
      await c.req('POST', `/api/jobs/${job.id}/invoices`, {
        source: 'quote',
        mode: 'deposit',
        amountPence: 1000,
      })
    ).body;
    expect(d.approvalBlockers).toEqual(['Bank account name', 'Sort code', 'Account number']);
    const r = await c.req('POST', `/api/invoices/${d.id}/approve`);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('not_ready');
    await ready(c);
    await c.req('PATCH', `/api/customers/${cust.id}`, { email: null });
    const noEmail = await c.req('POST', `/api/invoices/${d.id}/approve`);
    expect(noEmail.body.error.message).toMatch(/Bill payer email/);
    // A bill-payer contact's email is used instead of the customer's.
    await c.req('POST', `/api/customers/${cust.id}/contacts`, {
      name: 'Agnes Le Feuvre',
      role: 'bill_payer',
      email: 'accounts@farm.example',
    });
    const ok = await c.req('POST', `/api/invoices/${d.id}/approve`);
    expect(ok.status).toBe(200);
    expect(ok.body.number).toBe('122'); // failed attempts used no number
    expect(ok.body.billTo).toMatchObject({ email: 'accounts@farm.example' });
  });

  it('only the owner can approve, mark sent or record payments; staff can draft', async () => {
    const c = await client();
    await ready(c);
    const { job } = await quotedJob(c);
    const staff = await clientFor(await addMember(c.tenantId, 'staff'), c);
    const d = await staff.req('POST', `/api/jobs/${job.id}/invoices`, {
      source: 'quote',
      mode: 'whole',
    });
    expect(d.status).toBe(201);
    expect((await staff.req('POST', `/api/invoices/${d.body.id}/approve`)).status).toBe(403);
    await c.req('POST', `/api/invoices/${d.body.id}/approve`);
    expect((await staff.req('POST', `/api/invoices/${d.body.id}/mark-sent`)).status).toBe(403);
    await c.req('POST', `/api/invoices/${d.body.id}/mark-sent`);
    expect((await pay(staff, d.body.id, 100)).status).toBe(403);
  });

  it('a payment replayed with the same Idempotency-Key is recorded once', async () => {
    const c = await client();
    await ready(c);
    const { job } = await quotedJob(c);
    const d = (
      await c.req('POST', `/api/jobs/${job.id}/invoices`, { source: 'quote', mode: 'whole' })
    ).body;
    await approveAndSend(c, d.id);
    const body = { amountPence: 1000, paidOn: todayIso(), method: 'cash' };
    const h = { 'Idempotency-Key': 'pay-test-key-1' };
    await c.req('POST', `/api/invoices/${d.id}/payments`, body, h);
    const again = await c.req('POST', `/api/invoices/${d.id}/payments`, body, h);
    expect(again.headers.get('Idempotent-Replayed')).toBe('true');
    expect((await c.req('GET', `/api/invoices/${d.id}`)).body.paidPence).toBe(1000);
  });

  it('lists by filter, with overdue worked out from the due date', async () => {
    const c = await client();
    await ready(c);
    await c.req('PATCH', '/api/settings', { paymentTermsDays: 0 });
    const { job } = await quotedJob(c);
    const d1 = (
      await c.req('POST', `/api/jobs/${job.id}/invoices`, {
        source: 'quote',
        mode: 'deposit',
        amountPence: 1000,
      })
    ).body;
    await approveAndSend(c, d1.id);
    await c.req('POST', `/api/jobs/${job.id}/invoices`, {
      source: 'quote',
      mode: 'deposit',
      amountPence: 1000,
    });
    const all = (await c.req('GET', '/api/invoices')).body;
    expect(all.map((i: { status: string }) => i.status)).toEqual(['draft', 'sent']);
    // Due today: not overdue yet.
    expect((await c.req('GET', '/api/invoices?filter=overdue')).body).toHaveLength(0);
    expect((await c.req('GET', '/api/invoices?filter=outstanding')).body).toHaveLength(1);
    expect((await c.req('GET', '/api/invoices?filter=draft')).body).toHaveLength(1);
    expect(all[1].displayStatus).toBe('sent');
    await adminSql`UPDATE invoices SET due_date = due_date - 1 WHERE id = ${d1.id}`;
    const overdue = (await c.req('GET', '/api/invoices?filter=overdue')).body;
    expect(overdue.map((i: { id: string }) => i.id)).toEqual([d1.id]);
    expect(overdue[0].displayStatus).toBe('overdue');
  });

  it('keeps tenants apart', async () => {
    const a = await client();
    const b = await client();
    const { job } = await quotedJob(a);
    const d = (
      await a.req('POST', `/api/jobs/${job.id}/invoices`, { source: 'quote', mode: 'whole' })
    ).body;
    expect((await b.req('GET', `/api/invoices/${d.id}`)).status).toBe(404);
    expect((await b.req('POST', `/api/invoices/${d.id}/approve`)).status).toBe(404);
    expect((await b.req('GET', '/api/invoices')).body).toEqual([]);
  });
});

describe('minus (credit) lines', () => {
  it('a minus line on a quote carries to the job and the invoice, and nets off the total', async () => {
    const c = await client();
    await ready(c);
    const cust = await seedCustomer(c);
    const q = (
      await c.req('POST', '/api/quotes', {
        customerId: cust.id,
        title: 'Flat works',
        lines: [
          { kind: 'labour', description: 'Rewire', qtyMilli: 10000, unitPricePence: 4500 },
          {
            kind: 'material',
            description: 'Rent payments',
            qtyMilli: 1000,
            unitPricePence: -12000,
          },
        ],
      })
    ).body;
    expect(q.current.totals.totalPence).toBe(33000);
    expect(q.current.lines[1]).toMatchObject({ unitSellPence: -12000, totalPence: -12000 });
    await c.req('POST', `/api/quotes/${q.id}/send`);
    await c.req('POST', `/api/quotes/${q.id}/accept`, { acceptedOptions: [] });
    const job = (await c.req('POST', `/api/quotes/${q.id}/convert`)).body;
    const inv = await c.req('POST', `/api/jobs/${job.id}/invoices`, {
      source: 'quote',
      mode: 'whole',
    });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    expect(inv.body.totalPence).toBe(33000);
    expect(inv.body.lines.map((l: { totalPence: number }) => l.totalPence)).toEqual([
      45000, -12000,
    ]);
    const sent = await approveAndSend(c, inv.body.id);
    expect(sent.totalPence).toBe(33000);
    expect((await pay(c, inv.body.id, 33000)).body.status).toBe('paid');
  });

  it('a draft invoice can take a minus line, but not one that makes the total exactly zero (below zero is a customer credit)', async () => {
    const c = await client();
    await ready(c);
    const { job } = await timedJob(c);
    const inv = (await c.req('POST', `/api/jobs/${job.id}/invoices`, { source: 'job' })).body;
    const lines = inv.lines.map((l: Record<string, unknown>) => ({
      kind: l.kind,
      description: l.description,
      qtyMilli: l.qtyMilli,
      unitPricePence: l.unitPricePence,
      taxRateBp: l.taxRateBp,
    }));
    const r = await c.req('PATCH', `/api/invoices/${inv.id}`, {
      lines: [
        ...lines,
        { kind: 'adjustment', description: 'Goodwill', qtyMilli: 1000, unitPricePence: -1000 },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.totalPence).toBe(inv.totalPence - 1000);
    await c.req('PATCH', `/api/invoices/${inv.id}`, {
      lines: [
        ...lines,
        {
          kind: 'adjustment',
          description: 'Too much',
          qtyMilli: 1000,
          unitPricePence: -inv.subtotalPence,
        },
      ],
    });
    expect((await c.req('POST', `/api/invoices/${inv.id}/approve`)).status).not.toBe(200);
  });
});
