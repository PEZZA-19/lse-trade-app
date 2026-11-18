/**
 * Bank statements: import a CSV, then match each line to what the app already recorded (a customer
 * payment, a supplier bill payment, an expense). Importing and matching never change the books;
 * they check them against the real bank. Anyone with Accounts access (the API's access check for
 * /api/bank) can do it, as with expenses (Joe, 18 Nov 2026).
 */
import {
  BANK_MATCH_DAYS,
  accountByCode,
  formatPence,
  parseBankCsv,
  suggestMatches,
  type BankImportResultDto,
  type BankMatchCandidate,
  type BankMatchKind,
  type BankTransactionDto,
  type BankTxStatus,
  type ExpenseDto,
} from '@lse/shared';
import type { Tx } from '../db/client';
import { AppError, conflict, notFound } from '../lib/errors';
import { iso, type Auth } from '../lib/types';
import { audit } from './audit';
import { recordPayment, today } from './invoices';
import { createExpense } from './expenses';

export async function importStatement(
  tx: Tx,
  auth: Auth,
  input: { fileName: string; csv: string },
): Promise<BankImportResultDto> {
  const parsed = parseBankCsv(input.csv);
  if (!parsed.rows.length)
    throw new AppError(
      422,
      'bank_csv_unreadable',
      parsed.problems[0]?.line === 0
        ? parsed.problems[0].message
        : 'No transactions could be read from this file.',
      { problems: parsed.problems.slice(0, 20) },
    );
  const t = await today(tx);
  const future = parsed.rows.find((r) => r.date > t);
  if (future)
    throw new AppError(
      422,
      'bank_csv_future',
      `Line ${future.line} is dated ${future.date}, which is in the future. Is this the right file?`,
    );
  const dates = parsed.rows.map((r) => r.date).sort();
  const from = dates[0]!;
  const to = dates[dates.length - 1]!;
  const [imp] = await tx<{ id: string }[]>`
    INSERT INTO bank_imports (tenant_id, file_name, rows_added, rows_existing, from_date, to_date, created_by)
    VALUES (${auth.tenantId}, ${input.fileName}, 0, 0, ${from}, ${to}, ${auth.userId})
    RETURNING id`;
  const id = imp!.id;
  let added = 0;
  // Batches keep each statement well under Postgres's parameter limit.
  for (let i = 0; i < parsed.rows.length; i += 500) {
    const batch = parsed.rows.slice(i, i + 500).map((r) => ({
      tenant_id: auth.tenantId,
      import_id: id,
      posted_on: r.date,
      description: r.description,
      reference: r.reference,
      amount_pence: r.amountPence,
      balance_pence: r.balancePence,
      fingerprint: r.fingerprint,
    }));
    const ins = await tx`
      INSERT INTO bank_transactions ${tx(batch)}
      ON CONFLICT (tenant_id, fingerprint) DO NOTHING
      RETURNING id`;
    added += ins.length;
  }
  const existing = parsed.rows.length - added;
  await tx`UPDATE bank_imports SET rows_added = ${added}, rows_existing = ${existing} WHERE id = ${id}`;
  await audit(tx, auth, 'create', 'bank_import', id, {
    fileName: input.fileName,
    added,
    alreadyImported: existing,
    from,
    to,
  });
  return {
    importId: id,
    added,
    alreadyImported: existing,
    problems: parsed.problems.slice(0, 50),
    columns: parsed.columns,
    from,
    to,
  };
}

interface TxRow {
  id: string;
  date: string;
  description: string;
  reference: string;
  amountPence: string;
  balancePence: string | null;
  status: BankTxStatus;
  matchKind: BankMatchKind | null;
  matchId: string | null;
  createdAt: Date;
}

