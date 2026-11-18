import { describe, expect, it } from 'vitest';
import type { BankImportResultDto, BankTransactionDto } from '@lse/shared';
import { client, clientFor, type Client } from './api-helpers';
import { addMember, adminSql } from './helpers';

const day = (offset: number) => {
  const d = new Date(Date.now() + offset * 86_400_000);
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Guernsey' }).format(d); // dd/mm/yyyy
};

const statement = () =>
  [
    'Date,Description,Paid in,Paid out,Balance',
    `${day(-3)},CUSTOMER ONE INV-0001,"1,200.00",,2200.00`,
    `${day(-2)},CEF GUERNSEY,,120.50,2079.50`,
    `${day(-2)},COFFEE,,3.20,2076.30`,
    `${day(-2)},COFFEE,,3.20,2073.10`,
    `${day(-1)},Pending,,1.00,`,
    'not a date,???,,1.00,',
  ].join('\n');

async function staff(c: Client) {
  const email = await addMember(c.tenantId, 'staff');
  const [u] = await adminSql<{ id: string }[]>`SELECT id FROM users WHERE email = ${email}`;
  return clientFor(email, { tenantId: c.tenantId, userId: u!.id });
}

describe('bank statement import', () => {
  it('imports a CSV, lists the lines, and importing it again adds nothing twice', async () => {
    const c = await client();
    const first = await c.req('POST', '/api/bank/imports', {
      fileName: 'nov.csv',
      csv: statement(),
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const r = first.body as BankImportResultDto;
    expect(r).toMatchObject({ added: 5, alreadyImported: 0 });
    expect(r.problems).toEqual([{ line: 7, message: 'No date we can read (“not a date”).' }]);
    expect(r.columns).toBe('Date, Description, Paid in, Paid out, Balance');

    const list = (await c.req('GET', '/api/bank/transactions')).body as BankTransactionDto[];
    expect(list).toHaveLength(5);
    expect(list.every((x) => x.status === 'unmatched')).toBe(true);
    expect(list.map((x) => x.amountPence).sort((a, b) => a - b)).toEqual([
      -12_050, -320, -320, -100, 120_000,
    ]);

    const again = await c.req('POST', '/api/bank/imports', {
      fileName: 'nov.csv',
      csv: statement(),
    });
    expect(again.body).toMatchObject({ added: 0, alreadyImported: 5 });
    // An overlapping later statement only adds the new line.
    const later = await c.req('POST', '/api/bank/imports', {
      fileName: 'later.csv',
      csv: `Date,Description,Amount\n${day(-2)},COFFEE,-3.20\n${day(0)},NEW ONE,-9.99\n`,
    });
    expect(later.body).toMatchObject({ added: 1, alreadyImported: 1 });
    expect(
      ((await c.req('GET', '/api/bank/transactions?status=all')).body as unknown[]).length,
    ).toBe(6);

    const [a] = await adminSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = ${c.tenantId} AND entity = 'bank_import'`;
    expect(a!.n).toBe(3);
  });

  it('refuses files it can’t read and statements dated in the future', async () => {
    const c = await client();
    const bad = await c.req('POST', '/api/bank/imports', {
      fileName: 'x.csv',
      csv: 'hello\nworld',
    });
    expect(bad.status).toBe(422);
    expect((bad.body as { error: { message: string } }).error.message).toMatch(
      /doesn’t look like a bank statement/,
    );
    const future = await c.req('POST', '/api/bank/imports', {
      fileName: 'x.csv',
      csv: `Date,Description,Amount\n${day(5)},LATER,-1.00\n`,
    });
    expect(future.status).toBe(422);
    expect((future.body as { error: { code: string } }).error.code).toBe('bank_csv_future');
    expect(
      ((await c.req('GET', '/api/bank/transactions?status=all')).body as unknown[]).length,
    ).toBe(0);
  });

  it('only the owner imports; other businesses never see the lines', async () => {
    const c = await client();
    const s = await staff(c);
    const r = await s.req('POST', '/api/bank/imports', { fileName: 'x.csv', csv: statement() });
    expect([403]).toContain(r.status);
    await c.req('POST', '/api/bank/imports', { fileName: 'x.csv', csv: statement() });
    const other = await client();
    expect(
      ((await other.req('GET', '/api/bank/transactions?status=all')).body as unknown[]).length,
    ).toBe(0);
    // The same statement in another business is its own copy, not a duplicate.
    const o = await other.req('POST', '/api/bank/imports', { fileName: 'x.csv', csv: statement() });
    expect(o.body).toMatchObject({ added: 5 });
  });
});
