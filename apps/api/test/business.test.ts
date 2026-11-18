import { describe, expect, it } from 'vitest';
import { balanceSheet, overview, profitAndLoss, type BusinessDto } from '@lse/shared';
import { client, clientFor, seedCustomer, type Client } from './api-helpers';
import { addMember, adminSql } from './helpers';

const todayIso = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Guernsey' }).format(new Date());

async function member(c: Client, role: 'staff' | 'subcontractor' | 'accountant') {
  const email = await addMember(c.tenantId, role);
  const [u] = await adminSql<{ id: string }[]>`SELECT id FROM users WHERE email = ${email}`;
  return { s: await clientFor(email, { tenantId: c.tenantId, userId: u!.id }), id: u!.id };
}

async function invoicedJob(c: Client) {
  await c.req('PATCH', '/api/settings', {
    bankAccountName: 'Test Electrical',
    bankSortCode: '400000',
    bankAccountNumber: '12345678',
  });
  const cust = await seedCustomer(c);
  const q = (
    await c.req('POST', '/api/quotes', {
      customerId: cust.id,
      title: 'Garage sockets',
      lines: [
        { kind: 'labour', description: 'Fit sockets', qtyMilli: 2000 },
        { kind: 'material', description: 'Sockets', qtyMilli: 2000, unitPricePence: 1500 },
      ],
    })
  ).body;
  await c.req('POST', `/api/quotes/${q.id}/send`);
  await c.req('POST', `/api/quotes/${q.id}/accept`, { acceptedOptions: [] });
  const job = (await c.req('POST', `/api/quotes/${q.id}/convert`)).body;
  const inv = (
    await c.req('POST', `/api/jobs/${job.id}/invoices`, { source: 'quote', mode: 'whole' })
  ).body;
  expect((await c.req('POST', `/api/invoices/${inv.id}/approve`)).status).toBe(200);
  expect((await c.req('POST', `/api/invoices/${inv.id}/mark-sent`)).status).toBe(200);
  return { job, inv };
}

