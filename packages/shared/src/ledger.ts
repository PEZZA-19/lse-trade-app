import { z } from 'zod';
import { csvCell } from './reports';

/*
 * The business's books (Xero-style), worked out from the documents the app already keeps:
 * invoices, customer payments and credit notes, supplier bills and credit notes, supplier bill
 * payments, an opening bank balance and budgets. Every figure is a double-entry posting, so the
 * Balance Sheet always balances and every report agrees with every other one.
 *
 * Pure functions: the API sends the inputs (only to people with Accounts and Reports access) and
 * the same code runs on the server tests, in the app and in the offline demo.
 */

export type AccountType =
  'bank' | 'current_asset' | 'current_liability' | 'equity' | 'revenue' | 'direct_cost' | 'expense';

export interface Account {
  code: string;
  name: string;
  type: AccountType;
}

/** A small, fixed chart of accounts (Xero's default codes where one exists). */
export const ACCOUNTS: readonly Account[] = [
  { code: '090', name: 'Business bank account', type: 'bank' },
  { code: '610', name: 'Accounts receivable', type: 'current_asset' },
  { code: '800', name: 'Accounts payable', type: 'current_liability' },
  { code: '820', name: 'GST / VAT', type: 'current_liability' },
  { code: '880', name: "Owner's drawings", type: 'equity' },
  { code: '960', name: 'Retained earnings', type: 'equity' },
  { code: '970', name: 'Opening balance', type: 'equity' },
  { code: '200', name: 'Sales: labour', type: 'revenue' },
  { code: '210', name: 'Sales: materials and other', type: 'revenue' },
  { code: '310', name: 'Materials and supplies', type: 'direct_cost' },
  // Overheads and wages (Xero's default codes), entered as Expenses.
  { code: '404', name: 'Bank fees', type: 'expense' },
  { code: '412', name: 'Accountancy and legal', type: 'expense' },
  { code: '429', name: 'General expenses', type: 'expense' },
  { code: '433', name: 'Insurance', type: 'expense' },
  { code: '449', name: 'Vehicle and fuel', type: 'expense' },
  { code: '463', name: 'Software and subscriptions', type: 'expense' },
  { code: '473', name: 'Tools and repairs', type: 'expense' },
  { code: '477', name: 'Wages and salaries', type: 'expense' },
  { code: '489', name: 'Phone and internet', type: 'expense' },
  { code: '493', name: 'Travel and ferries', type: 'expense' },
] as const;
export const EXPENSE_ACCOUNT_CODES = [
  '404',
  '412',
  '429',
  '433',
  '449',
  '463',
  '473',
  '477',
  '489',
  '493',
] as const;
export type ExpenseAccountCode = (typeof EXPENSE_ACCOUNT_CODES)[number];
/** Wages: shown apart from other overheads in Cash Flow and on the Expenses screen. */
export const WAGES_ACCOUNT: ExpenseAccountCode = '477';
export type AccountCode =
  | '090'
  | '610'
  | '800'
  | '820'
  | '880'
  | '960'
  | '970'
  | '200'
  | '210'
  | '310'
  | ExpenseAccountCode;
export const accountByCode = (code: string) => ACCOUNTS.find((a) => a.code === code);
/** Accounts that can carry a budget (the Profit and Loss ones). */
export const PL_ACCOUNTS = ACCOUNTS.filter((a) =>
  ['revenue', 'direct_cost', 'expense'].includes(a.type),
);
const isPL = (code: string) => PL_ACCOUNTS.some((a) => a.code === code);
/** Debit-normal accounts show debits as positive; credit-normal ones show credits as positive. */
const creditNormal = (t: AccountType) =>
  t === 'revenue' || t === 'current_liability' || (t === 'equity' && true);

/* ------------------------------- inputs ------------------------------- */

export interface LedgerInvoice {
  id: string;
  number: string | null;
  customerId: string;
  customerName: string;
  jobNumber: string | null;
  issueDate: string;
  dueDate: string | null;
  /** Net (ex tax) labour lines; the rest of the net is materials and other. */
  labourNetPence: number;
  netPence: number;
  taxPence: number;
  totalPence: number;
}
export interface LedgerPayment {
  id: string;
  invoiceId: string;
  date: string;
  amountPence: number;
  method: string;
  reference: string | null;
}
export interface LedgerCredit {
  id: string;
  invoiceId: string;
  number: string | null;
  date: string;
  /** Gross (inc. tax); split across sales and tax in the invoice's own proportions. */
  amountPence: number;
}
/**
 * A customer credit (a job that came to less than £0, issued as a credit note) used against a
 * later invoice. Both sit in Accounts receivable, so it moves nothing in the books; it only
 * changes what is still owed on each (aged receivables, overview).
 */
export interface LedgerCreditUse {
  id: string;
  creditId: string;
  invoiceId: string;
  date: string;
  amountPence: number;
}
export interface LedgerBill {
  id: string;
  supplierId: string;
  supplierName: string;
  reference: string;
  kind: 'bill' | 'credit_note';
  date: string;
  dueDate: string | null;
  totalPence: number;
  /** Lines allocated to home (personal): booked to owner's drawings, not costs. */
  homePence: number;
}
export interface LedgerBillPayment {
  id: string;
  billId: string;
  date: string;
  amountPence: number;
  method: string;
  reference: string | null;
}
/**
 * Money spent that isn't a supplier bill for materials: overheads (insurance, fuel, phone, ferries)
 * and wages. Paid from the business bank, or by the owner personally (owner's money put in).
 */
