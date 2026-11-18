/**
 * Bank statement import (session 6): reads the CSV a UK bank lets you download (Lloyds, Barclays,
 * HSBC, NatWest, Santander, Starling, Monzo, Nationwide and most others) into plain transactions:
 * date, description, signed amount in pence (money in > 0, money out < 0), and the balance if given.
 *
 * Rules:
 * - Money is parsed from the text, never through floating point.
 * - UK dates are day first (18/11/2026). ISO dates (2026-11-18) and "18 Nov 2026" work too.
 * - Columns are found by their headings; a file with no headings is read as date, description,
 *   amount (the HSBC download).
 * - Each row gets a fingerprint (date, amount, description, and how many identical rows came before
 *   it in the file), so importing the same or an overlapping statement twice adds nothing twice,
 *   while two identical coffees on one day both stay.
 */
import { z } from 'zod';
import { EXPENSE_ACCOUNT_CODES, balances, postings, type BooksInput } from './ledger';

export interface BankCsvRow {
  /** Line in the file, from 1, for messages. */
  line: number;
  date: string;
  description: string;
  reference: string;
  /** Money in > 0, money out < 0. Never 0. */
  amountPence: number;
  balancePence: number | null;
  fingerprint: string;
}

export interface BankCsvProblem {
  line: number;
  message: string;
}

export interface BankCsvResult {
  rows: BankCsvRow[];
  problems: BankCsvProblem[];
  /** How the columns were read, in words, e.g. "Date, Description, Paid in / Paid out, Balance". */
  columns: string;
}

export const BANK_CSV_MAX_ROWS = 5000;
export const BANK_CSV_MAX_BYTES = 2_000_000;

/** Splits CSV text into rows of cells (quoted cells, "" inside quotes, CRLF/LF, a BOM). */
export function splitCsv(text: string): string[][] {
  const s = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function validDate(y: number, m: number, d: number): string | null {
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1) return null;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > days) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** A bank date to YYYY-MM-DD, or null. Day first, as UK banks write them. */
export function parseBankDate(raw: string): string | null {
  const t = raw.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(t);
  if (m) return validDate(+m[1]!, +m[2]!, +m[3]!);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?: .*)?$/.exec(t);
  if (m) {
    const y = m[3]!.length === 2 ? 2000 + +m[3]! : +m[3]!;
    return validDate(y, +m[2]!, +m[1]!);
  }
  m = /^(\d{1,2})[ -]([A-Za-z]{3,9})[ -](\d{2}|\d{4})$/.exec(t);
  if (m) {
    const mon = MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase());
    if (mon < 0) return null;
    const y = m[3]!.length === 2 ? 2000 + +m[3]! : +m[3]!;
    return validDate(y, mon + 1, +m[1]!);
  }
  return null;
}

/**
 * A bank amount to signed pence, or null if it isn't one. Accepts £, GBP, thousands commas,
 * a leading - or +, (brackets) for negative, and a trailing CR (in) or DR (out). Empty is null.
 */
export function parseBankAmount(raw: string): number | null {
  let t = raw.trim().replace(/\s+/g, '');
  if (!t) return null;
  let sign = 1;
  const tail = /(CR|DR)$/i.exec(t);
  if (tail) {
    if (tail[1]!.toUpperCase() === 'DR') sign = -1;
    t = t.slice(0, -2);
  }
  if (/^\(.*\)$/.test(t)) {
    sign = -sign;
    t = t.slice(1, -1);
  }
  if (t.startsWith('-')) {
    sign = -sign;
    t = t.slice(1);
  } else if (t.startsWith('+')) t = t.slice(1);
  t = t.replace(/^(£|GBP)/i, '').replace(/(£|GBP)$/i, '');
  if (t.startsWith('-')) {
    sign = -sign;
    t = t.slice(1);
  }
  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/.test(t)) return null;
  t = t.replace(/,/g, '');
  const [whole, frac = ''] = t.split('.');
  const pence = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(pence) || pence > 100_000_000_000) return null;
  return sign * pence;
}

type Col = 'date' | 'description' | 'reference' | 'amount' | 'in' | 'out' | 'balance' | 'type';

