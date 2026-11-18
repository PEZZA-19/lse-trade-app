import type { BankImportResultDto, BankTransactionDto, ExpenseDto } from '@lse/shared';
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
});
