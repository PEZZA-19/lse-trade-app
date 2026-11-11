import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { client, clientFor, seedCustomer, type Client } from './api-helpers';
import { addMember } from './helpers';

/** A sent £422 invoice (whole quote) on a fresh business. */
async function sentInvoice(c: Client) {
  await c.req('PATCH', '/api/settings', {
    bankAccountName: 'Test Electrical',
    bankSortCode: '400000',
    bankAccountNumber: '12345678',
  });
  const cust = await seedCustomer(c);
  const q = (
    await c.req('POST', '/api/quotes', {
      customerId: cust.id,
      title: 'Barn rewire',
      lines: [
        { kind: 'labour', description: 'Install and test', qtyMilli: 8000 },
        { kind: 'material', description: 'Cable (m)', qtyMilli: 50000, unitCostPence: 95 },
      ],
    })
  ).body;
  await c.req('POST', `/api/quotes/${q.id}/send`);
  await c.req('POST', `/api/quotes/${q.id}/accept`, { acceptedOptions: [] });
  const job = (await c.req('POST', `/api/quotes/${q.id}/convert`)).body;
  const draft = (
    await c.req('POST', `/api/jobs/${job.id}/invoices`, { source: 'quote', mode: 'whole' })
  ).body;
  return { job, draft };
}

async function issue(c: Client, id: string) {
  await c.req('POST', `/api/invoices/${id}/approve`);
  return (await c.req('POST', `/api/invoices/${id}/mark-sent`)).body;
}