const HEADINGS: [Col, RegExp][] = [
  ['date', /^(transaction |posting |posted |value )?date$/],
  ['in', /^(paid in|money in|credits?|credit amount|in|amount in|deposits?)( \(?(£|gbp)\)?)?$/],
  [
    'out',
    /^(paid out|money out|debits?|debit amount|out|amount out|withdrawals?)( \(?(£|gbp)\)?)?$/,
  ],
  ['amount', /^(amount|value|transaction amount)( \(?(£|gbp)\)?)?$/],
  ['balance', /^(running )?balance( \(?(£|gbp)\)?)?$/],
  ['reference', /^(reference|ref)$/],
  ['type', /^(transaction )?type$/],
  [
    'description',
    /^(transaction description|description|details|narrative|counter ?party|name|payee|memo|transaction details)$/,
  ],
];
// When more than one column could be the description, the earlier word here wins.
const DESC_RANK = [
  'transaction description',
  'description',
  'details',
  'transaction details',
  'narrative',
  'counter party',
  'counterparty',
  'name',
  'payee',
  'memo',
];

interface Layout {
  header: number;
  cols: Partial<Record<Col, number>>;
}

function findLayout(rows: string[][]): Layout | null {
  for (let r = 0; r < Math.min(rows.length, 20); r++) {
    const cols: Partial<Record<Col, number>> = {};
    let descRank = Infinity;
    rows[r]!.forEach((cell, i) => {
      const h = cell.trim().toLowerCase().replace(/\s+/g, ' ');
      for (const [col, re] of HEADINGS) {
        if (!re.test(h)) continue;
        if (col === 'description') {
          const rank = DESC_RANK.indexOf(h);
          if (rank < descRank) {
            descRank = rank;
            cols.description = i;
          }
        } else if (cols[col] === undefined) cols[col] = i;
        break;
      }
    });
    if (
      cols.date !== undefined &&
      (cols.amount !== undefined || cols.in !== undefined || cols.out !== undefined)
    )
      return { header: r, cols };
  }
  // No headings: date, description, amount[, balance] (HSBC's download).
  const first = rows.find((row) => row.some((c) => c.trim()));
  if (first && first.length >= 3 && parseBankDate(first[0]!) && parseBankAmount(first[2]!) !== null)
    return {
      header: -1,
      cols: { date: 0, description: 1, amount: 2, ...(first.length >= 4 ? { balance: 3 } : {}) },
    };
  return null;
}

const NAMES: Record<Col, string> = {
  date: 'Date',
  description: 'Description',
  reference: 'Reference',
  amount: 'Amount',
  in: 'Paid in',
  out: 'Paid out',
  balance: 'Balance',
  type: 'Type',
};

export const normaliseBankText = (s: string) => s.trim().replace(/\s+/g, ' ');

