/**
 * Deterministic readers for merchant PDFs Joe gets: CEF and DOCI invoices, and CI Lighting
 * statements. Each reader works on positioned text lines (see ./text), checks its own
 * arithmetic, and says what does not add up rather than guessing. Anything else comes back
 * as "unknown" with its text, for the AI helper to draft (and the owner to check).
 */
import { parseQty, type Pence } from '../money';
import type { Cell, Line, PageText } from './text';
import { pagesToText } from './text';

export type ReadLine = {
  qtyMilli: number;
  code: string | null;
  description: string;
  /** "each", "Pack"… as printed. */
  unit: string | null;
  /** List price per unit before any discount. */
  unitPricePence: Pence;
  /** Basis points: 35% = 3500. */
  discountBp: number;
  totalPence: Pence;
  /** DOCI prints the recommended retail price. */
  rrpPence: Pence | null;
};

export type ReadBill = {
  parser: 'cef' | 'doci' | 'ai';
  supplier: string;
  supplierLegalName: string;
  kind: 'bill' | 'credit_note';
  reference: string;
  billDate: string | null;
  dueDate: string | null;
  /** How the due date was found: printed, or worked out from printed terms. */
  dueDateNote: string | null;
  orderNumber: string | null;
  yourReference: string | null;
  accountRef: string | null;
  lines: ReadLine[];
  goodsPence: Pence | null;
  vatPence: Pence | null;
  totalPence: Pence | null;
  linesSumPence: Pence;
  /** Lines add up to the goods total and goods + VAT to the total, and each line checks out. */
  adds: boolean;
  problems: string[];
  pages: number[];
};

export const STATEMENT_TYPES = ['INV', 'CRN', 'CAS', 'DIS'] as const;
export type StatementType = (typeof STATEMENT_TYPES)[number];

export type StatementRow = {
  date: string;
  type: StatementType;
  reference: string;
  yourReference: string | null;
  amountPence: Pence;
  /** "*" settled, "S" outstanding, nothing printed. */
  flag: 'settled' | 'outstanding' | null;
  balancePence: Pence;
  /** This row's balance = previous balance ± amount. */
  chainOk: boolean;
};

export type ReadStatement = {
  parser: 'cilighting';
  supplier: string;
  supplierLegalName: string;
  account: string | null;
  date: string | null;
  rows: StatementRow[];
  closingPence: Pence;
  chainOk: boolean;
  problems: string[];
};

export type PdfRead =
  | { kind: 'bills'; bills: ReadBill[] }
  | { kind: 'statement'; statement: ReadStatement }
  | { kind: 'unknown'; text: string };

/* -------------------------------- helpers -------------------------------- */

/** "1,234.56", "£26.25", "-3.10" → pence, without floating point. */
export function parsePence(input: string): Pence | null {
  const m = /^\s*(-)?£?\s*(-)?(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})\s*$/.exec(input);
  if (!m) return null;
  const v = Number(m[3]!.replace(/,/g, '')) * 100 + Number(m[4]);
  return m[1] || m[2] ? -v : v;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "07 Nov 2026", "07/11/2026", "30/10/26" → "2026-11-07". */
