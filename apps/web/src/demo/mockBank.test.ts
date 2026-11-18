import type {
  BankImportResultDto,
  BankTransactionDto,
  ExpenseDto,
  InvoiceDetailDto,
  InvoiceSummaryDto,
} from '@lse/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { handle, resetDemo } from './mockApi';

const send = <T>(m: string, p: string, b?: unknown) => handle(m, p, b) as Promise<T>;

describe('demo bank statements (mirror the server)', () => {
  beforeEach(() => {
    localStorage.clear();
    resetDemo();
  });

  it('imports once, suggests the expense, matches, unmatches and ignores', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Guernsey' }).format(
      new Date(),
    );
    const [y, m, d] = today.split('-');
    const fuel = await send<ExpenseDto>('POST', '/expenses', {
      date: today,
      payee: 'Island Fuel',
      account: '449',
      amountPence: 6000,
    });
    const csv = `Date,Description,Amount\n${d}/${m}/${y},ISLAND FUEL,-60.00\n${d}/${m}/${y},TO SAVINGS,-500.00\n`;
    const r = await send<BankImportResultDto>('POST', '/bank/imports', { fileName: 's.csv', csv });
    expect(r).toMatchObject({ added: 2, alreadyImported: 0 });
    expect(
      await send<BankImportResultDto>('POST', '/bank/imports', { fileName: 's.csv', csv }),
    ).toMatchObject({ added: 0, alreadyImported: 2 });
    const list = await send<BankTransactionDto[]>('GET', '/bank/transactions?status=unmatched');
    const line = list.find((l) => l.amountPence === -6000)!;
    expect(line.suggestions[0]).toMatchObject({ kind: 'expense', id: fuel.id, strong: true });
    await send('POST', `/bank/transactions/${line.id}/match`, { kind: 'expense', id: fuel.id });
    const other = list.find((l) => l.amountPence === -50000)!;
    await expect(
      send('POST', `/bank/transactions/${other.id}/match`, { kind: 'expense', id: fuel.id }),
    ).rejects.toThrow(/amounts differ|already matched/);
    await send('PUT', `/bank/transactions/${other.id}/status`, { status: 'ignored' });
    expect(await send('GET', '/bank/transactions?status=unmatched')).toEqual([]);
    const matched = await send<BankTransactionDto[]>('GET', '/bank/transactions?status=matched');
    expect(matched[0]!.matchedTo).toMatchObject({
      kind: 'expense',
      label: 'Island Fuel · Vehicle and fuel',
    });
    await send('PUT', `/bank/transactions/${line.id}/status`, { status: 'unmatched' });
    expect(
      await send<BankTransactionDto[]>('GET', '/bank/transactions?status=unmatched'),
    ).toHaveLength(1);
  });

  it('adds a money-out line as an expense, matched', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Guernsey' }).format(
      new Date(),
    );
    const [y, m, d] = today.split('-');
    await send('POST', '/bank/imports', {
      fileName: 'f.csv',
      csv: `Date,Description,Amount\n${d}/${m}/${y},CONDOR FERRIES,-86.50\n`,
    });
    const [line] = await send<BankTransactionDto[]>('GET', '/bank/transactions?status=unmatched');
    const e = await send<ExpenseDto>('POST', `/bank/transactions/${line!.id}/expense`, {
      account: '493',
      payee: 'Condor Ferries',
    });
    expect(e).toMatchObject({ amountPence: 8650, date: today, account: '493' });
    expect(await send('GET', '/bank/transactions?status=unmatched')).toEqual([]);
  });

  it('records a customer payment from money in and matches it', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Guernsey' }).format(
      new Date(),
    );
    const [y, m, d] = today.split('-');
    const inv = (await send<InvoiceSummaryDto[]>('GET', '/invoices?filter=outstanding')).find(
      (i) => (i.status === 'sent' || i.status === 'part_paid') && i.balancePence > 100,
    );
    expect(inv, 'the demo has a sent invoice').toBeTruthy();
    const csv = `Date,Description,Amount\n${d}/${m}/${y},FP CUSTOMER,1.00\n${d}/${m}/${y},SHOP,-1.00\n`;
    await send('POST', '/bank/imports', { fileName: 'p.csv', csv });
    const list = await send<BankTransactionDto[]>('GET', '/bank/transactions?status=unmatched');
    const inn = list.find((l) => l.amountPence === 100)!;
    const out = list.find((l) => l.amountPence === -100)!;
    await expect(
      send('POST', `/bank/transactions/${out.id}/payment`, { invoiceId: inv!.id }),
    ).rejects.toMatchObject({ status: 422 });
    const r = await send<{ paymentId: string }>('POST', `/bank/transactions/${inn.id}/payment`, {
      invoiceId: inv!.id,
    });
    const detail = await send<InvoiceDetailDto>('GET', `/invoices/${inv!.id}`);
    expect(detail.payments.at(-1)).toMatchObject({
      id: r.paymentId,
      amountPence: 100,
      method: 'bank_transfer',
      reference: 'FP CUSTOMER',
    });
    const matched = await send<BankTransactionDto[]>('GET', '/bank/transactions?status=matched');
    expect(matched.map((l) => l.matchedTo?.kind)).toEqual(['payment']);
    await expect(
      send('POST', `/bank/transactions/${inn.id}/payment`, { invoiceId: inv!.id }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('pays a supplier bill from money out and matches it', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Guernsey' }).format(
      new Date(),
    );
    const [y, m, d] = today.split('-');
    const bill = await send<{ id: string }>('POST', '/supplier-bills', {
      supplier: 'Island Electrical',
      reference: 'DEMO/1',
      billDate: today,
      lines: [{ description: 'Cable', qtyMilli: 1000, unitCostPence: 4000, allocation: 'stock' }],
    });
    await send('POST', `/supplier-bills/${bill.id}/apply`, { dryRun: false });
    const { totalPence } = await send<{ totalPence: number }>('GET', `/supplier-bills/${bill.id}`);
    const csv = `Date,Description,Amount\n${d}/${m}/${y},BACS ELEC,-${(totalPence / 100).toFixed(2)}\n`;
    await send('POST', '/bank/imports', { fileName: 'b.csv', csv });
    const [line] = await send<BankTransactionDto[]>('GET', '/bank/transactions?status=unmatched');
    await send('POST', `/bank/transactions/${line!.id}/bill-payment`, { billId: bill.id });
    const pays = await send<{ amountPence: number; reference: string }[]>(
      'GET',
      `/supplier-bills/${bill.id}/payments`,
    );
    expect(pays).toEqual([
      expect.objectContaining({ amountPence: totalPence, reference: 'BACS ELEC' }),
    ]);
    const matched = await send<BankTransactionDto[]>('GET', '/bank/transactions?status=matched');
    expect(matched.map((l) => l.matchedTo?.kind)).toEqual(['bill_payment']);
  });
});
