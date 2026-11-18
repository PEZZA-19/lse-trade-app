import {
  balanceSheet,
  overview,
  type BillPaymentDto,
  type BillSummaryDto,
  type BusinessDto,
} from '@lse/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { handle, resetDemo } from './mockApi';

const get = <T>(p: string) => handle('GET', p, undefined) as Promise<T>;
const send = <T>(m: string, p: string, b?: unknown) => handle(m, p, b) as Promise<T>;

describe('demo business overview (mirrors the server)', () => {
  beforeEach(() => {
    localStorage.clear();
    resetDemo();
  });

  it('builds the books from the demo invoices, bills and jobs, and they balance', async () => {
    const d = await get<BusinessDto>('/business');
    expect(d.invoices.length).toBeGreaterThan(0);
    expect(d.pipeline.length).toBeGreaterThan(0);
    const o = overview(d);
    expect(o.cash).toHaveLength(12);
    const bs = balanceSheet(d, d.today);
    const v = (l: string) => bs.rows.find((r) => r.label === l)!.values[0];
    expect(v('Net assets')).toBe(v('Total equity'));
  });

  it('opening balance, budget and supplier bill payments', async () => {
    const before = overview(await get<BusinessDto>('/business'));
    const d = await send<BusinessDto>('PUT', '/business/opening', {
      date: '2026-01-01',
      bankPence: 50000,
    });
    expect(overview(d).bankPence).toBe(before.bankPence + 50000);
    const b2 = await send<BusinessDto>('PUT', '/business/budget', {
      year: 2027,
      lines: [{ account: '200', months: Array(12).fill(1000) }],
    });
    expect(b2.budgets).toHaveLength(12);

    const bill = (await get<BillSummaryDto[]>('/supplier-bills?status=applied')).find(
      (b) => b.kind === 'bill',
    )!;
    const rows = await send<BillPaymentDto[]>('POST', `/supplier-bills/${bill.id}/payments`, {
      amountPence: bill.totalPence,
      paidOn: d.today,
      method: 'bank_transfer',
    });
    expect(rows).toHaveLength(1);
    await expect(
      send('POST', `/supplier-bills/${bill.id}/payments`, {
        amountPence: 1,
        paidOn: d.today,
        method: 'cash',
      }),
    ).rejects.toMatchObject({ code: 'overpayment' });
    const after = overview(await get<BusinessDto>('/business'));
    expect(after.youOwe.totalPence).toBe(before.youOwe.totalPence - bill.totalPence);
    expect(after.bankPence).toBe(before.bankPence + 50000 - bill.totalPence);
  });
});