describe('customer credit notes', () => {
  it('can’t credit a draft or unsent invoice', async () => {
    const c = await client();
    const { draft } = await sentInvoice(c);
    const r = await c.req('POST', `/api/invoices/${draft.id}/credit-notes`, {
      amountPence: 1000,
      reason: 'Goodwill',
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('invoice_not_creditable');
  });

  it('staff draft, the owner approves: CN-0001, balance down, nothing sent', async () => {
    const c = await client();
    const { draft } = await sentInvoice(c);
    const inv = await issue(c, draft.id);
    expect(inv.balancePence).toBe(42200);
    const staff = await clientFor(await addMember(c.tenantId, 'staff'), c);

    const cn = await staff.req('POST', `/api/invoices/${inv.id}/credit-notes`, {
      amountPence: 2200,
      reason: 'Outside light not fitted',
    });
    expect(cn.status).toBe(201);
    expect(cn.body).toMatchObject({ status: 'draft', number: null, nextNumber: 'CN-0001' });
    // A draft changes nothing on the invoice.
    expect((await c.req('GET', `/api/invoices/${inv.id}`)).body.balancePence).toBe(42200);
    expect((await staff.req('POST', `/api/credit-notes/${cn.body.id}/approve`)).status).toBe(403);

    const ok = await c.req('POST', `/api/credit-notes/${cn.body.id}/approve`, undefined, {
      'If-Match': String(cn.body.version),
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'approved', number: 'CN-0001', jobCompleted: false });
    const after = (await c.req('GET', `/api/invoices/${inv.id}`)).body;
    expect(after).toMatchObject({ creditedPence: 2200, balancePence: 40000, status: 'sent' });
    expect(after.creditNotes).toEqual([
      expect.objectContaining({ number: 'CN-0001', amountPence: 2200, status: 'approved' }),
    ]);
    // Approved credit notes are locked, and the sequence moved on with no gap.
    expect((await c.req('DELETE', `/api/credit-notes/${cn.body.id}`)).status).toBe(409);
    const settings = (await c.req('GET', '/api/settings')).body;
    expect(
      settings.sequences.find((s: { kind: string }) => s.kind === 'credit_note'),
    ).toMatchObject({ nextValue: 2, lastUsed: 1 });
    // The invoice document shows the credit; the credit note has no bank details.
    const d = (await c.req('GET', `/api/invoices/${inv.id}/document`)).body;
    expect(d.totals.map((t: { label: string; value: string }) => `${t.label} ${t.value}`)).toEqual(
      expect.arrayContaining(['Credit note CN-0001 -£22.00', 'Balance due £400.00']),
    );
    const cd = (await c.req('GET', `/api/credit-notes/${cn.body.id}/document`)).body;
    expect(cd).toMatchObject({ kind: 'credit_note', number: 'CN-0001', payment: null });
    const res = await c.session.request('GET', `/api/credit-notes/${cn.body.id}/pdf`);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    const pdf = await PDFDocument.load(new Uint8Array(await res.arrayBuffer()));
    expect(pdf.getPageCount()).toBe(1);
  });

  it('never credits more than is owed, counting other drafts; payments respect credits', async () => {
    const c = await client();
    const { draft } = await sentInvoice(c);
    const inv = await issue(c, draft.id);
    await c.req('POST', `/api/invoices/${inv.id}/payments`, {
      amountPence: 22200,
      paidOn: new Date().toISOString().slice(0, 10),
      method: 'cash',
    });
    const big = await c.req('POST', `/api/invoices/${inv.id}/credit-notes`, {
      amountPence: 20001,
      reason: 'Too much',
    });
    expect(big.status).toBe(422);
    expect(big.body.error.message).toMatch(/£200.00 still owed/);
    const a = await c.req('POST', `/api/invoices/${inv.id}/credit-notes`, {
      amountPence: 15000,
      reason: 'Part',
    });
    expect(a.status).toBe(201);
    const b = await c.req('POST', `/api/invoices/${inv.id}/credit-notes`, {
      amountPence: 6000,
      reason: 'Another',
    });
    expect(b.status).toBe(422);
    expect(b.body.error.message).toMatch(/£50.00 is left/);
    await c.req('POST', `/api/credit-notes/${a.body.id}/approve`);
    // £422 − £222 paid − £150 credited = £50 owed; a £60 payment is refused.
    const over = await c.req('POST', `/api/invoices/${inv.id}/payments`, {
      amountPence: 6000,
      paidOn: new Date().toISOString().slice(0, 10),
      method: 'cash',
    });
    expect(over.status).toBe(422);
  });

  it('a credit that clears the balance settles the invoice and completes the job', async () => {
    const c = await client();
    const { draft, job } = await sentInvoice(c);
    const inv = await issue(c, draft.id);
    await c.req('POST', `/api/invoices/${inv.id}/payments`, {
      amountPence: 40000,
      paidOn: new Date().toISOString().slice(0, 10),
      method: 'bank_transfer',
    });
    const cn = (
      await c.req('POST', `/api/invoices/${inv.id}/credit-notes`, {
        amountPence: 2200,
        reason: 'Rounding goodwill',
      })
    ).body;
    const ok = await c.req('POST', `/api/credit-notes/${cn.id}/approve`);
    expect(ok.body.jobCompleted).toBe(true);
    expect((await c.req('GET', `/api/invoices/${inv.id}`)).body.status).toBe('paid');
    expect((await c.req('GET', `/api/jobs/${job.id}`)).body.stage.systemKey).toBe('complete');
    // Fully settled: nothing more can be credited.
    const more = await c.req('POST', `/api/invoices/${inv.id}/credit-notes`, {
      amountPence: 100,
      reason: 'x',
    });
    expect(more.status).toBe(409);
  });

  it('a draft can be deleted; other businesses can’t see it', async () => {
    const c = await client();
    const { draft } = await sentInvoice(c);
    const inv = await issue(c, draft.id);
    const cn = (
      await c.req('POST', `/api/invoices/${inv.id}/credit-notes`, {
        amountPence: 500,
        reason: 'Typo',
      })
    ).body;
    const other = await client();
    expect((await other.req('GET', `/api/credit-notes/${cn.id}`)).status).toBe(404);
    expect((await c.req('DELETE', `/api/credit-notes/${cn.id}`)).status).toBe(204);
    expect((await c.req('GET', `/api/credit-notes/${cn.id}`)).status).toBe(404);
  });
});