export interface LedgerExpense {
  id: string;
  date: string;
  payee: string;
  account: ExpenseAccountCode;
  description: string;
  /** Gross, including any tax. */
  amountPence: number;
  /** Tax reclaimable within the amount (0 when none). */
  taxPence: number;
}
export interface LedgerBudget {
  /** YYYY-MM */
  month: string;
  account: string;
  amountPence: number;
}
export interface PipelineStage {
  key: string;
  name: string;
  /** Stage colour key, as on the stage pill. */
  colour: string;
  count: number;
  valuePence: number;
}
export interface BooksInput {
  opening: { date: string; bankPence: number } | null;
  invoices: LedgerInvoice[];
  payments: LedgerPayment[];
  credits: LedgerCredit[];
  /** Customer credits used against later invoices (optional: none if left out). */
  creditUses?: LedgerCreditUse[];
  bills: LedgerBill[];
  billPayments: LedgerBillPayment[];
  /** Overheads and wages (optional: none if left out). */
  expenses?: LedgerExpense[];
  budgets: LedgerBudget[];
}
/** What GET /api/business returns. */
export interface BusinessDto extends BooksInput {
  today: string;
  yearStart: string;
  yearEffectiveFrom: string;
  pipeline: PipelineStage[];
  /** Quotes sent and waiting for an answer. */
  openQuotes: { count: number; valuePence: number };
}

/* ------------------------------ postings ------------------------------ */

export type SourceKind =
  | 'opening'
  | 'invoice'
  | 'payment'
  | 'credit_note'
  | 'bill'
  | 'supplier_credit'
  | 'bill_payment'
  | 'expense';
export interface Posting {
  date: string;
  account: AccountCode;
  /** Signed: debit positive, credit negative. */
  pence: number;
  source: SourceKind;
  sourceId: string;
  reference: string;
  contact: string;
  description: string;
}

/** Split `total` in the proportions of `parts`, so the pieces always add up exactly. */
export function splitPro(total: number, parts: number[]): number[] {
  const whole = parts.reduce((s, p) => s + p, 0);
  if (whole === 0) return parts.map((_, i) => (i === 0 ? total : 0));
  const out = parts.map((p) => Math.trunc((total * p) / whole));
  out[0]! += total - out.reduce((s, p) => s + p, 0);
  return out;
}

/** Every document as double-entry postings (each document's postings add up to zero). */
export function postings(b: BooksInput): Posting[] {
  const out: Posting[] = [];
  const add = (p: Omit<Posting, 'account' | 'pence'>, lines: [AccountCode, number][]) => {
    for (const [account, pence] of lines) if (pence !== 0) out.push({ ...p, account, pence });
  };
  if (b.opening && b.opening.bankPence !== 0)
    add(
      {
        date: b.opening.date,
        source: 'opening',
        sourceId: 'opening',
        reference: 'Opening balance',
        contact: '',
        description: 'Bank balance brought forward',
      },
      [
        ['090', b.opening.bankPence],
        ['970', -b.opening.bankPence],
      ],
    );
  const invById = new Map(b.invoices.map((i) => [i.id, i]));
  for (const i of b.invoices) {
    add(
      {
        date: i.issueDate,
        source: 'invoice',
        sourceId: i.id,
        reference: i.number ?? 'Invoice',
        contact: i.customerName,
        description:
          i.totalPence < 0
            ? `Customer credit${i.jobNumber ? ` for job ${i.jobNumber}` : ''}`
            : i.jobNumber
              ? `Invoice for job ${i.jobNumber}`
              : 'Invoice',
      },
      [
        ['610', i.totalPence],
        ['200', -i.labourNetPence],
        ['210', -(i.netPence - i.labourNetPence)],
        ['820', -i.taxPence],
      ],
    );
  }
  for (const p of b.payments) {
    const i = invById.get(p.invoiceId);
    add(
      {
        date: p.date,
        source: 'payment',
        sourceId: p.id,
        reference: p.reference || i?.number || 'Payment',
        contact: i?.customerName ?? '',
        description: `Payment received${i?.number ? ` for ${i.number}` : ''}`,
      },
      [
        ['090', p.amountPence],
        ['610', -p.amountPence],
      ],
    );
  }
  for (const c of b.credits) {
    const i = invById.get(c.invoiceId);
    const [lab, other, tax] = i
      ? splitPro(c.amountPence, [i.labourNetPence, i.netPence - i.labourNetPence, i.taxPence])
      : [0, c.amountPence, 0];
    add(
      {
        date: c.date,
        source: 'credit_note',
        sourceId: c.id,
        reference: c.number ?? 'Credit note',
        contact: i?.customerName ?? '',
        description: `Credit note${i?.number ? ` against ${i.number}` : ''}`,
      },
      [
        ['200', lab!],
        ['210', other!],
        ['820', tax!],
        ['610', -c.amountPence],
      ],
    );
  }
  const billById = new Map(b.bills.map((x) => [x.id, x]));
  for (const x of b.bills) {
    const sign = x.kind === 'credit_note' ? -1 : 1;
    add(
      {
        date: x.date,
        source: x.kind === 'credit_note' ? 'supplier_credit' : 'bill',
        sourceId: x.id,
        reference: x.reference,
        contact: x.supplierName,
        description: x.kind === 'credit_note' ? 'Supplier credit note' : 'Supplier bill',
      },
      [
        ['310', sign * (x.totalPence - x.homePence)],
        ['880', sign * x.homePence],
        ['800', -sign * x.totalPence],
      ],
    );
  }
  for (const p of b.billPayments) {
    const x = billById.get(p.billId);
    add(
      {
        date: p.date,
        source: 'bill_payment',
        sourceId: p.id,
        reference: p.reference || x?.reference || 'Payment',
        contact: x?.supplierName ?? '',
        description: `Paid${x ? ` ${x.reference}` : ''}`,
      },
      [
        ['800', p.amountPence],
        ['090', -p.amountPence],
      ],
    );
  }
  for (const e of b.expenses ?? []) {
    add(
      {
        date: e.date,
        source: 'expense',
        sourceId: e.id,
        reference: e.description,
        contact: e.payee,
        description: e.account === WAGES_ACCOUNT ? 'Wages paid' : 'Expense',
      },
      [
        [e.account, e.amountPence - e.taxPence],
        ['820', e.taxPence],
        // Always out of the business account (Joe, 18 Nov 2026: "Expenses just come from the
        // profit of the company").
        ['090', -e.amountPence],
      ],
    );
  }
  return out.sort((a, z) => (a.date < z.date ? -1 : a.date > z.date ? 1 : 0));
}

/* ------------------------------ dates ------------------------------ */

