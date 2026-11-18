/**
 * Demo bank statements: the same import and matching as the server (apps/api/src/services/bank.ts),
 * kept in the browser. Candidates come from the demo's own books (payments, bill payments, expenses).
 */
import {
  BANK_MATCH_DAYS,
  accountByCode,
  bankImportCreate,
  bankLineExpense,
  bankLinePayment,
  bankLineBillPayment,
  type BillPaymentDto,
  type InvoiceDetailDto,
  bankLineStatus,
  bankMatch,
  formatPence,
  parseBankCsv,
  suggestMatches,
  type BankImportResultDto,
  type BankMatchCandidate,
  type BankMatchKind,
  type BankTransactionDto,
  type BankTxStatus,
  type BusinessDto,
  type ExpenseDto,
} from '@lse/shared';
import type { BusinessCtx } from './mockBusiness';

export interface DemoBankLine {
  id: string;
  date: string;
  description: string;
  reference: string;
  amountPence: number;
  balancePence: number | null;
  fingerprint: string;
  status: BankTxStatus;
  matchKind: BankMatchKind | null;
  matchId: string | null;
  importedAt: string;
}

const shift = (d: string, days: number) =>
  new Date(Date.parse(`${d}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

function candidatesFrom(books: BusinessDto, from: string, to: string): BankMatchCandidate[] {
  const lo = shift(from, -BANK_MATCH_DAYS);
  const hi = shift(to, BANK_MATCH_DAYS);
  const inRange = (d: string) => d >= lo && d <= hi;
  const inv = new Map(books.invoices.map((i) => [i.id, i]));
  const bill = new Map(books.bills.map((b) => [b.id, b]));
  const words = (...w: (string | null | undefined)[]) =>
    w.filter((x): x is string => !!x && x.trim() !== '');
  return [
    ...books.payments
      .filter((p) => p.method !== 'cash' && inRange(p.date))
      .map((p) => {
        const i = inv.get(p.invoiceId);
        return {
          kind: 'payment' as const,
          id: p.id,
          date: p.date,
          amountPence: p.amountPence,
          label: `Payment from ${i?.customerName ?? 'a customer'}${i?.number ? ` for ${i.number}` : ''}`,
          words: words(i?.number, i?.customerName, p.reference),
        };
      }),
    ...books.billPayments
      .filter((p) => p.method !== 'cash' && inRange(p.date))
      .map((p) => {
        const b = bill.get(p.billId);
        return {
          kind: 'bill_payment' as const,
          id: p.id,
          date: p.date,
          amountPence: -p.amountPence,
          label: `Paid ${b?.supplierName ?? 'a supplier'} for bill ${b?.reference ?? ''}`.trim(),
          words: words(b?.supplierName, b?.reference, p.reference),
        };
      }),
    ...(books.expenses ?? [])
      .filter((e) => inRange(e.date))
      .map((e) => ({
        kind: 'expense' as const,
        id: e.id,
        date: e.date,
        amountPence: -e.amountPence,
        label: `${e.payee} · ${accountByCode(e.account)?.name ?? 'Expense'}`,
        words: words(e.payee, e.description),
      })),
  ];
}

export function bankRoute(
  c: BusinessCtx & {
    books: () => BusinessDto;
    addExpense: (input: unknown) => ExpenseDto;
    db: { bank?: DemoBankLine[] };
  },
  method: string,
  seg: string[],
  query: URLSearchParams | undefined,
  body: unknown,
): unknown {
  const [, what, id, sub] = seg;
  const lines = (c.db.bank ??= []);
  if (method === 'POST' && what === 'imports') {
    const input = c.parse(bankImportCreate, body);
    const parsed = parseBankCsv(input.csv);
    if (!parsed.rows.length)
      c.fail(
        422,
        'bank_csv_unreadable',
        parsed.problems[0]?.line === 0
          ? parsed.problems[0].message
          : 'No transactions could be read from this file.',
      );
    const future = parsed.rows.find((r) => r.date > c.today);
    if (future)
      c.fail(
        422,
        'bank_csv_future',
        `Line ${future.line} is dated ${future.date}, which is in the future. Is this the right file?`,
      );
    const have = new Set(lines.map((l) => l.fingerprint));
    let added = 0;
    for (const r of parsed.rows) {
      if (have.has(r.fingerprint)) continue;
      have.add(r.fingerprint);
      lines.push({
        id: c.uid(),
        date: r.date,
        description: r.description,
        reference: r.reference,
        amountPence: r.amountPence,
        balancePence: r.balancePence,
        fingerprint: r.fingerprint,
        status: 'unmatched',
        matchKind: null,
        matchId: null,
        importedAt: c.now(),
      });
      added++;
    }
    const dates = parsed.rows.map((r) => r.date).sort();
    const out: BankImportResultDto = {
      importId: c.uid(),
      added,
      alreadyImported: parsed.rows.length - added,
      problems: parsed.problems.slice(0, 50),
      columns: parsed.columns,
      from: dates[0]!,
      to: dates[dates.length - 1]!,
    };
    return out;
  }
  if (method === 'GET' && what === 'transactions' && !id) {
    const status = query?.get('status') ?? 'unmatched';
    const rows = lines
      .filter((l) => status === 'all' || l.status === status)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const dates = rows.map((r) => r.date).sort();
    const all = rows.length ? candidatesFrom(c.books(), dates[0]!, dates[dates.length - 1]!) : [];
    const key = (k: string, x: string) => `${k}:${x}`;
    const byKey = new Map(all.map((x) => [key(x.kind, x.id), x]));
    const taken = new Set(
      lines.filter((l) => l.matchKind).map((l) => key(l.matchKind!, l.matchId!)),
    );
    const free = all.filter((x) => !taken.has(key(x.kind, x.id)));
    return rows.map((l): BankTransactionDto => ({
      id: l.id,
      date: l.date,
      description: l.description,
      reference: l.reference,
      amountPence: l.amountPence,
      balancePence: l.balancePence,
      status: l.status,
      importedAt: l.importedAt,
      suggestions: l.status === 'unmatched' ? suggestMatches(l, free) : [],
      matchedTo: l.matchKind
        ? {
            kind: l.matchKind,
            id: l.matchId!,
            label: byKey.get(key(l.matchKind, l.matchId!))?.label ?? 'Recorded in the app',
          }
        : null,
    }));
  }
  const line = lines.find((l) => l.id === id);
  if (what === 'transactions' && id && !line) c.fail(404, 'not_found', 'Bank line not found');
  if (method === 'POST' && sub === 'match' && line) {
    const to = c.parse(bankMatch, body);
    if (line.status === 'matched')
      c.fail(409, 'already_matched', 'This bank line is already matched.');
    const found = candidatesFrom(c.books(), line.date, line.date).find(
      (x) => x.kind === to.kind && x.id === to.id,
    );
    if (!found) c.fail(404, 'not_found', 'Payment or expense not found');
    if (found.amountPence !== line.amountPence)
      c.fail(
        422,
        'amount_differs',
        `The amounts differ: the bank says ${formatPence(line.amountPence)}, the app ${formatPence(found.amountPence)}.`,
      );
    if (lines.some((l) => l.matchKind === to.kind && l.matchId === to.id))
      c.fail(409, 'taken', 'That is already matched to another bank line.');
    Object.assign(line, { status: 'matched', matchKind: to.kind, matchId: to.id });
    return null;
  }
  if (method === 'POST' && sub === 'expense' && line) {
    const input = c.parse(bankLineExpense, body);
    if (line.status !== 'unmatched')
      c.fail(409, 'already_matched', 'This bank line is already matched or ignored.');
    if (line.amountPence >= 0) c.fail(422, 'money_in', 'Only money going out can be an expense.');
    const e = c.addExpense({ ...input, date: line.date, amountPence: -line.amountPence });
    Object.assign(line, { status: 'matched', matchKind: 'expense', matchId: e.id });
    return e;
  }
  if (method === 'POST' && sub === 'payment' && line) {
    const { invoiceId } = c.parse(bankLinePayment, body);
    if (line.status !== 'unmatched')
      c.fail(409, 'already_matched', 'This bank line is already matched or ignored.');
    if (line.amountPence <= 0)
      c.fail(422, 'money_out', 'Only money coming in can be a customer’s payment.');
    const inv = c.call('POST', `/invoices/${invoiceId}/payments`, {
      amountPence: line.amountPence,
      paidOn: line.date,
      method: 'bank_transfer',
      reference: line.description.slice(0, 200) || null,
    }) as InvoiceDetailDto & { jobCompleted: boolean };
    const paymentId = inv.payments[inv.payments.length - 1]!.id;
    Object.assign(line, { status: 'matched', matchKind: 'payment', matchId: paymentId });
    return { invoiceId, paymentId, jobCompleted: inv.jobCompleted };
  }
  if (method === 'POST' && sub === 'bill-payment' && line) {
    const { billId } = c.parse(bankLineBillPayment, body);
    if (line.status !== 'unmatched')
      c.fail(409, 'already_matched', 'This bank line is already matched or ignored.');
    if (line.amountPence >= 0)
      c.fail(422, 'money_in', 'Only money going out can pay a supplier bill.');
    const pays = c.call('POST', `/supplier-bills/${billId}/payments`, {
      amountPence: -line.amountPence,
      paidOn: line.date,
      method: 'bank_transfer',
      reference: line.description.slice(0, 200) || undefined,
    }) as BillPaymentDto[];
    const paymentId = [...pays].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1)!.id;
    Object.assign(line, { status: 'matched', matchKind: 'bill_payment', matchId: paymentId });
    return { billId, paymentId };
  }
  if (method === 'PUT' && sub === 'status' && line) {
    const { status } = c.parse(bankLineStatus, body);
    if (status === 'ignored' && line.status === 'matched')
      c.fail(409, 'already_matched', 'Unmatch it first.');
    Object.assign(line, { status, matchKind: null, matchId: null });
    return null;
  }
  return undefined;
}