const shift = (d: string, days: number) =>
  new Date(Date.parse(`${d}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * What the app recorded that could be on the bank statement between two dates (with the matching
 * window either side). `onlyFree`: leave out ones already matched to a bank line.
 */
export async function candidates(
  tx: Tx,
  from: string,
  to: string,
  onlyFree = true,
): Promise<BankMatchCandidate[]> {
  const lo = shift(from, -BANK_MATCH_DAYS);
  const hi = shift(to, BANK_MATCH_DAYS);
  const free = (kind: BankMatchKind) => tx`
    AND (${!onlyFree} OR NOT EXISTS (
      SELECT 1 FROM bank_transactions b WHERE b.match_kind = ${kind} AND b.match_id = x.id))`;
  const pays = await tx<
    {
      id: string;
      date: string;
      amountPence: string;
      reference: string | null;
      number: string | null;
      customer: string;
    }[]
  >`
    SELECT x.id, x.paid_on::text AS date, x.amount_pence, x.reference, i.number, c.name AS customer
      FROM payments x JOIN invoices i ON i.id = x.invoice_id JOIN jobs j ON j.id = i.job_id
      JOIN customers c ON c.id = j.customer_id
     WHERE x.method <> 'cash' AND x.paid_on BETWEEN ${lo}::date AND ${hi}::date ${free('payment')}`;
  const bills = await tx<
    {
      id: string;
      date: string;
      amountPence: string;
      reference: string | null;
      billRef: string;
      supplier: string;
    }[]
  >`
    SELECT x.id, x.paid_on::text AS date, x.amount_pence, x.reference, b.reference AS bill_ref, s.name AS supplier
      FROM supplier_bill_payments x JOIN supplier_bills b ON b.id = x.bill_id
      JOIN suppliers s ON s.id = b.supplier_id
     WHERE x.method <> 'cash' AND x.paid_on BETWEEN ${lo}::date AND ${hi}::date ${free('bill_payment')}`;
  const exps = await tx<
    {
      id: string;
      date: string;
      amountPence: string;
      payee: string;
      description: string;
      account: string;
    }[]
  >`
    SELECT x.id, x.spent_on::text AS date, x.amount_pence, x.payee, x.description, x.account_code AS account
      FROM expenses x
     WHERE x.spent_on BETWEEN ${lo}::date AND ${hi}::date ${free('expense')}`;
  const words = (...w: (string | null)[]) => w.filter((x): x is string => !!x && x.trim() !== '');
  return [
    ...pays.map((p) => ({
      kind: 'payment' as const,
      id: p.id,
      date: p.date,
      amountPence: Number(p.amountPence),
      label: `Payment from ${p.customer}${p.number ? ` for ${p.number}` : ''}`,
      words: words(p.number, p.customer, p.reference),
    })),
    ...bills.map((b) => ({
      kind: 'bill_payment' as const,
      id: b.id,
      date: b.date,
      amountPence: -Number(b.amountPence),
      label: `Paid ${b.supplier} for bill ${b.billRef}`,
      words: words(b.supplier, b.billRef, b.reference),
    })),
    ...exps.map((e) => ({
      kind: 'expense' as const,
      id: e.id,
      date: e.date,
      amountPence: -Number(e.amountPence),
      label: `${e.payee} · ${accountByCode(e.account)?.name ?? 'Expense'}`,
      words: words(e.payee, e.description),
    })),
  ];
}

export async function listTransactions(
  tx: Tx,
  status: BankTxStatus | 'all',
): Promise<BankTransactionDto[]> {
  const rows = await tx<TxRow[]>`
    SELECT id, posted_on::text AS date, description, reference, amount_pence, balance_pence, status,
           match_kind, match_id, created_at
      FROM bank_transactions
     WHERE (${status} = 'all' OR status = ${status})
     ORDER BY posted_on DESC, created_at DESC, fingerprint
     LIMIT 2000`;
  const dates = rows.map((r) => r.date).sort();
  const all = rows.length ? await candidates(tx, dates[0]!, dates[dates.length - 1]!, false) : [];
  const key = (k: string, id: string) => `${k}:${id}`;
  const byKey = new Map(all.map((c) => [key(c.kind, c.id), c]));
  const taken = new Set(rows.filter((r) => r.matchKind).map((r) => key(r.matchKind!, r.matchId!)));
  // Matched elsewhere (outside this list) also counts as taken.
  const matchedAnywhere = await tx<{ k: string; id: string }[]>`
    SELECT match_kind AS k, match_id AS id FROM bank_transactions WHERE match_kind IS NOT NULL`;
  for (const m of matchedAnywhere) taken.add(key(m.k, m.id));
  const free = all.filter((c) => !taken.has(key(c.kind, c.id)));
  return rows.map((r) => {
    const amountPence = Number(r.amountPence);
    const c = r.matchKind ? byKey.get(key(r.matchKind, r.matchId!)) : undefined;
    return {
      id: r.id,
      date: r.date,
      description: r.description,
      reference: r.reference,
      amountPence,
      balancePence: r.balancePence === null ? null : Number(r.balancePence),
      status: r.status,
      importedAt: iso(r.createdAt)!,
      suggestions: r.status === 'unmatched' ? suggestMatches({ ...r, amountPence }, free) : [],
      matchedTo: r.matchKind
        ? { kind: r.matchKind, id: r.matchId!, label: c?.label ?? 'Recorded in the app' }
        : null,
    };
  });
}

async function lockLine(tx: Tx, id: string) {
  const [r] = await tx<
    { id: string; date: string; description: string; amountPence: string; status: BankTxStatus }[]
  >`
    SELECT id, posted_on::text AS date, description, amount_pence, status FROM bank_transactions WHERE id = ${id} FOR UPDATE`;
  if (!r) throw notFound('Bank line');
  return { ...r, amountPence: Number(r.amountPence) };
}

/** Ties a bank line to a payment, bill payment or expense with the same amount. */
export async function matchLine(
  tx: Tx,
  auth: Auth,
  id: string,
  to: { kind: BankMatchKind; id: string },
): Promise<void> {
  const line = await lockLine(tx, id);
  if (line.status === 'matched')
    throw conflict('already_matched', 'This bank line is already matched.');
  const found = (await candidates(tx, line.date, line.date, false)).find(
    (c) => c.kind === to.kind && c.id === to.id,
  );
  if (!found) throw notFound('Payment or expense');
  if (found.amountPence !== line.amountPence)
    throw new AppError(
      422,
      'amount_differs',
      `The amounts differ: the bank says ${formatPence(line.amountPence)}, the app ${formatPence(found.amountPence)}.`,
    );
  try {
    await tx`UPDATE bank_transactions SET status = 'matched', match_kind = ${to.kind}, match_id = ${to.id},
                    matched_by = ${auth.userId}, matched_at = now() WHERE id = ${id}`;
  } catch (e) {
    if ((e as { code?: string }).code === '23505')
      throw conflict('taken', 'That is already matched to another bank line.');
    throw e;
  }
  await audit(tx, auth, 'bank_match', 'bank_transaction', id, { ...to });
}

/** Unmatch, ignore (e.g. a transfer between your own accounts), or bring an ignored line back. */
export async function setLineStatus(
  tx: Tx,
  auth: Auth,
  id: string,
  status: 'unmatched' | 'ignored',
): Promise<void> {
  const line = await lockLine(tx, id);
  if (status === 'ignored' && line.status === 'matched')
    throw conflict('already_matched', 'Unmatch it first.');
  await tx`UPDATE bank_transactions SET status = ${status}, match_kind = NULL, match_id = NULL,
                  matched_by = NULL, matched_at = NULL WHERE id = ${id}`;
  await audit(
    tx,
    auth,
    status === 'ignored' ? 'bank_ignore' : 'bank_unmatch',
    'bank_transaction',
    id,
    {
      was: line.status,
    },
  );
}

/** Records a money-out bank line as an expense (same date and amount) and matches it, in one go. */
export async function expenseFromLine(
  tx: Tx,
  auth: Auth,
  id: string,
  input: {
    account: ExpenseDto['account'];
    payee: string;
    description: string;
    taxPence: number;
    memberUserId?: string | null;
  },
): Promise<ExpenseDto> {
  const line = await lockLine(tx, id);
  if (line.status !== 'unmatched')
    throw conflict('already_matched', 'This bank line is already matched or ignored.');
  if (line.amountPence >= 0)
    throw new AppError(422, 'money_in', 'Only money going out can be an expense.');
  const amountPence = -line.amountPence;
  if (input.taxPence > amountPence)
    throw new AppError(422, 'validation_failed', 'The tax can’t be more than the amount.', {
      fields: { taxPence: 'More than the amount' },
    });
  const e = await createExpense(tx, auth, { ...input, date: line.date, amountPence });
  await matchLine(tx, auth, id, { kind: 'expense', id: e.id });
  return e;
}

/**
 * Record a customer payment straight from a money-in line (bank transfer, the line's date and
 * amount, the bank's description as the reference) and match the line to it, in one step.
 * Recording a payment is the owner's decision, as on the invoice.
 */
export async function paymentFromLine(
  tx: Tx,
  auth: Auth,
  id: string,
  input: { invoiceId: string },
): Promise<{ invoiceId: string; paymentId: string; jobCompleted: boolean }> {
  const line = await lockLine(tx, id);
  if (line.status !== 'unmatched')
    throw conflict('already_matched', 'This bank line is already matched or ignored.');
  if (line.amountPence <= 0)
    throw new AppError(422, 'money_out', 'Only money coming in can be a customer’s payment.');
  const inv = await recordPayment(tx, auth, input.invoiceId, {
    amountPence: line.amountPence,
    paidOn: line.date,
    method: 'bank_transfer',
    reference: line.description.slice(0, 200) || null,
  });
  const [p] = await tx<{ id: string }[]>`
    SELECT id FROM payments WHERE invoice_id = ${input.invoiceId} AND recorded_by = ${auth.userId}
    ORDER BY created_at DESC LIMIT 1`;
  await matchLine(tx, auth, id, { kind: 'payment', id: p!.id });
  return { invoiceId: input.invoiceId, paymentId: p!.id, jobCompleted: inv.jobCompleted };
}
