import { describe, expect, it } from 'vitest';
import {
  addMonths,
  ageBucket,
  aged,
  accountTransactions,
  balanceSheet,
  budgetMonths,
  budgetUpdate,
  budgetVsActual,
  bsFigures,
  cashFlow,
  compareRange,
  monthlyCash,
  openBills,
  openInvoices,
  overview,
  plFigures,
  postings,
  presetRange,
  profitAndLoss,
  splitPro,
  tableCsv,
  taxSummary,
  type BooksInput,
  type BusinessDto,
} from '../src';

const inv = (
  id: string,
  date: string,
  due: string | null,
  labour: number,
  net: number,
  tax = 0,
  cust = 'c1',
  name = 'Ann Example',
) => ({
  id,
  number: `INV-${id}`,
  customerId: cust,
  customerName: name,
  jobNumber: '122',
  issueDate: date,
  dueDate: due,
  labourNetPence: labour,
  netPence: net,
  taxPence: tax,
  totalPence: net + tax,
});

function books(): BooksInput {
  return {
    opening: { date: '2027-01-01', bankPence: 100_000 },
    invoices: [
      inv('1', '2027-01-10', '2027-01-24', 30_000, 50_000),
      inv('2', '2027-02-05', '2027-02-19', 10_000, 20_000, 1_000, 'c2', 'Bob Sample'),
      inv('3', '2026-12-01', '2026-12-15', 5_000, 5_000),
    ],
    payments: [
      {
        id: 'p1',
        invoiceId: '1',
        date: '2027-01-30',
        amountPence: 20_000,
        method: 'bank_transfer',
        reference: null,
      },
      {
        id: 'p3',
        invoiceId: '3',
        date: '2026-12-20',
        amountPence: 5_000,
        method: 'cash',
        reference: null,
      },
    ],
    credits: [
      { id: 'cn1', invoiceId: '2', number: 'CN-0001', date: '2027-02-10', amountPence: 2_100 },
    ],
    bills: [
      {
        id: 'b1',
        supplierId: 's1',
        supplierName: 'CEF',
        reference: 'GUR1',
        kind: 'bill',
        date: '2027-01-12',
        dueDate: '2027-02-28',
        totalPence: 12_000,
        homePence: 2_000,
      },
      {
        id: 'b2',
        supplierId: 's1',
        supplierName: 'CEF',
        reference: 'GURC',
        kind: 'credit_note',
        date: '2027-01-20',
        dueDate: null,
        totalPence: 1_000,
        homePence: 0,
      },
    ],
    billPayments: [
      {
        id: 'bp1',
        billId: 'b1',
        date: '2027-02-01',
        amountPence: 5_000,
        method: 'bank_transfer',
        reference: 'BACS',
      },
    ],
    budgets: [
      { month: '2027-01', account: '200', amountPence: 25_000 },
      { month: '2027-02', account: '200', amountPence: 25_000 },
      { month: '2027-01', account: '310', amountPence: 8_000 },
    ],
  };
}

describe('postings', () => {
  it('every document balances (debits equal credits)', () => {
    const ps = postings(books());
    const bySource = new Map<string, number>();
    for (const p of ps) bySource.set(p.sourceId, (bySource.get(p.sourceId) ?? 0) + p.pence);
    for (const v of bySource.values()) expect(v).toBe(0);
    expect(ps.reduce((s, p) => s + p.pence, 0)).toBe(0);
  });
  it('splits a credit note across labour, materials and tax in the invoice proportions', () => {
    const ps = postings(books()).filter((p) => p.sourceId === 'cn1');
    const g = (a: string) => ps.find((p) => p.account === a)?.pence ?? 0;
    expect(g('200')).toBe(1_000);
    expect(g('210')).toBe(1_000);
    expect(g('820')).toBe(100);
    expect(g('610')).toBe(-2_100);
  });
  it('books home items to drawings, not costs', () => {
    const ps = postings(books()).filter((p) => p.sourceId === 'b1');
    expect(ps.find((p) => p.account === '310')?.pence).toBe(10_000);
    expect(ps.find((p) => p.account === '880')?.pence).toBe(2_000);
  });
  it('splitPro always adds up exactly', () => {
    for (const t of [1, 7, 99, 1001, -333]) {
      const s = splitPro(t, [3, 3, 3]);
      expect(s.reduce((a, b) => a + b, 0)).toBe(t);
    }
    expect(splitPro(50, [0, 0])).toEqual([50, 0]);
  });
});