export function parseDate(input: string): string | null {
  const s = input.trim();
  let d: number, m: number, y: number;
  let r = /^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})$/.exec(s);
  if (r) {
    d = Number(r[1]);
    m = MONTHS.indexOf(r[2]!.toLowerCase()) + 1;
    y = Number(r[3]);
  } else if ((r = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s))) {
    d = Number(r[1]);
    m = Number(r[2]);
    y = Number(r[3]!.length === 2 ? `20${r[3]}` : r[3]);
  } else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (m < 1 || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  const dt = new Date(`${iso}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** First capture of `re` on any line. */
function find(lines: Line[], re: RegExp): string | null {
  for (const l of lines) {
    const m = re.exec(l.text);
    if (m) return (m[1] ?? '').trim() || null;
  }
  return null;
}

type Column = { key: string; x0: number; x1: number };

/** The header column a cell belongs to: most overlap, else nearest. */
function columnOf(cell: Cell, cols: Column[]): string | null {
  let best: string | null = null;
  let bestScore = -Infinity;
  for (const c of cols) {
    const overlap = Math.min(cell.x1, c.x1) - Math.max(cell.x0, c.x0);
    const score = overlap > 0 ? overlap : -Math.abs((cell.x0 + cell.x1) / 2 - (c.x0 + c.x1) / 2);
    if (score > bestScore) {
      bestScore = score;
      best = c.key;
    }
  }
  return best;
}

function columns(header: Line, keys: [RegExp, string][]): Column[] {
  const out: Column[] = [];
  for (const cell of header.cells) {
    const hit = keys.find(([re]) => re.test(cell.text));
    if (hit) out.push({ key: hit[1], x0: cell.x0, x1: cell.x1 });
  }
  return out;
}

function byColumn(line: Line, cols: Column[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const cell of line.cells) {
    const k = columnOf(cell, cols);
    if (k) out[k] = out[k] ? `${out[k]} ${cell.text}` : cell.text;
  }
  return out;
}

/** qty × price less discount, rounded half up to the penny (how merchants print it). */
export function expectedLineTotal(qtyMilli: number, unitPence: Pence, discountBp: number): Pence {
  const gross = qtyMilli * unitPence * (10000 - discountBp); // pence × 1000 × 10000
  return Math.floor((gross + 5_000_000) / 10_000_000);
}

const money = (p: Pence) => `£${(p / 100).toFixed(2)}`;

/** Checks a bill's arithmetic and fills in its problems. Used by every reader, AI included. */
export function finishReadBill(
  bill: Omit<ReadBill, 'linesSumPence' | 'adds' | 'problems'>,
  extra: string[] = [],
): ReadBill {
  const problems = [...extra];
  bill.lines.forEach((l, i) => {
    const want = expectedLineTotal(l.qtyMilli, l.unitPricePence, l.discountBp);
    if (want !== l.totalPence)
      problems.push(
        `Line ${i + 1} (${l.code ?? l.description}): qty × price gives ${money(want)} but the line says ${money(l.totalPence)}`,
      );
  });
  const linesSumPence = bill.lines.reduce((t, l) => t + l.totalPence, 0);
  const goods = bill.goodsPence ?? (bill.vatPence == null ? bill.totalPence : null);
  if (!bill.lines.length) problems.push('No lines found');
  if (goods == null) problems.push('No total found');
  else if (goods !== linesSumPence)
    problems.push(`Lines add up to ${money(linesSumPence)} but the goods total is ${money(goods)}`);
  if (bill.goodsPence != null && bill.vatPence != null && bill.totalPence != null)
    if (bill.goodsPence + bill.vatPence !== bill.totalPence)
      problems.push(
        `Goods ${money(bill.goodsPence)} + VAT ${money(bill.vatPence)} is not the total ${money(bill.totalPence)}`,
      );
  if (!bill.billDate) problems.push('No invoice date found');
  return { ...bill, linesSumPence, adds: problems.length === 0, problems };
}

/** Pages that carry the same invoice number become one bill (an invoice may run over pages). */
function groupPages(pages: PageText[], refOf: (p: PageText) => string | null) {
  const groups: { ref: string | null; pages: PageText[] }[] = [];
  for (const p of pages) {
    const ref = refOf(p);
    const last = groups[groups.length - 1];
    if (last && (ref === null || ref === last.ref)) last.pages.push(p);
    else groups.push({ ref, pages: [p] });
  }
  return groups;
}

/* ---------------------------------- CEF ---------------------------------- */

const isCef = (text: string) => /C\.E\.F\.|City Electrical Factors/.test(text);

function readCef(pages: PageText[]): ReadBill[] {
  const ref = (p: PageText) =>
    find(p.lines, /Invoice:\s*(\S+)/) ?? find(p.lines, /Credit Note:\s*(\S+)/);
  return groupPages(pages, ref).map(({ pages: group }) => {
    const all = group.flatMap((p) => p.lines);
    const reference = ref(group[0]!) ?? '';
    const credit = all.some((l) => /CREDIT NOTE/i.test(l.text));
    const billDate = parseDate(find(all, /Tax Point Date:\s*(\d{1,2} [A-Za-z]{3} \d{4})/) ?? '');
    const lines: ReadLine[] = [];
    const extra: string[] = [];
    for (const p of group) {
      const hi = p.lines.findIndex(
        (l) => /^Qty\b/.test(l.cells[0]?.text ?? '') && /Description/.test(l.text),
      );
      if (hi < 0) continue;
      const cols = columns(p.lines[hi]!, [
        [/^Qty$/, 'qty'],
        [/^Item$/, 'item'],
        [/^Description$/, 'desc'],
        [/Price/, 'price'],
        [/^Per$/, 'per'],
        [/^Discount$/, 'disc'],
        [/Goods$/, 'goods'],
      ]);
      for (const l of p.lines.slice(hi + 1)) {
        if (/Goods Total:|Carried Forward|Continued/i.test(l.text)) break;
        const c = byColumn(l, cols);
        const qty = c.qty && /^-?\d+(\.\d+)?$/.test(c.qty) ? parseQty(c.qty) : null;
        const last = lines[lines.length - 1];
        if (qty != null) {
          lines.push({
            qtyMilli: qty,
            code: c.item ?? null,
            description: c.desc ?? '',
            unit: null,
            unitPricePence: 0,
            discountBp: 0,
            totalPence: 0,
            rrpPence: null,
          });
        } else if (last && c.desc) last.description += ` ${c.desc}`;
        else if (!last || !(c.price || c.goods)) continue;
        const target = lines[lines.length - 1]!;
        if (c.price) {
          const [price, ...unit] = c.price.split(' ');
          const pp = parsePence(price ?? '');
          if (pp == null) extra.push(`Could not read the price "${c.price}"`);
          else target.unitPricePence = pp;
          if (unit.length) target.unit = unit.join(' ');
        }
        if (c.per) target.unit = c.per;
        if (c.disc) target.discountBp = Math.round(Number(c.disc.replace('%', '')) * 100) || 0;
        if (c.goods) {
          const g = parsePence(c.goods);
          if (g == null) extra.push(`Could not read the line total "${c.goods}"`);
          else target.totalPence = g;
        }
      }
    }
    for (const l of lines) l.description = l.description.replace(/\s+-$/, '').trim();
    const pence = (re: RegExp) => {
      const v = find(all, re);
      return v == null ? null : parsePence(v);
    };
    // CEF prints settlement terms ("Settlement thirty days") rather than a due date.
    const thirty = all.some((l) => /Settlement thirty days/i.test(l.text));
    return finishReadBill(
      {
        parser: 'cef',
        supplier: 'CEF',
        supplierLegalName: 'C.E.F. (Guernsey) Limited',
        kind: credit ? 'credit_note' : 'bill',
        reference,
        billDate,
        dueDate: billDate && thirty ? addDays(billDate, 30) : null,
        dueDateNote: thirty ? 'Worked out from "Settlement thirty days" on the invoice' : null,
        orderNumber: find(all, /Order Number:\s*(.+?)(?:\s{2,}|$)/),
        yourReference: null,
        accountRef: find(all, /Account Code:\s*(\S+)/),
        lines,
        goodsPence: pence(/Goods Total:\s*(-?£?[\d,]+\.\d{2})/),
        vatPence: pence(/VAT Total:\s*(-?£?[\d,]+\.\d{2})/),
        totalPence: pence(/(?:^|\s{2})Total:\s*(-?£?[\d,]+\.\d{2})\s*$/),
        pages: group.map((p) => p.number),
      },
      extra,
    );
  });
}

/* ---------------------------------- DOCI --------------------------------- */

const isDoci = (text: string) => /Duquemin\s*&\s*Ozanne|D&O Channel Islands/.test(text);

function dociHeader(p: PageText): Record<string, string> | null {
  const hi = p.lines.findIndex((l) => /Invoice Date/.test(l.text) && /Invoice No/.test(l.text));
  const values = p.lines[hi + 1];
  if (hi < 0 || !values) return null;
  const cols = columns(p.lines[hi]!, [
    [/^Account$/, 'account'],
    [/^Invoice Date$/, 'date'],
    [/^Invoice No$/, 'number'],
    [/^Credit No$/, 'number'],
    [/^Order No$/, 'order'],
    [/^User$/, 'user'],
    [/^Your Reference$/, 'yourRef'],
  ]);
  return byColumn(values, cols);
}

function readDoci(pages: PageText[]): ReadBill[] {
  return groupPages(pages, (p) => dociHeader(p)?.number ?? null).map(({ pages: group }) => {
    const all = group.flatMap((p) => p.lines);
    const head = dociHeader(group[0]!) ?? {};
    const lines: ReadLine[] = [];
    const extra: string[] = [];
    for (const p of group) {
      const hi = p.lines.findIndex(
        (l) => /^Code$/.test(l.cells[0]?.text ?? '') && /Quantity/.test(l.text),
      );
      if (hi < 0) continue;
      const cols = columns(p.lines[hi]!, [
        [/^Code$/, 'code'],
        [/^Description$/, 'desc'],
        [/^Quantity$/, 'qty'],
        [/^RRP$/, 'rrp'],
        [/^Price$/, 'price'],
        [/^Value$/, 'value'],
      ]);
      for (const l of p.lines.slice(hi + 1)) {
        if (/Goods Collected|Total Invoice Value|Total Credit Value|Carried Forward/i.test(l.text))
          break;
        const c = byColumn(l, cols);
        const qty = c.qty ? parseQty(c.qty) : null;
        const price = c.price ? parsePence(c.price) : null;
        const value = c.value ? parsePence(c.value) : null;
        if (qty != null && price != null && value != null) {
          lines.push({
            qtyMilli: qty,
            code: c.code ?? null,
            description: c.desc ?? '',
            unit: null,
            unitPricePence: price,
            discountBp: 0,
            totalPence: value,
            rrpPence: c.rrp ? parsePence(c.rrp) : null,
          });
        } else if (lines.length && c.desc && !c.qty)
          lines[lines.length - 1]!.description += ` ${c.desc}`;
        else if (c.qty || c.value) extra.push(`Could not read the line "${l.text}"`);
      }
    }
    const total = find(all, /Total (?:Invoice|Credit) Value £?\s*(-?[\d,]+\.\d{2})/);
    const due = find(all, /Date Payable\s+(\d{2}\/\d{2}\/\d{4})/);
    const credit = all.some(
      (l) => /C\s?R\s?E\s?D\s?I\s?T/.test(l.text) && /N\s?O\s?T\s?E/.test(l.text),
    );
    return finishReadBill(
      {
        parser: 'doci',
        supplier: 'DOCI',
        supplierLegalName: 'Duquemin & Ozanne CI Ltd',
        kind: credit ? 'credit_note' : 'bill',
        reference: head.number ?? '',
        billDate: parseDate(head.date ?? ''),
        dueDate: due ? parseDate(due) : null,
        dueDateNote: due ? 'Printed as "Date Payable"' : null,
        orderNumber: head.order ?? null,
        yourReference: head.yourRef ?? null,
        accountRef: head.account ?? null,
        lines,
        goodsPence: null,
        vatPence: null,
        totalPence: total ? parsePence(total) : null,
        pages: group.map((p) => p.number),
      },
      extra,
    );
  });
}

/* ------------------------------ CI Lighting ------------------------------ */

const isCiLightingStatement = (text: string) => /CI Lighting/i.test(text) && /STATEMENT/.test(text);
const DATE = /^\d{2}\/\d{2}\/\d{2,4}$/;

function readCiLighting(pages: PageText[]): ReadStatement {
  const rows: StatementRow[] = [];
  const problems: string[] = [];
  let account: string | null = null;
  let date: string | null = null;
  for (const p of pages) {
    for (const l of p.lines) {
      // Each printed row is repeated on the remittance slip to the right: keep the cells
      // before the second date only.
      const words = l.cells.flatMap((c) => c.text.split(' '));
      const firstDate = words.findIndex((w) => DATE.test(w));
      if (firstDate !== 0 || !STATEMENT_TYPES.includes(words[1] as StatementType)) {
        // Header: the account number above the statement date, left of the slip.
        for (const c of l.cells.filter((c) => c.x1 < p.width / 2)) {
          if (!account && /^\d{2,8}$/.test(c.text)) account = c.text;
          else if (account && !date && DATE.test(c.text)) date = parseDate(c.text);
        }
        continue;
      }
      const secondDate = words.findIndex((w, i) => i > 0 && DATE.test(w));
      const left = secondDate > 0 ? words.slice(0, secondDate) : words;
      const [d, type, reference, ...rest] = left;
      const balance = parsePence(rest.pop() ?? '');
      let flag: StatementRow['flag'] = null;
      if (rest[rest.length - 1] === '*' || rest[rest.length - 1] === 'S')
        flag = rest.pop() === '*' ? 'settled' : 'outstanding';
      const amount = parsePence(rest.pop() ?? '');
      if (balance == null || amount == null || !reference) {
        problems.push(`Could not read the row "${left.join(' ')}"`);
        continue;
      }
      const prev = rows.length ? rows[rows.length - 1]!.balancePence : 0;
      const sign = type === 'INV' ? 1 : -1;
      const chainOk = prev + sign * amount === balance;
      if (!chainOk)
        problems.push(
          `${type} ${reference}: ${money(prev)} ${sign > 0 ? '+' : '−'} ${money(amount)} should be ${money(prev + sign * amount)}, the statement says ${money(balance)}`,
        );
      rows.push({
        date: parseDate(d!) ?? d!,
        type: type as StatementType,
        reference,
        yourReference: rest.join(' ') || null,
        amountPence: amount,
        flag,
        balancePence: balance,
        chainOk,
      });
    }
  }
  if (!rows.length) problems.push('No statement rows found');
  return {
    parser: 'cilighting',
    supplier: 'CI Lighting',
    supplierLegalName: 'CI Lighting Ltd',
    account,
    date,
    rows,
    closingPence: rows.length ? rows[rows.length - 1]!.balancePence : 0,
    chainOk: problems.length === 0,
    problems,
  };
}

/* --------------------------------- entry --------------------------------- */

/** Reads extracted pages with the matching merchant reader. */
export function readPdfPages(pages: PageText[]): PdfRead {
  const text = pagesToText(pages);
  if (isCiLightingStatement(text)) return { kind: 'statement', statement: readCiLighting(pages) };
  if (isCef(text)) return { kind: 'bills', bills: readCef(pages) };
  if (isDoci(text)) return { kind: 'bills', bills: readDoci(pages) };
  return { kind: 'unknown', text };
}