/** Reads a bank statement CSV. Never throws: anything it can't read is listed in `problems`. */
export function parseBankCsv(text: string): BankCsvResult {
  const rows = splitCsv(text);
  const layout = findLayout(rows);
  if (!layout)
    return {
      rows: [],
      problems: [
        {
          line: 0,
          message:
            'This doesn’t look like a bank statement CSV. It needs a Date column and an Amount (or Paid in / Paid out) column.',
        },
      ],
      columns: '',
    };
  const { cols } = layout;
  const columns = (Object.keys(NAMES) as Col[])
    .filter((c) => cols[c] !== undefined && c !== 'type')
    .map((c) => NAMES[c])
    .join(', ');
  const out: BankCsvRow[] = [];
  const problems: BankCsvProblem[] = [];
  const seen = new Map<string, number>();
  const cell = (row: string[], c: Col) => (cols[c] === undefined ? '' : (row[cols[c]!] ?? ''));
  for (let r = layout.header + 1; r < rows.length; r++) {
    const row = rows[r]!;
    const line = r + 1;
    if (!row.some((c) => c.trim())) continue;
    if (out.length >= BANK_CSV_MAX_ROWS) {
      problems.push({
        line,
        message: `Only the first ${BANK_CSV_MAX_ROWS} transactions are read.`,
      });
      break;
    }
    const date = parseBankDate(cell(row, 'date'));
    if (!date) {
      problems.push({ line, message: `No date we can read (“${cell(row, 'date').trim()}”).` });
      continue;
    }
    let amount: number | null;
    if (cols.amount !== undefined) amount = parseBankAmount(cell(row, 'amount'));
    else {
      const inn = parseBankAmount(cell(row, 'in'));
      const outt = parseBankAmount(cell(row, 'out'));
      if (inn !== null && outt !== null && inn !== 0 && outt !== 0) amount = null;
      else amount = (inn ?? 0) !== 0 ? Math.abs(inn!) : outt !== null ? -Math.abs(outt) : inn;
    }
    if (amount === null) {
      problems.push({ line, message: 'No amount we can read.' });
      continue;
    }
    if (amount === 0) continue;
    const typ = normaliseBankText(cell(row, 'type'));
    let description = normaliseBankText(cell(row, 'description'));
    if (!description) description = typ || 'No description';
    description = description.slice(0, 300);
    const reference = normaliseBankText(cell(row, 'reference')).slice(0, 200);
    const balance = cols.balance !== undefined ? parseBankAmount(cell(row, 'balance')) : null;
    const key = `${date}|${amount}|${description.toLowerCase()}|${reference.toLowerCase()}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    out.push({
      line,
      date,
      description,
      reference,
      amountPence: amount,
      balancePence: balance,
      fingerprint: `${key}|${n}`,
    });
  }
  return { rows: out, problems, columns };
}

export const bankImportCreate = z.object({
  fileName: z.string().trim().min(1).max(200),
  csv: z.string().min(1).max(BANK_CSV_MAX_BYTES),
});

export interface BankImportResultDto {
  importId: string;
  added: number;
  alreadyImported: number;
  problems: BankCsvProblem[];
  columns: string;
  from: string | null;
  to: string | null;
}

export type BankTxStatus = 'unmatched' | 'matched' | 'ignored';

export interface BankTransactionDto {
  id: string;
  date: string;
  description: string;
  reference: string;
  amountPence: number;
  balancePence: number | null;
  status: BankTxStatus;
  importedAt: string;
  /** Unmatched lines: what it might be, best first. */
  suggestions: BankMatchSuggestion[];
  /** Matched lines: what it was matched to. */
  matchedTo: BankMatchedTo | null;
}

export const bankLineStatus = z.object({ status: z.enum(['unmatched', 'ignored']) });

export const bankTxQuery = z.object({
  status: z.enum(['unmatched', 'matched', 'ignored', 'all']).default('unmatched'),
});

/* -------------------------------- matching -------------------------------- */

export type BankMatchKind = 'payment' | 'bill_payment' | 'expense';

/** Something the app already recorded that a bank line could be. */
export interface BankMatchCandidate {
  kind: BankMatchKind;
  id: string;
  date: string;
  /** As the bank would show it: customer payments in (> 0), supplier payments and expenses out (< 0). */
  amountPence: number;
  /** "Payment for INV-0012 · Ann Example" */
  label: string;
  /** Words that may appear on the bank line: names, invoice and bill numbers, references. */
  words: string[];
}

export interface BankMatchSuggestion extends BankMatchCandidate {
  score: number;
  /** "Same amount · 2 days apart · mentions INV-0012" */
  reason: string;
  /** Sure enough to match in one tap (same amount, close date, and a name or number on the line). */
  strong: boolean;
}

/** Up to this many days between the bank date and the app's date. */
export const BANK_MATCH_DAYS = 10;

const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const dayNo = (d: string) =>
  Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86_400_000;

/** A word "appears" if its letters and digits appear in the bank line's (ignoring spaces, dashes). */
function hits(line: string, words: string[]): string[] {
  const hay = compact(line);
  const out: string[] = [];
  for (const w of words) {
    const c = compact(w);
    if (c.length < 3) continue;
    // Numbers like INV-0012: also look for the digits alone (banks often drop the letters).
    const digits = c.replace(/^[a-z]+/, '');
    if (hay.includes(c) || (digits.length >= 3 && /^\d+$/.test(digits) && hay.includes(digits)))
      out.push(w);
    else {
      // A name: any part of 4+ letters (e.g. the surname).
      const part = w
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .find((p) => p.length >= 4 && hay.includes(p));
      if (part) out.push(w);
    }
  }
  return out;
}

/**
 * The best matches for one bank line, best first. Only the same amount counts (in or out), within
 * BANK_MATCH_DAYS; closer dates and names or numbers on the line rank higher.
 */
export function suggestMatches(
  line: { date: string; amountPence: number; description: string; reference: string },
  candidates: BankMatchCandidate[],
  max = 3,
): BankMatchSuggestion[] {
  const text = `${line.description} ${line.reference}`;
  const out: BankMatchSuggestion[] = [];
  for (const c of candidates) {
    if (c.amountPence !== line.amountPence) continue;
    const days = Math.abs(dayNo(c.date) - dayNo(line.date));
    if (days > BANK_MATCH_DAYS) continue;
    const found = hits(text, c.words);
    const score = 50 - days * 3 + Math.min(found.length, 2) * 25;
    const when = days === 0 ? 'same day' : days === 1 ? '1 day apart' : `${days} days apart`;
    out.push({
      ...c,
      score,
      reason: ['Same amount', when, ...(found.length ? [`mentions ${found[0]}`] : [])].join(' · '),
      strong: found.length > 0 && days <= 5,
    });
  }
  return out.sort((a, b) => b.score - a.score || (a.date < b.date ? -1 : 1)).slice(0, max);
}

export const bankMatch = z.object({
  kind: z.enum(['payment', 'bill_payment', 'expense']),
  id: z.uuid(),
});

export interface BankMatchedTo {
  kind: BankMatchKind;
  id: string;
  label: string;
}

/** Money out on the bank that the app doesn't have yet: record it as an expense and match it. */
export const bankLineExpense = z.object({
  account: z.enum(EXPENSE_ACCOUNT_CODES),
  payee: z.string().trim().min(1, 'Who was it paid to?').max(200),
  description: z.string().trim().max(500).default(''),
  taxPence: z.number().int().min(0).max(100_000_000_00).default(0),
  memberUserId: z.uuid().nullish(),
});
export type BankLineExpense = z.input<typeof bankLineExpense>;

/** Money in on the bank → a customer's payment against one of their sent invoices. */
export const bankLinePayment = z.object({ invoiceId: z.string().uuid() });
export type BankLinePayment = z.input<typeof bankLinePayment>;

/* ----------------------------- reconciliation ----------------------------- */

/**
 * The bank's balance at the end of the latest day that has balances. Within a day banks list lines
 * newest-first or oldest-first, so the day's closing balance is the one no other line on that day
 * starts from (its balance before = balance − amount).
 */
export function closingBalance(
  lines: { date: string; amountPence: number; balancePence: number | null }[],
): { date: string; pence: number } | null {
  const withBal = lines.filter((l) => l.balancePence !== null);
  if (!withBal.length) return null;
  const last = withBal.reduce((d, l) => (l.date > d ? l.date : d), withBal[0]!.date);
  const day = withBal.filter((l) => l.date === last);
  const before = new Set(day.map((l) => l.balancePence! - l.amountPence));
  const closing = day.filter((l) => !before.has(l.balancePence!));
  // One clear end: use it. Otherwise (unusual), the line listed first in the file for that day.
  return { date: last, pence: (closing.length === 1 ? closing[0]! : day[0]!).balancePence! };
}

export interface BankReconciliation {
  date: string;
  bankPence: number;
  /** The app's Bank and Cash (account 090) at the end of that day. */
  appPence: number;
  differencePence: number;
}

/** Does the app's Bank and Cash agree with the bank's own balance on the statement's last day? */
export function reconcileBank(
  lines: { date: string; amountPence: number; balancePence: number | null }[],
  books: BooksInput,
): BankReconciliation | null {
  const close = closingBalance(lines);
  if (!close) return null;
  const appPence =
    balances(postings(books), { from: '0000-01-01', to: close.date }).get('090') ?? 0;
  return {
    date: close.date,
    bankPence: close.pence,
    appPence,
    differencePence: close.pence - appPence,
  };
}