describe('dates and ranges', () => {
  it('presets use the calendar year by default and whole months', () => {
    expect(presetRange('this_month', '2027-02-14')).toEqual({
      from: '2027-02-01',
      to: '2027-02-28',
    });
    expect(presetRange('last_month', '2027-01-14')).toEqual({
      from: '2026-12-01',
      to: '2026-12-31',
    });
    expect(presetRange('this_quarter', '2027-05-14')).toEqual({
      from: '2027-04-01',
      to: '2027-06-30',
    });
    expect(presetRange('last_quarter', '2027-02-14')).toEqual({
      from: '2026-10-01',
      to: '2026-12-31',
    });
    expect(presetRange('this_year', '2027-11-18')).toEqual({
      from: '2027-01-01',
      to: '2027-12-31',
    });
    expect(presetRange('last_year', '2027-11-18')).toEqual({
      from: '2026-01-01',
      to: '2026-12-31',
    });
    expect(presetRange('year_to_date', '2027-11-18')).toEqual({
      from: '2027-01-01',
      to: '2027-11-18',
    });
    expect(presetRange('year_to_date', '2027-03-01', '04-06')).toEqual({
      from: '2026-04-06',
      to: '2027-03-01',
    });
  });
  it('comparison periods', () => {
    expect(compareRange({ from: '2027-03-01', to: '2027-03-31' }, 'previous')).toEqual({
      from: '2027-02-01',
      to: '2027-02-28',
    });
    expect(compareRange({ from: '2027-01-01', to: '2027-03-31' }, 'previous')).toEqual({
      from: '2026-10-01',
      to: '2026-12-31',
    });
    expect(compareRange({ from: '2027-11-01', to: '2027-11-18' }, 'previous')).toEqual({
      from: '2027-10-01',
      to: '2027-10-18',
    });
    expect(compareRange({ from: '2027-01-01', to: '2027-11-18' }, 'previous')).toEqual({
      from: '2026-01-01',
      to: '2026-11-18',
    });
    expect(compareRange({ from: '2027-01-10', to: '2027-01-19' }, 'previous')).toEqual({
      from: '2026-12-31',
      to: '2027-01-09',
    });
    expect(compareRange({ from: '2028-02-01', to: '2028-02-29' }, 'last_year')).toEqual({
      from: '2027-02-01',
      to: '2027-02-28',
    });
  });
  it('addMonths clamps to the end of the month', () => {
    expect(addMonths('2027-03-31', -1)).toBe('2027-02-28');
    expect(addMonths('2027-12-15', 1)).toBe('2028-01-15');
  });
  it('age buckets by days past due', () => {
    expect(ageBucket(null, '2027-01-01')).toBe(0);
    expect(ageBucket('2027-01-01', '2027-01-01')).toBe(0);
    expect(ageBucket('2027-01-01', '2027-01-02')).toBe(1);
    expect(ageBucket('2027-01-01', '2027-01-31')).toBe(1);
    expect(ageBucket('2027-01-01', '2027-02-01')).toBe(2);
    expect(ageBucket('2027-01-01', '2027-04-01')).toBe(3);
    expect(ageBucket('2027-01-01', '2027-04-02')).toBe(4);
  });
});

describe('profit and loss', () => {
  it('accrual income less credit notes, costs from bills', () => {
    const f = plFigures(postings(books()), { from: '2027-01-01', to: '2027-02-28' });
    expect(f.byAccount.get('200')).toBe(40_000 - 1_000);
    expect(f.byAccount.get('210')).toBe(30_000 - 1_000);
    expect(f.income).toBe(68_000);
    expect(f.costOfSales).toBe(10_000 - 1_000);
    expect(f.netProfit).toBe(59_000);
  });
  it('table with a comparison column and a change column', () => {
    const t = profitAndLoss(books(), { from: '2027-02-01', to: '2027-02-28' }, [
      { from: '2027-01-01', to: '2027-01-31' },
    ]);
    expect(t.columns).toHaveLength(3);
    const net = t.rows.find((r) => r.label === 'Net profit')!;
    expect(net.values).toEqual([18_000, 41_000, -23_000]);
  });
});

describe('balance sheet', () => {
  it('always balances, at any date', () => {
    const ps = postings(books());
    for (const d of ['2026-12-01', '2026-12-31', '2027-01-15', '2027-02-10', '2027-12-31']) {
      const f = bsFigures(ps, d, '01-01');
      expect(f.netAssets).toBe(f.equity);
    }
  });
  it('splits earnings into retained (before the year) and current year', () => {
    const f = bsFigures(postings(books()), '2027-02-28', '01-01');
    expect(f.retained).toBe(5_000);
    expect(f.currentYear).toBe(59_000);
    expect(f.bank).toBe(100_000 + 5_000 + 20_000 - 5_000);
    expect(f.receivables).toBe(30_000 + 18_900);
    expect(f.payables).toBe(12_000 - 1_000 - 5_000);
    expect(f.tax).toBe(900);
    const t = balanceSheet(books(), '2027-02-28');
    expect(t.rows.find((r) => r.label === 'Net assets')!.values).toEqual(
      t.rows.find((r) => r.label === 'Total equity')!.values,
    );
  });
});

