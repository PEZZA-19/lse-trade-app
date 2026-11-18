import { describe, expect, it } from 'vitest';
import {
  balanceSheet,
  cashFlow,
  expenseTotals,
  overview,
  profitAndLoss,
  type BusinessDto,
} from '@lse/shared';
import { client, clientFor, type Client } from './api-helpers';
import { addMember, adminSql } from './helpers';

const todayIso = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Guernsey' }).format(new Date());

async function member(c: Client, role: 'staff' | 'subcontractor') {
  const email = await addMember(c.tenantId, role);
  const [u] = await adminSql<{ id: string }[]>`SELECT id FROM users WHERE email = ${email}`;
  return { s: await clientFor(email, { tenantId: c.tenantId, userId: u!.id }), id: u!.id };
}

const books = async (c: Client) => (await c.req('GET', '/api/business')).body as BusinessDto;

describe('expenses and wages', () => {
  it('overheads and wages come off net profit, out of the bank, and the books still balance', async () => {
    const c = await client();
    const t = todayIso();
    const sam = await member(c, 'staff');
    const fuel = await c.req('POST', '/api/expenses', {
      date: t,
      payee: 'Island fuel',
      account: '449',
      description: 'Van diesel',
      amountPence: 6000,
    });
    expect(fuel.status, JSON.stringify(fuel.body)).toBe(201);
    expect(fuel.body).toMatchObject({ account: '449', taxPence: 0 });
    expect(fuel.body).not.toHaveProperty('paidFrom');
    const wages = await c.req('POST', '/api/expenses', {
      date: t,
      payee: 'Sam',
      account: '477',
      description: 'Week 46',
      amountPence: 50000,
      memberUserId: sam.id,
    });
    expect(wages.status).toBe(201);
    // Every expense is the business's, out of the business account (Joe, 18 Nov 2026).
    const ferry = await c.req('POST', '/api/expenses', {
      date: t,
      payee: 'Isle of Sark Shipping',
      account: '493',
      amountPence: 2000,
    });
    expect(ferry.status).toBe(201);

    const d = await books(c);
    expect(d.expenses).toHaveLength(3);
    const range = { from: `${t.slice(0, 4)}-01-01`, to: t };
    const pl = profitAndLoss(d, range);
    const row = (l: string) => pl.rows.find((r) => r.label === l)?.values[0];
    expect(row('Vehicle and fuel')).toBe(6000);
    expect(row('Wages and salaries')).toBe(50000);
    expect(row('Travel and ferries')).toBe(2000);
    expect(row('Insurance')).toBeUndefined(); // nothing spent: not listed
    expect(row('Total operating expenses')).toBe(58000);
    expect(row('Net profit')).toBe(-58000);
    expect(pl.notes?.join(' ')).not.toMatch(/not recorded in the app yet/);

    const o = overview(d);
    expect(o.bankPence).toBe(-58000);
    expect(o.profit.year.netProfit).toBe(-58000);
    const bs = balanceSheet(d, t);
    const v = (l: string) => bs.rows.find((x) => x.label === l)?.values[0];
    expect(v('Net assets')).toBe(v('Total equity'));

    const cf = cashFlow(d, { from: `${t.slice(0, 7)}-01`, to: t });
    const cv = (l: string) => cf.rows.find((x) => x.label === l)?.values.at(-1);
    expect(cv('Wages')).toBe(50000);
    expect(cv('Expenses')).toBe(8000);
    expect(cv('Paid to suppliers')).toBe(0);

    expect(expenseTotals(d.expenses!, range).map((x) => [x.name, x.netPence])).toEqual([
      ['Wages and salaries', 50000],
      ['Vehicle and fuel', 6000],
      ['Travel and ferries', 2000],
    ]);

    // Removing one takes it out of everything. Anyone with Accounts access can (Joe, 18 Nov 2026):
    // Sam is staff with the Office preset; a field worker can't.
    await c.req('PUT', `/api/team/${sam.id}/access`, { isAdmin: false, areas: [] });
    expect((await sam.s.req('DELETE', `/api/expenses/${fuel.body.id}`)).status).toBe(403);
    await c.req('PUT', `/api/team/${sam.id}/access`, { isAdmin: false, areas: ['financials'] });
    expect((await sam.s.req('DELETE', `/api/expenses/${fuel.body.id}`)).status).toBe(204);
    expect((await c.req('DELETE', `/api/expenses/${fuel.body.id}`)).status).toBe(404);
    expect((await c.req('GET', '/api/expenses')).body).toHaveLength(2);
    const [a] = await adminSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM audit_log WHERE entity_id = ${fuel.body.id} AND action = 'delete'`;
    expect(a!.n).toBe(1);
  });

  it('tax inside an expense is reclaimable, not a cost', async () => {
    const c = await client();
    const t = todayIso();
    await c.req('POST', '/api/expenses', {
      date: t,
      payee: 'Software Co',
      account: '463',
      amountPence: 1200,
      taxPence: 200,
    });
    const d = await books(c);
    const pl = profitAndLoss(d, { from: t, to: t });
    expect(pl.rows.find((r) => r.label === 'Software and subscriptions')?.values[0]).toBe(1000);
    const bs = balanceSheet(d, t);
    const v = (l: string) => bs.rows.find((x) => x.label === l)?.values[0];
    expect(v('Net assets')).toBe(v('Total equity'));
  });

  it('anyone with Accounts access records them; field workers can’t; bad input is explained', async () => {
    const c = await client();
    const t = todayIso();
    const staff = await member(c, 'staff');
    const sub = await member(c, 'subcontractor');
    const body = { date: t, payee: 'Insurer', account: '433', amountPence: 30000 };
    // Staff start with the Office preset (Accounts): they can.
    const byStaff = await staff.s.req('POST', '/api/expenses', body);
    expect(byStaff.status, JSON.stringify(byStaff.body)).toBe(201);
    await c.req('PUT', `/api/team/${staff.id}/access`, { isAdmin: false, areas: [] });
    expect((await staff.s.req('POST', '/api/expenses', body)).status).toBe(403);
    expect((await staff.s.req('DELETE', `/api/expenses/${byStaff.body.id}`)).status).toBe(403);
    expect((await sub.s.req('GET', '/api/expenses')).status).toBe(403);
    const future = await c.req('POST', '/api/expenses', { ...body, date: '2999-01-01' });
    expect(future.status).toBe(422);
    expect(future.body.error.message).toMatch(/future/);
    const tax = await c.req('POST', '/api/expenses', { ...body, taxPence: 30001 });
    expect(tax.status).toBe(422);
    const acct = await c.req('POST', '/api/expenses', { ...body, account: '310' });
    expect(acct.status).toBe(422);
    const stranger = await c.req('POST', '/api/expenses', {
      ...body,
      account: '477',
      memberUserId: '00000000-0000-4000-8000-000000000001',
    });
    expect(stranger.status).toBe(422);
    // Another business never sees them.
    expect((await c.req('POST', '/api/expenses', body)).status).toBe(201);
    const other = await client();
    expect((await other.req('GET', '/api/expenses')).body).toEqual([]);
    expect((await other.req('DELETE', `/api/expenses/${byStaff.body.id}`)).status).toBe(404);
  });

  it('budgets can be set for overheads and wages too', async () => {
    const c = await client();
    const y = Number(todayIso().slice(0, 4));
    const r = await c.req('PUT', '/api/business/budget', {
      year: y,
      lines: [{ account: '477', months: Array(12).fill(200000) }],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.budgets.filter((b: { account: string }) => b.account === '477')).toHaveLength(12);
  });
});
