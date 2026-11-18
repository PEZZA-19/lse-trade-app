import {
  balanceSheet,
  openInvoices,
  overview,
  type BusinessDto,
  type CustomerDetailDto,
  type InvoiceDetailDto,
  type JobDetailDto,
} from '@lse/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { handle, resetDemo } from './mockApi';

const get = <T>(p: string) => handle('GET', p, undefined) as Promise<T>;
const send = <T>(m: string, p: string, b?: unknown) => handle(m, p, b) as Promise<T>;

async function draft(customerId: string, lines: unknown[]) {
  const q = await send<{ id: string }>('POST', '/quotes', { customerId, title: 'Work', lines });
  await send('POST', `/quotes/${q.id}/send`);
  await send('POST', `/quotes/${q.id}/accept`, { acceptedOptions: [] });
  const job = await send<{ id: string }>('POST', `/quotes/${q.id}/convert`);
  return send<InvoiceDetailDto>('POST', `/jobs/${job.id}/invoices`, {
    source: 'quote',
    mode: 'whole',
  });
}

describe('demo customer credit (mirrors the server)', () => {
  beforeEach(() => {
    localStorage.clear();
    resetDemo();
  });

  it('a job below £0 becomes a CN credit, used on the customer’s next invoice; books balance', async () => {
    const cust = await send<CustomerDetailDto>('POST', '/customers', {
      name: 'Credit Test',
      email: 'credit@example.com',
    });
    const before = overview(await get<BusinessDto>('/business'));
    // Quotes can't go below £0 (Joe, 18 Nov 2026): the minus line goes on the draft invoice.
    const rent = [
      { kind: 'labour', description: 'Work', qtyMilli: 1000, unitPricePence: 10000 },
      { kind: 'material', description: 'Rent payments', qtyMilli: 1000, unitPricePence: -25000 },
    ];
    await expect(
      send('POST', '/quotes', { customerId: cust.id, title: 'Below zero', lines: rent }),
    ).rejects.toThrow(/can’t come to less than £0/);
    const w = await draft(cust.id, [rent[0]]);
    const d = await send<InvoiceDetailDto>('PATCH', `/invoices/${w.id}`, { lines: rent });
    expect(d.totalPence).toBe(-15000);
    expect(d.approvalBlockers).toEqual([]);
    expect(d.nextNumber).toMatch(/^CN-/);
    const credit = await send<InvoiceDetailDto>('POST', `/invoices/${d.id}/approve`);
    expect(credit).toMatchObject({ status: 'credit', dueDate: null, balancePence: -15000 });
    expect(credit.number).toMatch(/^CN-/);
    expect((await get<CustomerDetailDto>(`/customers/${cust.id}`)).credits).toMatchObject([
      { id: d.id, remainingPence: 15000 },
    ]);
    const mid = overview(await get<BusinessDto>('/business'));
    expect(mid.owedToYou.creditPence).toBe(before.owedToYou.creditPence + 15000);

    const next = await draft(cust.id, [
      { kind: 'labour', description: 'Lights', qtyMilli: 1000, unitPricePence: 20000 },
    ]);
    expect(next.creditToUsePence).toBe(15000);
    // Never used silently: approving has to say whether to use it.
    await expect(send('POST', `/invoices/${next.id}/approve`)).rejects.toThrow(
      /has £150\.00 credit/,
    );
    const a = await send<InvoiceDetailDto>('POST', `/invoices/${next.id}/approve`, {
      useCredit: true,
    });
    expect(a.creditsApplied).toMatchObject([{ creditId: d.id, amountPence: 15000 }]);
    expect(a.balancePence).toBe(5000);
    expect((await get<InvoiceDetailDto>(`/invoices/${d.id}`)).balancePence).toBe(0);
    expect((await get<CustomerDetailDto>(`/customers/${cust.id}`)).credits).toEqual([]);

    const books = await get<BusinessDto>('/business');
    expect(books.creditUses).toHaveLength(1);
    const mine = openInvoices(books, books.today).filter((x) => x.contact === 'Credit Test');
    expect(mine.map((x) => x.duePence)).toEqual([5000]);
    const bs = balanceSheet(books, books.today);
    const v = (l: string) => bs.rows.find((r) => r.label === l)!.values[0];
    expect(v('Net assets')).toBe(v('Total equity'));
  });
});

