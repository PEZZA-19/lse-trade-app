import {
  balanceSheet,
  openInvoices,
  overview,
  type BusinessDto,
  type CustomerDetailDto,
  type InvoiceDetailDto,
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
    const d = await draft(cust.id, [
      { kind: 'labour', description: 'Work', qtyMilli: 1000, unitPricePence: 10000 },
      { kind: 'material', description: 'Rent payments', qtyMilli: 1000, unitPricePence: -25000 },
    ]);
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
    const a = await send<InvoiceDetailDto>('POST', `/invoices/${next.id}/approve`);
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