const pad2 = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) =>
  `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
const utc = (s: string) => new Date(`${s}T00:00:00Z`);
export const addDays = (s: string, n: number) => iso(new Date(utc(s).getTime() + n * 86_400_000));
export const daysBetween = (a: string, b: string) =>
  Math.round((utc(b).getTime() - utc(a).getTime()) / 86_400_000);
const lastOfMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
/** Same day n months away, clamped to the month's end (31 Mar − 1 month = 28/29 Feb). */
export function addMonths(s: string, n: number) {
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const t = y * 12 + (m - 1) + n;
  const ny = Math.floor(t / 12);
  const nm = (t % 12) + 1;
  return `${ny}-${pad2(nm)}-${pad2(Math.min(d, lastOfMonth(ny, nm)))}`;
}
const isMonthStart = (s: string) => s.endsWith('-01');
const isMonthEnd = (s: string) => {
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  return d === lastOfMonth(y, m);
};

export interface DateRange {
  from: string;
  to: string;
}
export type RangePreset =
  | 'this_month'
  | 'last_month'
  | 'this_quarter'
  | 'last_quarter'
  | 'this_year'
  | 'last_year'
  | 'year_to_date';
export const RANGE_LABEL: Record<RangePreset, string> = {
  this_month: 'This month',
  last_month: 'Last month',
  this_quarter: 'This quarter',
  last_quarter: 'Last quarter',
  this_year: 'This year',
  last_year: 'Last year',
  year_to_date: 'Year to date',
};

/** A preset range in calendar terms; the year follows the business's year start (default 1 Jan). */
export function presetRange(p: RangePreset, today: string, yearStart = '01-01'): DateRange {
  const [y, m] = today.split('-').map(Number) as [number, number];
  const monthStart = `${y}-${pad2(m)}-01`;
  const qStartM = Math.floor((m - 1) / 3) * 3 + 1;
  const qStart = `${y}-${pad2(qStartM)}-01`;
  const thisYear = `${y}-${yearStart}` <= today ? `${y}-${yearStart}` : `${y - 1}-${yearStart}`;
  switch (p) {
    case 'this_month':
      return { from: monthStart, to: addDays(addMonths(monthStart, 1), -1) };
    case 'last_month': {
      const s = addMonths(monthStart, -1);
      return { from: s, to: addDays(monthStart, -1) };
    }
    case 'this_quarter':
      return { from: qStart, to: addDays(addMonths(qStart, 3), -1) };
    case 'last_quarter': {
      const s = addMonths(qStart, -3);
      return { from: s, to: addDays(qStart, -1) };
    }
    case 'this_year':
      return { from: thisYear, to: addDays(addMonths(thisYear, 12), -1) };
    case 'last_year': {
      const s = addMonths(thisYear, -12);
      return { from: s, to: addDays(thisYear, -1) };
    }
    case 'year_to_date':
      return { from: thisYear, to: today };
  }
}

export type Comparison = 'none' | 'previous' | 'last_year';
export const COMPARISON_LABEL: Record<Comparison, string> = {
  none: 'No comparison',
  previous: 'Previous period',
  last_year: 'Same period last year',
};
/** The period before (same length; whole months stay whole months) or the same dates a year back. */
export function compareRange(r: DateRange, c: Exclude<Comparison, 'none'>): DateRange {
  if (c === 'last_year') return { from: addMonths(r.from, -12), to: addMonths(r.to, -12) };
  const months =
    (Number(r.to.slice(0, 4)) - Number(r.from.slice(0, 4))) * 12 +
    Number(r.to.slice(5, 7)) -
    Number(r.from.slice(5, 7)) +
    1;
  if (isMonthStart(r.from) && isMonthEnd(r.to)) {
    const from = addMonths(r.from, -months);
    return { from, to: addDays(r.from, -1) };
  }
  // "To date" periods: month or quarter to date step back by their months (1-18 Nov → 1-18 Oct);
  // anything longer, like the year to date, compares with the same dates a year earlier.
  if (isMonthStart(r.from)) {
    const back = months <= 3 ? months : 12;
    return { from: addMonths(r.from, -back), to: addMonths(r.to, -back) };
  }
  const len = daysBetween(r.from, r.to) + 1;
  return { from: addDays(r.from, -len), to: addDays(r.from, -1) };
}

const fmtShort = (s: string) => {
  const d = utc(s);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const rangeLabel = (r: DateRange) =>
  r.from === r.to ? fmtShort(r.from) : `${fmtShort(r.from)} to ${fmtShort(r.to)}`;
export const monthLabel = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;

/* ------------------------------ tables ------------------------------ */

/** One report as a table: the screen, the CSV and the printout all draw from this. */
export interface ReportRow {
  label: string;
  kind: 'section' | 'line' | 'subtotal' | 'total' | 'note';
  values: (number | null)[];
  /** Account code, so a line can open Account Transactions. */
  account?: string;
  /** Text cells shown before the numbers (e.g. a date or reference). */
  text?: string[];
}
export interface ReportTable {
  title: string;
  subtitle: string;
  /** Headings for the text cells, then one per value column. */
  textColumns?: string[];
  columns: string[];
  /** 'money' columns are pence; 'percent' are basis points. */
  formats?: ('money' | 'percent' | 'count')[];
  rows: ReportRow[];
  notes?: string[];
}

const pounds = (p: number | null) => (p === null ? '' : (p / 100).toFixed(2));
/** CSV for any report table (sections become label-only rows, amounts in pounds). */
export function tableCsv(t: ReportTable, businessName = 'Little Sark Electric'): string {
  const head = [
    ...(t.textColumns ?? []),
    ...t.columns.map((c, i) =>
      (t.formats?.[i] ?? 'money') === 'money'
        ? `${c} (£)`
        : t.formats?.[i] === 'percent'
          ? `${c} (%)`
          : c,
    ),
  ];
  const lines = [
    [businessName, t.title, t.subtitle].map(csvCell).join(','),
    '',
    ['', ...head].map(csvCell).join(','),
    ...t.rows.map((r) =>
      [
        r.label,
        ...(t.textColumns ? (r.text ?? t.textColumns.map(() => '')) : []),
        ...r.values.map((v, i) => {
          const f = t.formats?.[i] ?? 'money';
          if (v === null) return '';
          return f === 'money' ? pounds(v) : f === 'percent' ? (v / 100).toFixed(1) : String(v);
        }),
      ]
        .map(csvCell)
        .join(','),
    ),
    ...(t.notes ?? []).flatMap((n) => ['', csvCell(n)]),
  ];
  return lines.join('\r\n') + '\r\n';
}

/* ------------------------------ balances ------------------------------ */

const inRange = (d: string, r: DateRange) => d >= r.from && d <= r.to;
/** Account balances (debit positive) for postings in a range. */
export function balances(ps: Posting[], r: DateRange): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of ps) if (inRange(p.date, r)) m.set(p.account, (m.get(p.account) ?? 0) + p.pence);
  return m;
}
const upTo = (asAt: string): DateRange => ({ from: '0000-01-01', to: asAt });
/** A balance shown the natural way round (income, liabilities and equity as positive credits). */
export function natural(code: string, debit: number) {
  const a = accountByCode(code);
  return (a && creditNormal(a.type) ? -debit : debit) || 0;
}

/* --------------------------- profit and loss -------------------------- */

export interface PLFigures {
  income: number;
  costOfSales: number;
  grossProfit: number;
  expenses: number;
  netProfit: number;
  byAccount: Map<string, number>;
}
export function plFigures(ps: Posting[], r: DateRange): PLFigures {
  const bal = balances(ps, r);
  const byAccount = new Map<string, number>();
  let income = 0;
  let cos = 0;
  let exp = 0;
  for (const a of PL_ACCOUNTS) {
    const v = natural(a.code, bal.get(a.code) ?? 0);
    byAccount.set(a.code, v);
    if (a.type === 'revenue') income += v;
    else if (a.type === 'direct_cost') cos += v;
    else exp += v;
  }
  return {
    income,
    costOfSales: cos,
    grossProfit: income - cos,
    expenses: exp,
    netProfit: income - cos - exp,
    byAccount,
  };
}

const colLabel = (r: DateRange) => rangeLabel(r);

export function profitAndLoss(b: BooksInput, r: DateRange, compare: DateRange[] = []): ReportTable {
  const ps = postings(b);
  const periods = [r, ...compare];
  const f = periods.map((p) => plFigures(ps, p));
  const withVar = compare.length === 1;
  const vals = (pick: (x: PLFigures) => number) => {
    const v = f.map(pick);
    return withVar ? [...v, v[0]! - v[1]!] : v;
  };
  const rowsFor = (type: AccountType) =>
    PL_ACCOUNTS.filter((a) => a.type === type)
      // Overhead accounts only appear once something has been spent on them.
      .filter((a) => type !== 'expense' || f.some((x) => (x.byAccount.get(a.code) ?? 0) !== 0))
      .map((a): ReportRow => ({
        label: a.name,
        kind: 'line',
        account: a.code,
        values: vals((x) => x.byAccount.get(a.code) ?? 0),
      }));
  return {
    title: 'Profit and Loss',
    subtitle: colLabel(r),
    columns: [...periods.map(colLabel), ...(withVar ? ['Change'] : [])],
    rows: [
      { label: 'Income', kind: 'section', values: [] },
      ...rowsFor('revenue'),
      { label: 'Total income', kind: 'subtotal', values: vals((x) => x.income) },
      { label: 'Less cost of sales', kind: 'section', values: [] },
      ...rowsFor('direct_cost'),
      { label: 'Total cost of sales', kind: 'subtotal', values: vals((x) => x.costOfSales) },
      { label: 'Gross profit', kind: 'total', values: vals((x) => x.grossProfit) },
      { label: 'Less operating expenses', kind: 'section', values: [] },
      ...rowsFor('expense'),
      { label: 'Total operating expenses', kind: 'subtotal', values: vals((x) => x.expenses) },
      { label: 'Net profit', kind: 'total', values: vals((x) => x.netProfit) },
    ],
    notes: [
      'Income is invoiced work (accrual basis) less credit notes. Cost of sales is supplier bills; items bought for home are drawings, not costs. Operating expenses are the overheads and wages entered under Expenses.',
    ],
  };
}

/* ---------------------------- balance sheet --------------------------- */

export interface BSFigures {
  bank: number;
  receivables: number;
  payables: number;
  tax: number;
  assets: number;
  liabilities: number;
  netAssets: number;
  opening: number;
  drawings: number;
  retained: number;
  currentYear: number;
  equity: number;
}
export function bsFigures(ps: Posting[], asAt: string, yearStart: string): BSFigures {
  const bal = balances(ps, upTo(asAt));
  const g = (c: string) => bal.get(c) ?? 0;
  const bank = g('090');
  const receivables = g('610');
  const payables = -g('800');
  const tax = -g('820');
  const fyStart = presetRange('year_to_date', asAt, yearStart).from;
  const currentYear = plFigures(ps, { from: fyStart, to: asAt }).netProfit;
  const retained = plFigures(ps, { from: '0000-01-01', to: addDays(fyStart, -1) }).netProfit;
  const opening = -g('970');
  const drawings = -g('880');
  const assets = bank + receivables;
  const liabilities = payables + tax;
  return {
    bank,
    receivables,
    payables,
    tax,
    assets,
    liabilities,
    netAssets: assets - liabilities,
    opening,
    drawings,
    retained,
    currentYear,
    equity: opening + drawings + retained + currentYear,
  };
}

export function balanceSheet(
  b: BooksInput,
  asAt: string,
  yearStart = '01-01',
  compareAsAt: string[] = [],
): ReportTable {
  const ps = postings(b);
  const dates = [asAt, ...compareAsAt];
  const f = dates.map((d) => bsFigures(ps, d, yearStart));
  const v = (pick: (x: BSFigures) => number) => f.map(pick);
  return {
    title: 'Balance Sheet',
    subtitle: `As at ${fmtShort(asAt)}`,
    columns: dates.map(fmtShort),
    rows: [
      { label: 'Assets', kind: 'section', values: [] },
      { label: 'Business bank account', kind: 'line', account: '090', values: v((x) => x.bank) },
      {
        label: 'Accounts receivable',
        kind: 'line',
        account: '610',
        values: v((x) => x.receivables),
      },
      { label: 'Total assets', kind: 'subtotal', values: v((x) => x.assets) },
      { label: 'Liabilities', kind: 'section', values: [] },
      { label: 'Accounts payable', kind: 'line', account: '800', values: v((x) => x.payables) },
      { label: 'GST / VAT', kind: 'line', account: '820', values: v((x) => x.tax) },
      { label: 'Total liabilities', kind: 'subtotal', values: v((x) => x.liabilities) },
      { label: 'Net assets', kind: 'total', values: v((x) => x.netAssets) },
      { label: 'Equity', kind: 'section', values: [] },
      { label: 'Opening balance', kind: 'line', account: '970', values: v((x) => x.opening) },
      { label: "Owner's drawings", kind: 'line', account: '880', values: v((x) => x.drawings) },
      { label: 'Retained earnings', kind: 'line', values: v((x) => x.retained) },
      { label: 'Current year earnings', kind: 'line', values: v((x) => x.currentYear) },
      { label: 'Total equity', kind: 'total', values: v((x) => x.equity) },
    ],
    notes: [
      'The bank balance is the opening balance plus payments recorded in the app; a bank feed would replace it later.',
      'Equipment, loans and stock on hand are not recorded in the app yet.',
    ],
  };
}

/* --------------------------- aged balances --------------------------- */

export const AGE_BUCKETS = [
  'Current',
  '1 to 30 days',
  '31 to 60 days',
  '61 to 90 days',
  'Over 90 days',
] as const;
/** Bucket by days past due (not yet due, or no due date, is Current). */
export function ageBucket(dueDate: string | null, asAt: string) {
  if (!dueDate) return 0;
  const late = daysBetween(dueDate, asAt);
  if (late <= 0) return 0;
  if (late <= 30) return 1;
  if (late <= 60) return 2;
  if (late <= 90) return 3;
  return 4;
}

export interface OpenItem {
  id: string;
  contactId: string;
  contact: string;
  reference: string;
  date: string;
  dueDate: string | null;
  totalPence: number;
  /** Still owed at the date. */
  duePence: number;
  daysOverdue: number;
}
/**
 * Invoices with something still owed at the date (payments and credit notes on or before it).
 * A customer credit not yet used is a negative item (the business owes the customer).
 */
export function openInvoices(b: BooksInput, asAt: string): OpenItem[] {
  const settled = new Map<string, number>();
  for (const p of b.payments)
    if (p.date <= asAt) settled.set(p.invoiceId, (settled.get(p.invoiceId) ?? 0) + p.amountPence);
  for (const c of b.credits)
    if (c.date <= asAt) settled.set(c.invoiceId, (settled.get(c.invoiceId) ?? 0) + c.amountPence);
  // A customer credit used on an invoice: less owed on the invoice, less credit left.
  for (const u of b.creditUses ?? [])
    if (u.date <= asAt) {
      settled.set(u.invoiceId, (settled.get(u.invoiceId) ?? 0) + u.amountPence);
      settled.set(u.creditId, (settled.get(u.creditId) ?? 0) - u.amountPence);
    }
  return b.invoices
    .filter((i) => i.issueDate <= asAt)
    .map((i) => ({
      id: i.id,
      contactId: i.customerId,
      contact: i.customerName,
      reference: i.number ?? 'Invoice',
      date: i.issueDate,
      dueDate: i.dueDate,
      totalPence: i.totalPence,
      duePence: i.totalPence - (settled.get(i.id) ?? 0),
      daysOverdue: i.dueDate ? Math.max(0, daysBetween(i.dueDate, asAt)) : 0,
    }))
    .filter((x) => x.duePence !== 0)
    .sort((a, z) => z.daysOverdue - a.daysOverdue || (a.date < z.date ? -1 : 1));
}
/** Supplier bills not yet paid at the date (a supplier credit note is a negative item). */
export function openBills(b: BooksInput, asAt: string): OpenItem[] {
  const paid = new Map<string, number>();
  for (const p of b.billPayments)
    if (p.date <= asAt) paid.set(p.billId, (paid.get(p.billId) ?? 0) + p.amountPence);
  return b.bills
    .filter((x) => x.date <= asAt)
    .map((x) => {
      const total = x.kind === 'credit_note' ? -x.totalPence : x.totalPence;
      return {
        id: x.id,
        contactId: x.supplierId,
        contact: x.supplierName,
        reference: x.reference,
        date: x.date,
        dueDate: x.dueDate,
        totalPence: total,
        duePence: total - (paid.get(x.id) ?? 0),
        daysOverdue: x.dueDate ? Math.max(0, daysBetween(x.dueDate, asAt)) : 0,
      };
    })
    .filter((x) => x.duePence !== 0)
    .sort((a, z) => z.daysOverdue - a.daysOverdue || (a.date < z.date ? -1 : 1));
}

export function aged(b: BooksInput, which: 'receivables' | 'payables', asAt: string): ReportTable {
  const items = which === 'receivables' ? openInvoices(b, asAt) : openBills(b, asAt);
  const by = new Map<string, { name: string; v: number[] }>();
  for (const i of items) {
    const row = by.get(i.contactId) ?? { name: i.contact, v: [0, 0, 0, 0, 0] };
    row.v[ageBucket(i.dueDate, asAt)]! += i.duePence;
    by.set(i.contactId, row);
  }
  const rows = [...by.values()]
    .map((r) => ({ ...r, total: r.v.reduce((s, x) => s + x, 0) }))
    .sort((a, z) => z.total - a.total || a.name.localeCompare(z.name));
  const totals = [0, 1, 2, 3, 4].map((k) => rows.reduce((s, r) => s + r.v[k]!, 0));
  return {
    title: which === 'receivables' ? 'Aged Receivables' : 'Aged Payables',
    subtitle: `As at ${fmtShort(asAt)}, by days past the due date`,
    columns: [...AGE_BUCKETS, 'Total'],
    rows: [
      ...rows.map((r): ReportRow => ({ label: r.name, kind: 'line', values: [...r.v, r.total] })),
      { label: 'Total', kind: 'total', values: [...totals, totals.reduce((s, x) => s + x, 0)] },
      ...(rows.length
        ? []
        : [
            {
              label:
                which === 'receivables'
                  ? 'Nobody owes you anything.'
                  : 'You owe nothing to suppliers.',
              kind: 'note' as const,
              values: [],
            },
          ]),
    ],
    notes:
      which === 'payables'
        ? [
            'A bill counts as owed until a payment is recorded against it (Bills › bill › Record Payment).',
          ]
        : [],
  };
}

/* ------------------------------ cash flow ----------------------------- */

export interface MonthFlow {
  month: string;
  inPence: number;
  outPence: number;
  /** Money out split: supplier bills, wages, and other expenses (they add up to outPence). */
  outSuppliersPence: number;
  outWagesPence: number;
  outExpensesPence: number;
  netPence: number;
  closingPence: number;
}
/** Months (YYYY-MM) covering a range. */
export function monthsIn(r: DateRange): string[] {
  const out: string[] = [];
  let m = r.from.slice(0, 7);
  const end = r.to.slice(0, 7);
  while (m <= end && out.length < 240) {
    out.push(m);
    m = addMonths(`${m}-01`, 1).slice(0, 7);
  }
  return out;
}
/** Money in and out of the bank by month, with the balance at each month's end. */
export function monthlyCash(b: BooksInput, r: DateRange): { opening: number; months: MonthFlow[] } {
  const ps = postings(b).filter((p) => p.account === '090');
  const opening = ps.filter((p) => p.date < r.from).reduce((s, p) => s + p.pence, 0);
  let bal = opening;
  const months = monthsIn(r).map((m) => {
    const inMonth = ps.filter(
      (p) => p.date.startsWith(m) && inRange(p.date, r) && p.source !== 'opening',
    );
    const opened = ps
      .filter((p) => p.date.startsWith(m) && inRange(p.date, r) && p.source === 'opening')
      .reduce((s, p) => s + p.pence, 0);
    const inP = inMonth.filter((p) => p.pence > 0).reduce((s, p) => s + p.pence, 0);
    const outs = inMonth.filter((p) => p.pence < 0);
    const outP = outs.reduce((s, p) => s - p.pence, 0);
    const outOf = (f: (p: Posting) => boolean) => outs.filter(f).reduce((s, p) => s - p.pence, 0);
    const wages = new Set(
      (b.expenses ?? []).filter((e) => e.account === WAGES_ACCOUNT).map((e) => e.id),
    );
    const outWages = outOf((p) => p.source === 'expense' && wages.has(p.sourceId));
    const outExpenses = outOf((p) => p.source === 'expense') - outWages;
    bal += opened + inP - outP;
    return {
      month: m,
      inPence: inP,
      outPence: outP,
      outSuppliersPence: outP - outWages - outExpenses,
      outWagesPence: outWages,
      outExpensesPence: outExpenses,
      netPence: inP - outP,
      closingPence: bal,
    };
  });
  return { opening, months };
}

export function cashFlow(b: BooksInput, r: DateRange): ReportTable {
  const { opening, months } = monthlyCash(b, r);
  const sum = (f: (m: MonthFlow) => number) => months.reduce((s, m) => s + f(m), 0);
  const ps = postings(b).filter((p) => p.account === '090' && inRange(p.date, r));
  const openingIn = ps.filter((p) => p.source === 'opening').reduce((s, p) => s + p.pence, 0);
  const closing = months.length ? months[months.length - 1]!.closingPence : opening;
  const many = months.length > 1 && months.length <= 12;
  const v = (f: (m: MonthFlow) => number, total: number) =>
    many ? [...months.map(f), total] : [total];
  const opens = many
    ? [...months.map((_, i) => (i === 0 ? opening : months[i - 1]!.closingPence)), opening]
    : [opening];
  return {
    title: 'Cash Flow',
    subtitle: colLabel(r),
    columns: many ? [...months.map((m) => monthLabel(m.month)), 'Total'] : [colLabel(r)],
    rows: [
      { label: 'Opening bank balance', kind: 'subtotal', values: opens },
      ...(openingIn
        ? [
            {
              label: 'Opening balance entered',
              kind: 'line' as const,
              values: v((m) => (m.month === r.from.slice(0, 7) ? openingIn : 0), openingIn),
            },
          ]
        : []),
      { label: 'Money in', kind: 'section', values: [] },
      {
        label: 'Received from customers',
        kind: 'line',
        account: '610',
        values: v(
          (m) => m.inPence,
          sum((m) => m.inPence),
        ),
      },
      { label: 'Money out', kind: 'section', values: [] },
      {
        label: 'Paid to suppliers',
        kind: 'line',
        account: '800',
        values: v(
          (m) => m.outSuppliersPence,
          sum((m) => m.outSuppliersPence),
        ),
      },
      ...(sum((m) => m.outWagesPence)
        ? [
            {
              label: 'Wages',
              kind: 'line' as const,
              account: WAGES_ACCOUNT,
              values: v(
                (m) => m.outWagesPence,
                sum((m) => m.outWagesPence),
              ),
            },
          ]
        : []),
      ...(sum((m) => m.outExpensesPence)
        ? [
            {
              label: 'Expenses',
              kind: 'line' as const,
              values: v(
                (m) => m.outExpensesPence,
                sum((m) => m.outExpensesPence),
              ),
            },
          ]
        : []),
      {
        label: 'Net cash movement',
        kind: 'subtotal',
        values: v(
          (m) => m.netPence,
          sum((m) => m.netPence),
        ),
      },
      {
        label: 'Closing bank balance',
        kind: 'total',
        values: many ? [...months.map((m) => m.closingPence), closing] : [closing],
      },
    ],
    notes: [
      'Cash basis: only money actually received or paid (recorded payments), unlike the Profit and Loss.',
    ],
  };
}

/* ------------------------------ tax summary --------------------------- */

export function taxSummary(b: BooksInput, r: DateRange): ReportTable {
  const ps = postings(b).filter((p) => p.account === '820' && inRange(p.date, r));
  const sales = postings(b).filter(
    (p) => (p.account === '200' || p.account === '210') && inRange(p.date, r),
  );
  const outInv = -ps.filter((p) => p.source === 'invoice').reduce((s, p) => s + p.pence, 0);
  const outCn = ps.filter((p) => p.source === 'credit_note').reduce((s, p) => s + p.pence, 0);
  const net = -sales.reduce((s, p) => s + p.pence, 0);
  return {
    title: 'Tax Summary',
    subtitle: colLabel(r),
    columns: ['Amount'],
    rows: [
      { label: 'Sales (net of credit notes, ex tax)', kind: 'line', values: [net] },
      { label: 'Tax charged on invoices', kind: 'line', values: [outInv] },
      { label: 'Less tax on credit notes', kind: 'line', values: [outCn] },
      { label: 'Tax collected', kind: 'total', values: [outInv - outCn] },
    ],
    notes: [
      outInv === 0
        ? 'No GST or VAT has been charged in this period (Guernsey and Sark have no VAT; GST is planned but not yet in force).'
        : 'Tax shown is what was charged on invoices. Supplier bills are recorded gross, so tax paid to suppliers is not reclaimed here.',
    ],
  };
}

/* ---------------------------- budget vs actual ------------------------- */

export function budgetFor(b: BooksInput, account: string, r: DateRange) {
  const months = new Set(monthsIn(r));
  return b.budgets
    .filter((x) => x.account === account && months.has(x.month))
    .reduce((s, x) => s + x.amountPence, 0);
}

export function budgetVsActual(b: BooksInput, r: DateRange): ReportTable {
  const ps = postings(b);
  const f = plFigures(ps, r);
  const lines = PL_ACCOUNTS.map((a) => {
    const actual = f.byAccount.get(a.code) ?? 0;
    const budget = budgetFor(b, a.code, r);
    // A good variance is more income or less cost than planned.
    const variance = a.type === 'revenue' ? actual - budget : budget - actual;
    return {
      a,
      actual,
      budget,
      variance,
      pct: budget ? Math.round((variance * 10000) / Math.abs(budget)) : null,
    };
  });
  const tot = (types: AccountType[]) => {
    const xs = lines.filter((l) => types.includes(l.a.type));
    return {
      actual: xs.reduce((s, l) => s + l.actual, 0),
      budget: xs.reduce((s, l) => s + l.budget, 0),
    };
  };
  const inc = tot(['revenue']);
  const cost = tot(['direct_cost', 'expense']);
  const np = { actual: inc.actual - cost.actual, budget: inc.budget - cost.budget };
  const row = (
    label: string,
    kind: ReportRow['kind'],
    actual: number,
    budget: number,
    account?: string,
    good: 1 | -1 = 1,
  ): ReportRow => {
    const variance = good * (actual - budget);
    return {
      label,
      kind,
      account,
      values: [
        actual,
        budget,
        variance,
        budget ? Math.round((variance * 10000) / Math.abs(budget)) : null,
      ],
    };
  };
  const any = b.budgets.length > 0;
  return {
    title: 'Budget vs Actual',
    subtitle: colLabel(r),
    columns: ['Actual', 'Budget', 'Variance', 'Variance'],
    formats: ['money', 'money', 'money', 'percent'],
    rows: [
      { label: 'Income', kind: 'section', values: [] },
      ...lines
        .filter((l) => l.a.type === 'revenue')
        .map((l) => row(l.a.name, 'line', l.actual, l.budget, l.a.code)),
      row('Total income', 'subtotal', inc.actual, inc.budget),
      { label: 'Costs', kind: 'section', values: [] },
      ...lines
        .filter((l) => l.a.type !== 'revenue')
        .map((l) => row(l.a.name, 'line', l.actual, l.budget, l.a.code, -1)),
      row('Total costs', 'subtotal', cost.actual, cost.budget, undefined, -1),
      row('Net profit', 'total', np.actual, np.budget),
    ],
    notes: [
      any
        ? 'A positive variance is good: more income, or less cost, than planned.'
        : 'No budget set yet. Use Edit Budget to set monthly figures.',
    ],
  };
}

/* --------------------------- account transactions ---------------------- */

export function accountTransactions(b: BooksInput, code: string, r: DateRange): ReportTable {
  const a = accountByCode(code);
  const all = postings(b).filter((p) => p.account === code);
  const pl = isPL(code);
  // Profit and Loss accounts start each period at zero; balance sheet accounts carry forward.
  const opening = pl ? 0 : all.filter((p) => p.date < r.from).reduce((s, p) => s + p.pence, 0);
  let bal = opening;
  const nat = (v: number) => natural(code, v);
  const rows: ReportRow[] = [
    {
      label: 'Opening balance',
      kind: 'subtotal',
      text: ['', '', ''],
      values: [null, null, nat(opening)],
    },
  ];
  let dr = 0;
  let cr = 0;
  for (const p of all.filter((x) => inRange(x.date, r))) {
    bal += p.pence;
    if (p.pence > 0) dr += p.pence;
    else cr -= p.pence;
    rows.push({
      label: p.description,
      kind: 'line',
      text: [fmtShort(p.date), p.reference, p.contact],
      values: [p.pence > 0 ? p.pence : null, p.pence < 0 ? -p.pence : null, nat(bal)],
    });
  }
  rows.push({
    label: 'Closing balance',
    kind: 'total',
    text: ['', '', ''],
    values: [dr, cr, nat(bal)],
  });
  return {
    title: `Account Transactions: ${a ? `${a.code} ${a.name}` : code}`,
    subtitle: colLabel(r),
    textColumns: ['Date', 'Reference', 'Contact'],
    columns: ['Debit', 'Credit', 'Balance'],
    rows,
  };
}

/* ------------------------------ overview ------------------------------ */

export interface OverviewDto {
  today: string;
  year: DateRange;
  bankPence: number;
  hasOpening: boolean;
  owedToYou: {
    /** Net of customer credits not yet used, so it matches Accounts receivable. */
    totalPence: number;
    overduePence: number;
    /** Items with something owed (customer credits aren't counted). */
    count: number;
    overdueCount: number;
    buckets: number[];
    /** Customer credits not yet used (what the business owes customers), as a positive amount. */
    creditPence: number;
  };
  youOwe: {
    totalPence: number;
    overduePence: number;
    count: number;
    overdueCount: number;
    buckets: number[];
  };
  /** Last 12 months, oldest first. */
  cash: MonthFlow[];
  /** This month and the year so far, with last year's same period for comparison. */
  profit: { month: PLFigures; year: PLFigures; lastYear: PLFigures };
  unpaidInvoices: OpenItem[];
  unpaidBills: OpenItem[];
  pipeline: PipelineStage[];
  openQuotes: { count: number; valuePence: number };
}

export function overview(d: BusinessDto): OverviewDto {
  const ps = postings(d);
  const today = d.today;
  const ytd = presetRange('year_to_date', today, d.yearStart);
  const recv = openInvoices(d, today);
  const pay = openBills(d, today);
  const summary = (xs: OpenItem[]) => {
    const buckets = [0, 0, 0, 0, 0];
    for (const x of xs) buckets[ageBucket(x.dueDate, today)]! += x.duePence;
    const over = xs.filter((x) => x.daysOverdue > 0);
    return {
      totalPence: xs.reduce((s, x) => s + x.duePence, 0),
      overduePence: over.reduce((s, x) => s + x.duePence, 0),
      count: xs.filter((x) => x.duePence > 0).length,
      overdueCount: over.filter((x) => x.duePence > 0).length,
      buckets,
    };
  };
  const credits = recv.filter((x) => x.duePence < 0).reduce((s, x) => s - x.duePence, 0);
  const monthStart = `${today.slice(0, 7)}-01`;
  const from12 = addMonths(monthStart, -11);
  return {
    today,
    year: ytd,
    bankPence: balances(ps, upTo(today)).get('090') ?? 0,
    hasOpening: !!d.opening,
    owedToYou: { ...summary(recv), creditPence: credits },
    youOwe: summary(pay),
    cash: monthlyCash(d, { from: from12, to: today }).months,
    profit: {
      month: plFigures(ps, { from: monthStart, to: today }),
      year: plFigures(ps, ytd),
      lastYear: plFigures(ps, compareRange(ytd, 'last_year')),
    },
    unpaidInvoices: recv,
    unpaidBills: pay,
    pipeline: d.pipeline,
    openQuotes: d.openQuotes,
  };
}

/* ------------------------------ writes ------------------------------ */

const ymd = z.iso.date();
export const openingBalanceUpdate = z.object({
  date: ymd,
  /** Pence; may be negative (overdrawn). */
  bankPence: z.number().int().min(-100_000_000_00).max(100_000_000_00),
});
export type OpeningBalanceUpdate = z.infer<typeof openingBalanceUpdate>;

export const budgetUpdate = z.object({
  year: z.number().int().min(2000).max(2100),
  /** First month of the 12, MM (the business's year start month). */
  startMonth: z.number().int().min(1).max(12).default(1),
  lines: z
    .array(
      z.object({
        account: z.enum(PL_ACCOUNTS.map((a) => a.code) as [string, ...string[]]),
        months: z.array(z.number().int().min(0).max(100_000_000_00)).length(12),
      }),
    )
    .max(PL_ACCOUNTS.length),
});
export type BudgetUpdate = z.input<typeof budgetUpdate>;
/** The 12 YYYY-MM months a budget year covers. */
export const budgetMonths = (year: number, startMonth = 1) =>
  Array.from({ length: 12 }, (_, i) => addMonths(`${year}-${pad2(startMonth)}-01`, i).slice(0, 7));

export const billPaymentCreate = z.object({
  amountPence: z.number().int().positive().max(100_000_000_00),
  paidOn: ymd,
  method: z.enum(['bank_transfer', 'cash', 'card', 'cheque', 'other']),
  reference: z.string().trim().max(200).optional(),
});
export type BillPaymentCreate = z.infer<typeof billPaymentCreate>;
export interface BillPaymentDto {
  id: string;
  amountPence: number;
  paidOn: string;
  method: string;
  reference: string | null;
  createdAt: string;
}

/* ------------------------------ expenses ------------------------------ */

export const expenseCreate = z
  .object({
    date: ymd,
    payee: z.string().trim().min(1, 'Who was it paid to?').max(200),
    account: z.enum(EXPENSE_ACCOUNT_CODES),
    description: z.string().trim().max(500).default(''),
    amountPence: z.number().int().positive('Enter the amount').max(100_000_000_00),
    taxPence: z.number().int().min(0).max(100_000_000_00).default(0),
    /** For wages: the team member paid (optional). */
    memberUserId: z.uuid().nullish(),
  })
  .refine((e) => e.taxPence <= e.amountPence, {
    message: 'Tax can’t be more than the amount',
    path: ['taxPence'],
  });
export type ExpenseCreate = z.input<typeof expenseCreate>;
export const expenseQuery = z.object({ from: ymd.optional(), to: ymd.optional() });
export interface ExpenseDto extends LedgerExpense {
  memberUserId: string | null;
  createdAt: string;
}
/** Expenses by account for a range, biggest first (the Expenses screen's summary). */
export function expenseTotals(
  expenses: readonly LedgerExpense[],
  r: DateRange,
): { account: ExpenseAccountCode; name: string; netPence: number }[] {
  const m = new Map<ExpenseAccountCode, number>();
  for (const e of expenses)
    if (e.date >= r.from && e.date <= r.to)
      m.set(e.account, (m.get(e.account) ?? 0) + e.amountPence - e.taxPence);
  return [...m.entries()]
    .map(([account, netPence]) => ({ account, name: accountByCode(account)!.name, netPence }))
    .sort((a, z) => z.netPence - a.netPence);
}
