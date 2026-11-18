import {
  aged,
  balanceSheet,
  invoiceDocument,
  openInvoices,
  overview,
  profitAndLoss,
  type BusinessDto,
} from '@lse/shared';
import { describe, expect, it } from 'vitest';
import { client, clientFor, seedCustomer, type Client } from './api-helpers';
import { addMember, adminSql } from './helpers';

/*
 * Joe's decision (18 Nov 2026): a job that comes to less than £0 (e.g. job 14: rent payments
 * taken off the work) is a CUSTOMER CREDIT, used on that customer's next invoice. Not a refund.
 */

async function ready(c: Client) {
  await c.req('PATCH', '/api/settings', {
    bankAccountName: 'Test Electrical',
    bankSortCode: '400000',
    bankAccountNumber: '12345678',
  });
}

/** An accepted quote converted to a job, with the given lines. */
async function job(c: Client, customerId: string, title: string, lines: unknown[]) {
  const q = (await c.req('POST', '/api/quotes', { customerId, title, lines })).body;
  await c.req('POST', `/api/quotes/${q.id}/send`);
  await c.req('POST', `/api/quotes/${q.id}/accept`, { acceptedOptions: [] });
  return (await c.req('POST', `/api/quotes/${q.id}/convert`)).body;
}

const draftFor = async (c: Client, jobId: string) => {
  const r = await c.req('POST', `/api/jobs/${jobId}/invoices`, { source: 'quote', mode: 'whole' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
};

/**
 * A job whose invoice comes to less than £0. Quotes can't go below £0 any more (Joe, 18 Nov 2026),
 * so the minus line goes on the draft invoice (as with Joe's imported jobs 14 and 108).
 */
async function creditDraft(c: Client, customerId: string, title = 'Flat works') {
  // A time-and-materials job (no quote): an hour on the timer, then invoiced.
  const j = (await c.req('POST', '/api/jobs', { customerId, title })).body;
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  await c.req('POST', `/api/jobs/${j.id}/timer/start`, { at: ago(120) });
  await c.req('POST', `/api/jobs/${j.id}/timer/stop`, { at: ago(60) });
  const d = (await c.req('POST', `/api/jobs/${j.id}/invoices`, { source: 'job' })).body;
  const r = await c.req('PATCH', `/api/invoices/${d.id}`, { lines: RENT_JOB });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return { job: j, draft: r.body };
}

/** Labour £100 less £250 rent payments: comes to −£150. */
const RENT_JOB = [
  { kind: 'labour', description: 'Fit new consumer unit', qtyMilli: 1000, unitPricePence: 10000 },
  { kind: 'material', description: 'Rent payments', qtyMilli: 1000, unitPricePence: -25000 },
];
const WORK_JOB = (pence: number) => [
  { kind: 'labour', description: 'Outside lights', qtyMilli: 1000, unitPricePence: pence },
];

describe('customer credit (jobs that come to less than £0)', () => {
  it('a −£150 job is issued as credit note CN-0001 (not an invoice number), and settles the job', async () => {
    const c = await client();
    await ready(c);
    const cust = await seedCustomer(c);
    const { job: j, draft } = await creditDraft(c, cust.id);
    expect(draft.totalPence).toBe(-15000);
    expect(draft.approvalBlockers).toEqual([]);
    expect(draft.nextNumber).toBe('CN-0001');

    // Staff can't issue it: it's the owner's decision, like approving an invoice.
    const staff = await clientFor(await addMember(c.tenantId, 'staff'), c);
    expect((await staff.req('POST', `/api/invoices/${draft.id}/approve`)).status).toBe(403);

    const r = await c.req('POST', `/api/invoices/${draft.id}/approve`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({
      status: 'credit',
      number: 'CN-0001',
      dueDate: null,
      totalPence: -15000,
      balancePence: -15000,
      paidPence: 0,
    });
    // Nothing to send or pay on a credit.
    expect((await c.req('POST', `/api/invoices/${draft.id}/mark-sent`)).status).toBe(409);
    const pay = await c.req('POST', `/api/invoices/${draft.id}/payments`, {
      amountPence: 100,
      paidOn: r.body.issueDate,
      method: 'cash',
    });
    expect(pay.status).toBe(409);
    // No refund via a credit note on top either.
    const cn = await c.req('POST', `/api/invoices/${draft.id}/credit-notes`, {
      amountPence: 100,
      reason: 'x',
    });
    expect(cn.status).toBe(409);
    // Nothing more is owed on the job, so it moves to Complete.
    const jobNow = (await c.req('GET', `/api/jobs/${j.id}`)).body;
    expect(jobNow.stage.systemKey).toBe('complete');

    // The customer shows the credit.
    const custNow = (await c.req('GET', `/api/customers/${cust.id}`)).body;
    expect(custNow.credits).toEqual([
      { id: draft.id, number: 'CN-0001', issueDate: r.body.issueDate, remainingPence: 15000 },
    ]);
    // ...but not to a field worker (no money for them).
    const field = await clientFor(await addMember(c.tenantId, 'subcontractor'), c);
    const fieldView = await field.req('GET', `/api/customers/${cust.id}`);
    if (fieldView.status === 200) expect(fieldView.body.credits).toEqual([]);

    // The PDF says Credit Note, no bank details, credit wording.
    const settings = (await c.req('GET', '/api/settings')).body;
    const doc = invoiceDocument(r.body, settings);
    expect(doc.title).toBe('Credit Note');
    expect(doc.payment).toBeNull();
    expect(doc.totals.find((t) => t.strong)).toMatchObject({
      label: 'Credit to you',
      pence: 15000,
    });
    expect(doc.terms).toMatch(/next invoice/);
  });

  it('the credit comes off the customer’s next invoice (oldest first, never more than owed), and the books stay right', async () => {
    const c = await client();
    await ready(c);
    const cust = await seedCustomer(c);
    const other = await seedCustomer(c, { name: 'Someone Else', email: 'else@example.com' });

    const credit = (await creditDraft(c, cust.id)).draft;
    await c.req('POST', `/api/invoices/${credit.id}/approve`);

    // Another customer's invoice doesn't touch it.
    const otherInv = await draftFor(c, (await job(c, other.id, 'Other', WORK_JOB(5000))).id);
    expect(otherInv.creditToUsePence).toBe(0);
    const oa = (await c.req('POST', `/api/invoices/${otherInv.id}/approve`)).body;
    expect(oa.creditsApplied).toEqual([]);
    expect(oa.balancePence).toBe(5000);

    // Next invoice for this customer: £100. The whole £100 comes off from the £150 credit.
    const inv1 = await draftFor(c, (await job(c, cust.id, 'Lights', WORK_JOB(10000))).id);
    expect(inv1.creditToUsePence).toBe(10000);
    // Never used silently: approving without saying is refused with a plain question.
    const ask = await c.req('POST', `/api/invoices/${inv1.id}/approve`);
    expect(ask.status).toBe(422);
    expect(ask.body.error.code).toBe('credit_choice_needed');
    expect(ask.body.error.message).toMatch(/has £150\.00 credit\. Choose whether/);
    expect((await c.req('GET', `/api/invoices/${inv1.id}`)).body.status).toBe('draft');
    const a1 = (await c.req('POST', `/api/invoices/${inv1.id}/approve`, { useCredit: true })).body;
    expect(a1.status).toBe('approved');
    expect(a1.creditedPence).toBe(10000);
    expect(a1.balancePence).toBe(0);
    expect(a1.creditsApplied).toMatchObject([
      {
        creditId: credit.id,
        creditNumber: 'CN-0001',
        invoiceNumber: a1.number,
        amountPence: 10000,
      },
    ]);
    // Fully covered: marking it sent settles it (nothing to pay).
    const s1 = (await c.req('POST', `/api/invoices/${inv1.id}/mark-sent`)).body;
    expect(s1.status).toBe('paid');
    const pdf1 = invoiceDocument(s1, (await c.req('GET', '/api/settings')).body);
    expect(pdf1.totals.map((t) => t.label)).toContain('Credit CN-0001 used');
    expect(pdf1.totals.at(-1)).toMatchObject({ label: 'Balance due', pence: 0 });

    const cr = (await c.req('GET', `/api/invoices/${credit.id}`)).body;
    expect(cr.balancePence).toBe(-5000);
    expect(cr.creditUses).toHaveLength(1);

    // The next one: £80, only £50 credit left.
    const inv2 = await draftFor(c, (await job(c, cust.id, 'Sockets', WORK_JOB(8000))).id);
    expect(inv2.creditToUsePence).toBe(5000);
    const a2 = (await c.req('POST', `/api/invoices/${inv2.id}/approve`, { useCredit: true })).body;
    expect(a2.creditedPence).toBe(5000);
    expect(a2.balancePence).toBe(3000);
    const s2 = (await c.req('POST', `/api/invoices/${inv2.id}/mark-sent`)).body;
    expect(s2.status).toBe('sent');
    expect((await c.req('GET', `/api/invoices/${credit.id}`)).body.balancePence).toBe(0);
    expect((await c.req('GET', `/api/customers/${cust.id}`)).body.credits).toEqual([]);

    // A third invoice gets nothing off.
    const inv3 = await draftFor(c, (await job(c, cust.id, 'More', WORK_JOB(2000))).id);
    expect(inv3.creditToUsePence).toBe(0);

    // Books: sales are net of the credit, AR = what's really owed, aged receivables agree.
    const d = (await c.req('GET', '/api/business')).body as BusinessDto;
    expect(d.creditUses).toHaveLength(2);
    const range = { from: `${d.today.slice(0, 4)}-01-01`, to: d.today };
    const pl = profitAndLoss(d, range);
    // Labour 100 + 50 + 100 + 80 = 330; materials −250 (rent payments): income 80.
    expect(pl.rows.find((x) => x.label === 'Total income')?.values[0]).toBe(8000);
    const owed = openInvoices(d, d.today);
    expect(owed.map((x) => x.duePence).sort((a, b) => a - b)).toEqual([3000, 5000]);
    const bs = balanceSheet(d, d.today);
    const v = (l: string) => bs.rows.find((x) => x.label === l)?.values[0];
    expect(v('Accounts receivable')).toBe(8000);
    expect(v('Net assets')).toBe(v('Total equity'));
    const ag = aged(d, 'receivables', d.today);
    expect(ag.rows.find((r) => r.label === 'Total')?.values.at(-1)).toBe(8000);
    expect(overview(d).owedToYou).toMatchObject({ totalPence: 8000, creditPence: 0, count: 2 });
  });

  it('an unused credit is a negative receivable: overview shows it as credit to use', async () => {
    const c = await client();
    await ready(c);
    const cust = await seedCustomer(c);
    const credit = (await creditDraft(c, cust.id)).draft;
    await c.req('POST', `/api/invoices/${credit.id}/approve`);
    const d = (await c.req('GET', '/api/business')).body as BusinessDto;
    const o = overview(d);
    expect(o.owedToYou).toMatchObject({ totalPence: -15000, creditPence: 15000, count: 0 });
    const bs = balanceSheet(d, d.today);
    const v = (l: string) => bs.rows.find((x) => x.label === l)?.values[0];
    expect(v('Net assets')).toBe(v('Total equity'));
    // Uses are kept for good: the app's database user can't delete or change them.
    const [g] = await adminSql<{ del: boolean; upd: boolean; ins: boolean }[]>`
      SELECT has_table_privilege('app_user', 'credit_uses', 'DELETE') AS del,
             has_table_privilege('app_user', 'credit_uses', 'UPDATE') AS upd,
             has_table_privilege('app_user', 'credit_uses', 'INSERT') AS ins`;
    expect(g).toEqual({ del: false, upd: false, ins: true });
  });

  it('a £0 draft still can’t be approved; another business can’t see or use the credit', async () => {
    const c = await client();
    await ready(c);
    const cust = await seedCustomer(c);
    const work = await draftFor(c, (await job(c, cust.id, 'Even', WORK_JOB(5000))).id);
    const zero = (
      await c.req('PATCH', `/api/invoices/${work.id}`, {
        lines: [
          { kind: 'labour', description: 'Work', qtyMilli: 1000, unitPricePence: 5000 },
          { kind: 'adjustment', description: 'Rent', qtyMilli: 1000, unitPricePence: -5000 },
        ],
      })
    ).body;
    expect(zero.approvalBlockers).toContain('An amount to invoice');
    expect((await c.req('POST', `/api/invoices/${zero.id}/approve`)).status).toBe(422);

    const credit = (await creditDraft(c, cust.id)).draft;
    await c.req('POST', `/api/invoices/${credit.id}/approve`);
    const b = await client();
    expect((await b.req('GET', `/api/invoices/${credit.id}`)).status).toBe(404);
  });
});

describe('customer credit dates', () => {
  it('an invoice dated before the credit was issued doesn’t use it', async () => {
    const c = await client();
    await ready(c);
    const cust = await seedCustomer(c);
    const credit = (await creditDraft(c, cust.id)).draft;
    const cr = (await c.req('POST', `/api/invoices/${credit.id}/approve`)).body;
    const earlier = await draftFor(c, (await job(c, cust.id, 'Old job', WORK_JOB(4000))).id);
    const d = new Date(`${cr.issueDate}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 3);
    const a = await c.req('POST', `/api/invoices/${earlier.id}/approve`, {
      issueDate: d.toISOString().slice(0, 10),
    });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body.creditsApplied).toEqual([]);
    expect(a.body.balancePence).toBe(4000);
  });
});

describe('customer credit: Joe’s rules (18 Nov 2026)', () => {
  it('“keep it for later”: the invoice is approved in full and the credit stays on the account', async () => {
    const c = await client();
    await ready(c);
    const cust = await seedCustomer(c);
    const { draft: credit } = await creditDraft(c, cust.id);
    await c.req('POST', `/api/invoices/${credit.id}/approve`);
    const inv = await draftFor(c, (await job(c, cust.id, 'Lights', WORK_JOB(10000))).id);
    const a = await c.req('POST', `/api/invoices/${inv.id}/approve`, { useCredit: false });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body).toMatchObject({ status: 'approved', creditedPence: 0, balancePence: 10000 });
    expect(a.body.creditsApplied).toEqual([]);
    expect((await c.req('GET', `/api/customers/${cust.id}`)).body.credits).toMatchObject([
      { id: credit.id, remainingPence: 15000 },
    ]);
  });

  it('a credit never comes off an invoice that is already approved or sent', async () => {
    const c = await client();
    await ready(c);
    const cust = await seedCustomer(c);
    // Approved and sent before the credit exists.
    const sent = await draftFor(c, (await job(c, cust.id, 'Earlier work', WORK_JOB(6000))).id);
    await c.req('POST', `/api/invoices/${sent.id}/approve`);
    await c.req('POST', `/api/invoices/${sent.id}/mark-sent`);
    const approved = await draftFor(c, (await job(c, cust.id, 'Approved', WORK_JOB(4000))).id);
    await c.req('POST', `/api/invoices/${approved.id}/approve`);
    const { draft: credit } = await creditDraft(c, cust.id);
    expect((await c.req('POST', `/api/invoices/${credit.id}/approve`)).status).toBe(200);
    const s1 = (await c.req('GET', `/api/invoices/${sent.id}`)).body;
    const s2 = (await c.req('GET', `/api/invoices/${approved.id}`)).body;
    expect([s1.balancePence, s2.balancePence]).toEqual([6000, 4000]);
    expect([s1.creditToUsePence, s2.creditToUsePence]).toEqual([0, 0]);
    // A payment on the sent one still works as normal; the credit waits for the next invoice.
    expect((await c.req('GET', `/api/customers/${cust.id}`)).body.credits[0].remainingPence).toBe(
      15000,
    );
  });

  it('a quote for a customer with credit is never reduced by it, but says it’s there', async () => {
    const c = await client();
    await ready(c);
    const cust = await seedCustomer(c);
    const { draft: credit } = await creditDraft(c, cust.id);
    await c.req('POST', `/api/invoices/${credit.id}/approve`);
    const q = (
      await c.req('POST', '/api/quotes', {
        customerId: cust.id,
        title: 'Garage lights',
        lines: WORK_JOB(20000),
      })
    ).body;
    expect(q.totalPence ?? q.revision?.totalPence).toBe(20000);
    expect(q.customerCreditPence).toBe(15000);
    const sent = await c.req('POST', `/api/quotes/${q.id}/send`);
    expect(sent.status).toBe(200);
    expect((await c.req('GET', `/api/customers/${cust.id}`)).body.credits[0].remainingPence).toBe(
      15000,
    );
    // Someone without money access doesn't see it.
    const field = await clientFor(await addMember(c.tenantId, 'subcontractor'), c);
    const fv = await field.req('GET', `/api/quotes/${q.id}`);
    if (fv.status === 200) expect(fv.body.customerCreditPence).toBe(0);
  });
});