describe('business overview and books', () => {
  it('sends the books to admins; the shared reports balance and agree with the invoice', async () => {
    const c = await client();
    const { inv } = await invoicedJob(c);
    await c.req('POST', `/api/invoices/${inv.id}/payments`, {
      amountPence: 5000,
      paidOn: todayIso(),
      method: 'bank_transfer',
    });

    const bill = (
      await c.req('POST', '/api/supplier-bills', {
        supplier: 'Island Electrical',
        reference: 'GUR/2001',
        billDate: todayIso(),
        lines: [
          { description: 'Cable', qtyMilli: 1000, unitCostPence: 3000, allocation: 'stock' },
          {
            description: 'Bulbs for home',
            qtyMilli: 1000,
            unitCostPence: 1000,
            allocation: 'home',
          },
        ],
      })
    ).body;
    expect(
      (await c.req('POST', `/api/supplier-bills/${bill.id}/apply`, { dryRun: false })).status,
    ).toBe(200);

    // Opening bank balance and a budget (admins only).
    expect(
      (await c.req('PUT', '/api/business/opening', { date: '2026-01-01', bankPence: 100000 }))
        .status,
    ).toBe(200);
    const months = Array(12).fill(10000);
    expect(
      (
        await c.req('PUT', '/api/business/budget', {
          year: Number(todayIso().slice(0, 4)),
          lines: [{ account: '200', months }],
        })
      ).status,
    ).toBe(200);

    const r = await c.req('GET', '/api/business');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const d = r.body as BusinessDto;
    expect(d.invoices).toHaveLength(1);
    expect(d.invoices[0]).toMatchObject({
      totalPence: inv.totalPence,
      labourNetPence: 9000,
      netPence: 12000,
    });
    expect(d.bills[0]).toMatchObject({ totalPence: 4000, homePence: 1000 });
    expect(d.budgets).toHaveLength(12);
    expect(d.pipeline.reduce((s, p) => s + p.count, 0)).toBe(1);

    const o = overview(d);
    expect(o.bankPence).toBe(100000 + 5000);
    expect(o.owedToYou.totalPence).toBe(inv.totalPence - 5000);
    expect(o.youOwe.totalPence).toBe(4000);
    expect(o.profit.year.income).toBe(12000);
    expect(o.profit.year.costOfSales).toBe(3000);
    const bs = balanceSheet(d, d.today);
    const v = (l: string) => bs.rows.find((x) => x.label === l)!.values[0];
    expect(v('Net assets')).toBe(v('Total equity'));
    const pl = profitAndLoss(d, { from: `${d.today.slice(0, 4)}-01-01`, to: d.today });
    expect(pl.rows.find((x) => x.label === 'Net profit')!.values[0]).toBe(9000);

    // Pay the supplier: the bill drops out of payables and the bank goes down.
    const pay = await c.req('POST', `/api/supplier-bills/${bill.id}/payments`, {
      amountPence: 4000,
      paidOn: todayIso(),
      method: 'bank_transfer',
      reference: 'BACS',
    });
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);
    expect(pay.body).toHaveLength(1);
    const over = await c.req('POST', `/api/supplier-bills/${bill.id}/payments`, {
      amountPence: 1,
      paidOn: todayIso(),
      method: 'cash',
    });
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('overpayment');
    const o2 = overview((await c.req('GET', '/api/business')).body);
    expect(o2.youOwe.totalPence).toBe(0);
    expect(o2.bankPence).toBe(101000);
  });

  it('refuses a future payment date, a draft bill, and bad budget accounts', async () => {
    const c = await client();
    const bill = (
      await c.req('POST', '/api/supplier-bills', {
        supplier: 'Island Electrical',
        reference: 'GUR/2002',
        billDate: '2026-11-01',
        lines: [{ description: 'Cable', qtyMilli: 1000, unitCostPence: 3000 }],
      })
    ).body;
    const draft = await c.req('POST', `/api/supplier-bills/${bill.id}/payments`, {
      amountPence: 100,
      paidOn: '2026-11-02',
      method: 'cash',
    });
    expect(draft.status).toBe(409);
    await c.req('POST', `/api/supplier-bills/${bill.id}/apply`, { dryRun: false });
    const future = await c.req('POST', `/api/supplier-bills/${bill.id}/payments`, {
      amountPence: 100,
      paidOn: '2999-01-01',
      method: 'cash',
    });
    expect(future.status).toBe(422);
    const bad = await c.req('PUT', '/api/business/budget', {
      year: 2027,
      lines: [{ account: '090', months: Array(12).fill(1) }],
    });
    expect(bad.status).toBe(422);
  });

  it('needs Reports and Accounts access; changes are admin only; other businesses see nothing', async () => {
    const c = await client();
    await invoicedJob(c);
    const office = await member(c, 'staff'); // Office: Accounts but not Reports
    expect((await office.s.req('GET', '/api/business')).status).toBe(403);
    await c.req('PUT', `/api/team/${office.id}/access`, { isAdmin: false, areas: ['reports'] });
    expect((await office.s.req('GET', '/api/business')).status).toBe(403); // Reports without Accounts
    await c.req('PUT', `/api/team/${office.id}/access`, {
      isAdmin: false,
      areas: ['reports', 'financials'],
    });
    expect((await office.s.req('GET', '/api/business')).status).toBe(200);
    const put = await office.s.req('PUT', '/api/business/opening', {
      date: '2026-01-01',
      bankPence: 1,
    });
    expect(put.status).toBe(403);
    expect(put.body.error.code).toBe('admin_only');
    const sub = await member(c, 'subcontractor');
    expect((await sub.s.req('GET', '/api/business')).status).toBe(403);
    expect(
      (await sub.s.req('GET', '/api/supplier-bills/00000000-0000-0000-0000-000000000000/payments'))
        .status,
    ).toBe(403);

    const other = await client();
    const d = (await other.req('GET', '/api/business')).body as BusinessDto;
    expect(d.invoices).toEqual([]);
    expect(d.opening).toBeNull();
  });
});

describe('approving with an earlier invoice date (bringing in invoices already sent)', () => {
  it('dates the invoice and its due date; refuses the future and more than a year back', async () => {
    const c = await client();
    await c.req('PATCH', '/api/settings', {
      bankAccountName: 'T',
      bankSortCode: '400000',
      bankAccountNumber: '12345678',
    });
    const cust = await seedCustomer(c);
    const mk = async () => {
      const job = (await c.req('POST', '/api/jobs', { customerId: cust.id, title: 'Old job' }))
        .body;
      await c.req('POST', `/api/jobs/${job.id}/lines`, {
        kind: 'material',
        description: 'Thing',
        qtyMilli: 1000,
        unitSellPence: 1000,
      });
      const inv = await c.req('POST', `/api/jobs/${job.id}/invoices`, { source: 'job' });
      return inv.body;
    };
    const t = todayIso();
    const y = Number(t.slice(0, 4));
    const a = await mk();
    expect(a.id, JSON.stringify(a)).toBeTruthy();
    const future = await c.req('POST', `/api/invoices/${a.id}/approve`, {
      issueDate: `${y + 1}-01-01`,
    });
    expect(future.status).toBe(422);
    const old = await c.req('POST', `/api/invoices/${a.id}/approve`, {
      issueDate: `${y - 2}-01-01`,
    });
    expect(old.status).toBe(422);
    const back = `${y}-01-02` <= t ? `${y}-01-02` : t;
    const ok = await c.req('POST', `/api/invoices/${a.id}/approve`, { issueDate: back });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.issueDate).toBe(back);
    expect(ok.body.dueDate > back).toBe(true);
    // No body still means today.
    const b = await mk();
    const plain = await c.req('POST', `/api/invoices/${b.id}/approve`);
    expect(plain.body.issueDate).toBe(t);
  });
});
