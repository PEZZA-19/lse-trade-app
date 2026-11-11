/**
 * Supplier statement reconciliation: each invoice and credit on the statement against the
 * bills held in the app. Read-only: it lists what is missing or different; Joe decides what
 * to do (enter the missing bill, query the supplier).
 */
import type { Pence } from '../money';
import type { ReadStatement, StatementRow } from './parse';

export type HeldBill = {
  id: string;
  kind: 'bill' | 'credit_note';
  reference: string;
  billDate: string;
  totalPence: Pence;
  status: 'draft' | 'applied';
};

export type ReconRow = StatementRow & {
  match: 'matched' | 'amount_differs' | 'missing' | 'payment';
  bill: HeldBill | null;
  /** Statement amount minus the app's total, when they differ. */
  differencePence: Pence | null;
};

export type Reconciliation = {
  rows: ReconRow[];
  /** Bills in the app dated within the statement period that the statement doesn't list. */
  notOnStatement: HeldBill[];
  closingPence: Pence;
  /** Sum of outstanding (S) invoices less outstanding credits. */
  outstandingPence: Pence;
  counts: { matched: number; amountDiffers: number; missing: number };
};

/** "32058:1", "INV 32058", "32058" all compare equal; so do "C3042:1" and "C3042". */
export const normaliseRef = (ref: string) =>
  ref
    .toUpperCase()
    .replace(/^(INV|CRN|CN)\s*/, '')
    .replace(/:\d+$/, '')
    .replace(/[^A-Z0-9]/g, '');

export function reconcileStatement(s: ReadStatement, bills: HeldBill[]): Reconciliation {
  const byRef = new Map<string, HeldBill>();
  for (const b of bills) byRef.set(`${b.kind}:${normaliseRef(b.reference)}`, b);
  const used = new Set<string>();
  const rows: ReconRow[] = s.rows.map((r) => {
    if (r.type === 'CAS' || r.type === 'DIS')
      return { ...r, match: 'payment', bill: null, differencePence: null };
    const kind = r.type === 'CRN' ? 'credit_note' : 'bill';
    const bill = byRef.get(`${kind}:${normaliseRef(r.reference)}`) ?? null;
    if (!bill) return { ...r, match: 'missing', bill: null, differencePence: null };
    used.add(bill.id);
    return bill.totalPence === r.amountPence
      ? { ...r, match: 'matched', bill, differencePence: null }
      : { ...r, match: 'amount_differs', bill, differencePence: r.amountPence - bill.totalPence };
  });
  const dates = s.rows.map((r) => r.date).sort();
  const from = dates[0] ?? '';
  const to = s.date ?? dates[dates.length - 1] ?? '';
  const notOnStatement = bills.filter(
    (b) => !used.has(b.id) && b.billDate >= from && b.billDate <= to,
  );
  const outstandingPence = s.rows
    .filter((r) => r.flag === 'outstanding')
    .reduce((t, r) => t + (r.type === 'INV' ? r.amountPence : -r.amountPence), 0);
  return {
    rows,
    notOnStatement,
    closingPence: s.closingPence,
    outstandingPence,
    counts: {
      matched: rows.filter((r) => r.match === 'matched').length,
      amountDiffers: rows.filter((r) => r.match === 'amount_differs').length,
      missing: rows.filter((r) => r.match === 'missing').length,
    },
  };
}