describe('demo credit choice on work not yet invoiced (Joe, 18 Nov 2026, 10:27)', () => {
  beforeEach(() => {
    localStorage.clear();
    resetDemo();
  });

  it('chosen on the quote, carried to the job and the invoice; refused once invoiced', async () => {
    const cust = await send<CustomerDetailDto>('POST', '/customers', {
      name: 'Choice Test',
      email: 'choice@example.com',
    });
    const work = [{ kind: 'labour', description: 'Work', qtyMilli: 1000, unitPricePence: 10000 }];
    const q = await send<{ id: string; useCredit: boolean | null }>('POST', '/quotes', {
      customerId: cust.id,
      title: 'Work',
      lines: work,
    });
    expect(q.useCredit).toBeNull();
    const set = await send<{ useCredit: boolean | null }>('PUT', `/quotes/${q.id}/credit`, {
      useCredit: false,
    });
    expect(set.useCredit).toBe(false);
    await send('POST', `/quotes/${q.id}/send`);
    await send('POST', `/quotes/${q.id}/accept`, { acceptedOptions: [] });
    const job = await send<{ id: string }>('POST', `/quotes/${q.id}/convert`);
    const inv = await send<InvoiceDetailDto>('POST', `/jobs/${job.id}/invoices`, {
      source: 'quote',
      mode: 'whole',
    });
    expect(inv.jobUseCredit).toBe(false);
    await send('PUT', `/jobs/${job.id}/credit`, { useCredit: true });
    expect((await get<InvoiceDetailDto>(`/invoices/${inv.id}`)).jobUseCredit).toBe(true);
    const shown = await get<JobDetailDto>(`/jobs/${job.id}`);
    expect(shown).toMatchObject({ useCredit: true, invoiced: false, customerCreditPence: 0 });
    await send('POST', `/invoices/${inv.id}/approve`);
    expect((await get<JobDetailDto>(`/jobs/${job.id}`)).invoiced).toBe(true);
    await expect(send('PUT', `/jobs/${job.id}/credit`, { useCredit: false })).rejects.toThrow(
      /already been invoiced/,
    );
  });
});

describe('demo credit on an issued invoice (Joe, 18 Nov 2026, 10:35)', () => {
  beforeEach(() => {
    localStorage.clear();
    resetDemo();
  });

  it('lowers the job’s costs; what’s owed and the invoice document stay as billed (11:34)', async () => {
    const cust = await send<CustomerDetailDto>('POST', '/customers', {
      name: 'After Issue',
      email: 'after@example.com',
    });
    const work = [{ kind: 'labour', description: 'Work', qtyMilli: 1000, unitPricePence: 6000 }];
    const inv = await draft(cust.id, work);
    await send('POST', `/invoices/${inv.id}/approve`);
    await send('POST', `/invoices/${inv.id}/mark-sent`);
    const docBefore = await get(`/invoices/${inv.id}/document`);
    const rent = [
      { kind: 'labour', description: 'Work', qtyMilli: 1000, unitPricePence: 10000 },
      { kind: 'material', description: 'Rent payments', qtyMilli: 1000, unitPricePence: -25000 },
    ];
    const w = await draft(cust.id, [rent[0]]);
    const d = await send<InvoiceDetailDto>('PATCH', `/invoices/${w.id}`, { lines: rent });
    await send('POST', `/invoices/${d.id}/approve`);
    expect((await get<InvoiceDetailDto>(`/invoices/${inv.id}`)).creditToUsePence).toBe(6000);
    const r = await send<InvoiceDetailDto>('POST', `/invoices/${inv.id}/use-credit`);
    expect(r).toMatchObject({ status: 'sent', totalPence: 6000, balancePence: 6000 });
    expect(r.creditsApplied[0]).toMatchObject({ amountPence: 6000, afterIssue: true });
    expect(await get(`/invoices/${inv.id}/document`)).toEqual(docBefore);
    expect((await get<CustomerDetailDto>(`/customers/${cust.id}`)).credits[0]!.remainingPence).toBe(
      9000,
    );
    // The job's profit goes up by the credit used.
    const costing = await get<{ profit: { creditUsedPence: number } }>(
      `/jobs/${inv.jobId}/costing`,
    );
    expect(costing.profit.creditUsedPence).toBe(6000);
  });
});