describe('aged balances', () => {
  it('open invoices respect payments and credits up to the date', () => {
    expect(openInvoices(books(), '2027-01-25').map((i) => [i.id, i.duePence])).toEqual([
      ['1', 50_000],
    ]);
    expect(openInvoices(books(), '2027-03-01').map((i) => [i.id, i.duePence])).toEqual([
      ['1', 30_000],
      ['2', 18_900],
    ]);
  });
  it('a supplier credit note is a negative open item', () => {
    expect(
      openBills(books(), '2027-03-01')
        .map((b) => b.duePence)
        .sort(),
    ).toEqual([-1_000, 7_000]);
  });
  it('buckets per customer with totals', () => {
    const t = aged(books(), 'receivables', '2027-03-01');
    const ann = t.rows.find((r) => r.label === 'Ann Example')!;
    expect(ann.values).toEqual([0, 0, 30_000, 0, 0, 30_000]);
    const total = t.rows.find((r) => r.kind === 'total')!;
    expect(total.values[5]).toBe(48_900);
  });
});

describe('cash flow', () => {
  it('monthly in, out and closing balance match the bank', () => {
    const { opening, months } = monthlyCash(books(), { from: '2027-01-01', to: '2027-02-28' });
    expect(opening).toBe(5_000);
    expect(months.map((m) => [m.inPence, m.outPence, m.closingPence])).toEqual([
      [20_000, 0, 125_000],
      [0, 5_000, 120_000],
    ]);
    const t = cashFlow(books(), { from: '2027-01-01', to: '2027-02-28' });
    expect(t.rows.find((r) => r.label === 'Closing bank balance')!.values).toEqual([
      125_000, 120_000, 120_000,
    ]);
    expect(bsFigures(postings(books()), '2027-02-28', '01-01').bank).toBe(120_000);
  });
});

describe('tax, budget, account transactions', () => {
  it('tax summary nets credit notes', () => {
    const t = taxSummary(books(), { from: '2027-01-01', to: '2027-12-31' });
    expect(t.rows.find((r) => r.kind === 'total')!.values).toEqual([900]);
  });
  it('budget vs actual: positive variance is good', () => {
    const t = budgetVsActual(books(), { from: '2027-01-01', to: '2027-02-28' });
    const lab = t.rows.find((r) => r.account === '200')!;
    expect(lab.values).toEqual([39_000, 50_000, -11_000, -2200]);
    const mat = t.rows.find((r) => r.account === '310')!;
    expect(mat.values).toEqual([9_000, 8_000, -1_000, -1250]);
  });
  it('account transactions carry a running balance; P&L accounts start at zero', () => {
    const t = accountTransactions(books(), '090', { from: '2027-01-01', to: '2027-12-31' });
    expect(t.rows[0]!.values[2]).toBe(5_000);
    expect(t.rows[t.rows.length - 1]!.values).toEqual([120_000, 5_000, 120_000]);
    const s = accountTransactions(books(), '200', { from: '2027-01-01', to: '2027-12-31' });
    expect(s.rows[0]!.values[2]).toBe(0);
    expect(s.rows[s.rows.length - 1]!.values[2]).toBe(39_000);
  });
  it('budget input: 12 months, P&L accounts only', () => {
    expect(budgetMonths(2027)).toHaveLength(12);
    expect(budgetMonths(2027, 4)[11]).toBe('2028-03');
    expect(
      budgetUpdate.safeParse({ year: 2027, lines: [{ account: '090', months: Array(12).fill(0) }] })
        .success,
    ).toBe(false);
    expect(
      budgetUpdate.safeParse({ year: 2027, lines: [{ account: '200', months: Array(11).fill(0) }] })
        .success,
    ).toBe(false);
    expect(
      budgetUpdate.safeParse({
        year: 2027,
        lines: [{ account: '200', months: Array(12).fill(100) }],
      }).success,
    ).toBe(true);
  });
});

describe('csv and overview', () => {
  it('csv is spreadsheet-safe with pounds', () => {
    const csv = tableCsv(aged(books(), 'receivables', '2027-03-01'));
    expect(csv).toContain('Over 90 days (£)');
    expect(csv).toContain('Ann Example,0.00,0.00,300.00,0.00,0.00,300.00');
    const evil = {
      ...books(),
      invoices: [inv('9', '2027-01-01', null, 0, 100, 0, 'cx', '=HYPERLINK("x")')],
    };
    expect(tableCsv(aged(evil, 'receivables', '2027-03-01'))).toContain(`"'=HYPERLINK(""x"")"`);
  });
  it('overview pulls the headline figures together', () => {
    const d: BusinessDto = {
      ...books(),
      today: '2027-02-28',
      yearStart: '01-01',
      yearEffectiveFrom: '2027-01-01',
      pipeline: [],
      openQuotes: { count: 0, valuePence: 0 },
    };
    const o = overview(d);
    expect(o.bankPence).toBe(120_000);
    expect(o.owedToYou.totalPence).toBe(48_900);
    expect(o.owedToYou.overdueCount).toBe(2);
    expect(o.youOwe.totalPence).toBe(6_000);
    expect(o.cash).toHaveLength(12);
    expect(o.profit.year.netProfit).toBe(59_000);
    expect(o.profit.lastYear.netProfit).toBe(0);
  });
});
