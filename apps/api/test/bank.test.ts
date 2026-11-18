import { describe, expect, it } from 'vitest';
import type { BankImportResultDto, BankTransactionDto } from '@lse/shared';
import { client, clientFor, seedCustomer, type Client } from './api-helpers';
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
  return { s: await clientFor(email, { tenantId: c.tenantId, userId: u!.id }), id: u!.id };
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

  it('Accounts access imports (not field workers); other businesses never see the lines', async () => {
    const c = await client();
    const { s, id } = await staff(c);
    await c.req('PUT', `/api/team/${id}/access`, { isAdmin: false, areas: [] });
    const r = await s.req('POST', '/api/bank/imports', { fileName: 'x.csv', csv: statement() });
    expect(r.status).toBe(403);
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

const todayIso = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Guernsey' }).format(new Date());

/** A sent invoice for £450 with a £450 bank transfer recorded today. */
async function paidInvoice(c: Client) {
  await c.req('PATCH', '/api/settings', {
    bankAccountName: 'Test Electrical',
    bankSortCode: '400000',
    bankAccountNumber: '12345678',
  });
  const cust = await seedCustomer(c);
  const lines = [{ kind: 'labour', description: 'Rewire', qtyMilli: 1000, unitPricePence: 45000 }];
  const q = (await c.req('POST', '/api/quotes', { customerId: cust.id, title: 'Rewire', lines }))
    .body;
  await c.req('POST', `/api/quotes/${q.id}/send`);
  await c.req('POST', `/api/quotes/${q.id}/accept`, { acceptedOptions: [] });
  const job = (await c.req('POST', `/api/quotes/${q.id}/convert`)).body;
  const inv = (
    await c.req('POST', `/api/jobs/${job.id}/invoices`, { source: 'quote', mode: 'whole' })
  ).body;
  await c.req('POST', `/api/invoices/${inv.id}/approve`);
  await c.req('POST', `/api/invoices/${inv.id}/mark-sent`);
  const paid = await c.req('POST', `/api/invoices/${inv.id}/payments`, {
    amountPence: 45000,
    paidOn: todayIso(),
    method: 'bank_transfer',
    reference: '',
  });
  expect(paid.status).toBe(201);
  const pay = (await c.req('GET', `/api/invoices/${inv.id}`)).body.payments[0];
  return {
    cust,
    inv: (await c.req('GET', `/api/invoices/${inv.id}`)).body,
    payId: pay.id as string,
  };
}

describe('bank matching', () => {
  it('suggests the payment and the expense, matches once, unmatches, ignores', async () => {
    const c = await client();
    const { inv, payId } = await paidInvoice(c);
    const fuel = (
      await c.req('POST', '/api/expenses', {
        date: todayIso(),
        payee: 'Island Fuel',
        account: '449',
        amountPence: 6000,
      })
    ).body;
    const csv = [
      'Date,Description,Amount',
      `${day(0)},FASTER PAYMENT ${inv.number},450.00`,
      `${day(0)},ISLAND FUEL STN,-60.00`,
      `${day(0)},TRANSFER TO SAVINGS,-1000.00`,
    ].join('\n');
    await c.req('POST', '/api/bank/imports', { fileName: 'm.csv', csv });
    const list = (await c.req('GET', '/api/bank/transactions')).body as BankTransactionDto[];
    const pay = list.find((x) => x.amountPence === 45000)!;
    const out = list.find((x) => x.amountPence === -6000)!;
    const transfer = list.find((x) => x.amountPence === -100000)!;
    expect(pay.suggestions[0]).toMatchObject({ kind: 'payment', id: payId, strong: true });
    expect(pay.suggestions[0]!.label).toMatch(/^Payment from .+ for /);
    expect(out.suggestions[0]).toMatchObject({ kind: 'expense', id: fuel.id, strong: true });
    expect(transfer.suggestions).toEqual([]);

    expect(
      (
        await c.req('POST', `/api/bank/transactions/${pay.id}/match`, {
          kind: 'payment',
          id: payId,
        })
      ).status,
    ).toBe(204);
    // Wrong amount, already matched, or taken by another line: refused.
    const wrong = await c.req('POST', `/api/bank/transactions/${out.id}/match`, {
      kind: 'payment',
      id: payId,
    });
    expect([409, 422]).toContain(wrong.status);
    expect(
      (
        await c.req('POST', `/api/bank/transactions/${pay.id}/match`, {
          kind: 'payment',
          id: payId,
        })
      ).status,
    ).toBe(409);
    await c.req('POST', `/api/bank/transactions/${out.id}/match`, { kind: 'expense', id: fuel.id });
    await c.req('PUT', `/api/bank/transactions/${transfer.id}/status`, { status: 'ignored' });

    expect((await c.req('GET', '/api/bank/transactions')).body).toEqual([]);
    const matched = (await c.req('GET', '/api/bank/transactions?status=matched'))
      .body as BankTransactionDto[];
    expect(matched.map((x) => x.matchedTo?.kind).sort()).toEqual(['expense', 'payment']);
    expect(matched.find((x) => x.matchedTo?.kind === 'payment')!.matchedTo!.label).toMatch(
      /^Payment from/,
    );
    // Unmatch: back in the list, and the payment is suggested again.
    await c.req('PUT', `/api/bank/transactions/${pay.id}/status`, { status: 'unmatched' });
    const again = (await c.req('GET', '/api/bank/transactions')).body as BankTransactionDto[];
    expect(again).toHaveLength(1);
    expect(again[0]!.suggestions[0]!.id).toBe(payId);
    // A matched line can't be ignored without unmatching first.
    const ign = await c.req('PUT', `/api/bank/transactions/${out.id}/status`, {
      status: 'ignored',
    });
    expect(ign.status).toBe(409);
  });

  it('another business’s lines and payments can’t be matched', async () => {
    const c = await client();
    const { payId } = await paidInvoice(c);
    const other = await client();
    await other.req('POST', '/api/bank/imports', {
      fileName: 'o.csv',
      csv: `Date,Description,Amount\n${day(0)},X,450.00\n`,
    });
    const [line] = (await other.req('GET', '/api/bank/transactions')).body as BankTransactionDto[];
    expect(line!.suggestions).toEqual([]);
    const r = await other.req('POST', `/api/bank/transactions/${line!.id}/match`, {
      kind: 'payment',
      id: payId,
    });
    expect(r.status).toBe(404);
    expect(
      (
        await c.req('POST', `/api/bank/transactions/${line!.id}/match`, {
          kind: 'payment',
          id: payId,
        })
      ).status,
    ).toBe(404);
  });
});

describe('bank line to expense', () => {
  it('records a money-out line as an expense with its date and amount, matched; refuses money in', async () => {
    const c = await client();
    await c.req('POST', '/api/bank/imports', {
      fileName: 'e.csv',
      csv: `Date,Description,Amount\n${day(-1)},CONDOR FERRIES,-86.50\n${day(-1)},SOMEONE,20.00\n`,
    });
    const list = (await c.req('GET', '/api/bank/transactions')).body as BankTransactionDto[];
    const out = list.find((l) => l.amountPence < 0)!;
    const inn = list.find((l) => l.amountPence > 0)!;
    const r = await c.req('POST', `/api/bank/transactions/${out.id}/expense`, {
      account: '493',
      payee: 'Condor Ferries',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ account: '493', amountPence: 8650, date: out.date });
    const matched = (await c.req('GET', '/api/bank/transactions?status=matched'))
      .body as BankTransactionDto[];
    expect(matched[0]!.matchedTo).toMatchObject({ kind: 'expense', id: r.body.id });
    expect(
      (
        await c.req('POST', `/api/bank/transactions/${out.id}/expense`, {
          account: '493',
          payee: 'X',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await c.req('POST', `/api/bank/transactions/${inn.id}/expense`, {
          account: '493',
          payee: 'X',
        })
      ).status,
    ).toBe(422);
    const tax = await c.req('POST', `/api/bank/transactions/${inn.id}/expense`, {
      account: '493',
      payee: 'X',
      taxPence: -1,
    });
    expect(tax.status).toBe(422);
  });
});

describe('payment from a bank line', () => {
  it('records the customer payment from money in and matches it, owner only', async () => {
    const c = await client();
    const cust = await seedCustomer(c);
    await c.req('PATCH', '/api/settings', {
      bankAccountName: 'Test Electrical',
      bankSortCode: '400000',
      bankAccountNumber: '12345678',
    });
    const lines = [
      { kind: 'labour', description: 'Rewire', qtyMilli: 1000, unitPricePence: 45000 },
    ];
    const q = (await c.req('POST', '/api/quotes', { customerId: cust.id, title: 'Rewire', lines }))
      .body;
    await c.req('POST', `/api/quotes/${q.id}/send`);
    await c.req('POST', `/api/quotes/${q.id}/accept`, { acceptedOptions: [] });
    const job = (await c.req('POST', `/api/quotes/${q.id}/convert`)).body;
    const inv = (
      await c.req('POST', `/api/jobs/${job.id}/invoices`, { source: 'quote', mode: 'whole' })
    ).body;
    await c.req('POST', `/api/invoices/${inv.id}/approve`);
    await c.req('POST', `/api/invoices/${inv.id}/mark-sent`);
    const csv = [
      'Date,Description,Amount',
      `${day(0)},FP SMITH PART,200.00`,
      `${day(0)},FP SMITH REST,250.00`,
      `${day(0)},TOO MUCH,999.00`,
      `${day(0)},SHOP,-5.00`,
    ].join('\n');
    await c.req('POST', '/api/bank/imports', { fileName: 'p.csv', csv });
    const list = (await c.req('GET', '/api/bank/transactions')).body as BankTransactionDto[];
    const by = (p: number) => list.find((x) => x.amountPence === p)!;

    // Someone with Accounts access but not the owner can't record a payment.
    const { s, id } = await staff(c);
    await c.req('PUT', `/api/team/${id}/access`, { isAdmin: false, areas: ['financials'] });
    expect((await s.req('GET', '/api/bank/transactions')).status).toBe(200);
    const denied = await s.req('POST', `/api/bank/transactions/${by(20000).id}/payment`, {
      invoiceId: inv.id,
    });
    expect(denied.status).toBe(403);

    const part = await c.req('POST', `/api/bank/transactions/${by(20000).id}/payment`, {
      invoiceId: inv.id,
    });
    expect(part.status, JSON.stringify(part.body)).toBe(201);
    let detail = (await c.req('GET', `/api/invoices/${inv.id}`)).body;
    expect(detail.status).toBe('part_paid');
    expect(detail.payments[0]).toMatchObject({
      amountPence: 20000,
      method: 'bank_transfer',
      reference: 'FP SMITH PART',
    });
    // More than is owed, money out, or a line already used: refused, nothing recorded.
    const over = await c.req('POST', `/api/bank/transactions/${by(99900).id}/payment`, {
      invoiceId: inv.id,
    });
    expect(over.status).toBe(422);
    expect(
      (await c.req('POST', `/api/bank/transactions/${by(-500).id}/payment`, { invoiceId: inv.id }))
        .status,
    ).toBe(422);
    expect(
      (await c.req('POST', `/api/bank/transactions/${by(20000).id}/payment`, { invoiceId: inv.id }))
        .status,
    ).toBe(409);
    const rest = await c.req('POST', `/api/bank/transactions/${by(25000).id}/payment`, {
      invoiceId: inv.id,
    });
    expect(rest.status).toBe(201);
    detail = (await c.req('GET', `/api/invoices/${inv.id}`)).body;
    expect(detail.status).toBe('paid');
    expect(detail.payments).toHaveLength(2);
    const matched = (await c.req('GET', '/api/bank/transactions?status=matched'))
      .body as BankTransactionDto[];
    expect(matched).toHaveLength(2);
    expect(matched.every((x) => x.matchedTo?.kind === 'payment')).toBe(true);
  });
});
