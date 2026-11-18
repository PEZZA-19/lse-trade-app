import {
  budgetMonths,
  type BillPaymentCreate,
  type BillPaymentDto,
  type BudgetUpdate,
  type BusinessDto,
  type OpeningBalanceUpdate,
} from '@lse/shared';
import type { Tx } from '../db/client';
import { AppError, notFound } from '../lib/errors';
import type { Auth } from '../lib/types';
import { audit } from './audit';
import { today } from './invoices';

const n = (v: unknown) => Number(v ?? 0);

/**
 * Everything the business overview and the Xero-style reports are worked out from (by the shared
 * ledger code). Only issued documents count: draft invoices, unapproved credit notes and bills not
 * yet applied are left out, exactly as on the Invoices and Bills screens.
 */
export async function getBusiness(tx: Tx): Promise<BusinessDto> {
  const t = await today(tx);
  const [settings] = await tx<{ yearStart: string; yearEffectiveFrom: string }[]>`
    SELECT year_start, year_effective_from::text FROM tenants WHERE id = app_current_tenant()`;
  const [opening] = await tx<{ date: string; bankPence: string }[]>`
    SELECT opening_date::text AS date, opening_bank_pence AS bank_pence FROM business_books`;
  const invoices = await tx<
    {
      id: string;
      number: string | null;
      customerId: string;
      customerName: string;
      jobNumber: string;
      issueDate: string;
      dueDate: string | null;
      labourNet: string;
      net: string;
      tax: string;
      total: string;
    }[]
  >`
    SELECT v.id, v.number, c.id AS customer_id, c.name AS customer_name, j.number AS job_number,
           v.issue_date::text AS issue_date, v.due_date::text AS due_date,
           (SELECT COALESCE(SUM(l.total_pence), 0) FROM invoice_lines l
             WHERE l.invoice_id = v.id AND l.kind = 'labour') AS labour_net,
           v.subtotal_pence AS net, v.tax_pence AS tax, v.total_pence AS total
      FROM invoices v
      JOIN jobs j ON j.id = v.job_id
      JOIN customers c ON c.id = j.customer_id
     WHERE v.status <> 'draft' AND v.issue_date IS NOT NULL
     ORDER BY v.issue_date, v.number`;
  const payments = await tx<
    {
      id: string;
      invoiceId: string;
      date: string;
      amountPence: string;
      method: string;
      reference: string | null;
    }[]
  >`
    SELECT p.id, p.invoice_id, p.paid_on::text AS date, p.amount_pence, p.method, p.reference
      FROM payments p ORDER BY p.paid_on`;
  const credits = await tx<
    { id: string; invoiceId: string; number: string | null; date: string; amountPence: string }[]
  >`
    SELECT id, invoice_id, number, issue_date::text AS date, amount_pence
      FROM credit_notes WHERE status = 'approved'`;
  const creditUses = await tx<
    { id: string; creditId: string; invoiceId: string; date: string; amountPence: string }[]
  >`
    SELECT id, credit_invoice_id AS credit_id, invoice_id, applied_on::text AS date, amount_pence
      FROM credit_uses ORDER BY applied_on, created_at`;
  const bills = await tx<
    {
      id: string;
      supplierId: string;
      supplierName: string;
      reference: string;
      kind: 'bill' | 'credit_note';
      date: string;
      dueDate: string | null;
      totalPence: string;
      homePence: string;
    }[]
  >`
    SELECT b.id, s.id AS supplier_id, s.name AS supplier_name, b.reference, b.kind,
           b.bill_date::text AS date, b.due_date::text AS due_date, b.total_pence,
           (SELECT COALESCE(SUM(l.total_pence), 0) FROM supplier_bill_lines l
             WHERE l.bill_id = b.id AND l.allocation = 'home') AS home_pence
      FROM supplier_bills b JOIN suppliers s ON s.id = b.supplier_id
     WHERE b.status = 'applied'`;
  const billPayments = await tx<
    {
      id: string;
      billId: string;
      date: string;
      amountPence: string;
      method: string;
      reference: string | null;
    }[]
  >`
    SELECT id, bill_id, paid_on::text AS date, amount_pence, method, reference
      FROM supplier_bill_payments`;
  const budgets = await tx<{ month: string; account: string; amountPence: string }[]>`
    SELECT to_char(month, 'YYYY-MM') AS month, account_code AS account, amount_pence FROM budgets`;
  const pipeline = await tx<
    { key: string; name: string; colour: string; count: string; valuePence: string }[]
  >`
    SELECT st.id AS key, st.name, st.colour, COUNT(j.id) AS count,
           COALESCE(SUM((SELECT COALESCE(SUM(l.total_pence), 0) FROM job_lines l WHERE l.job_id = j.id)), 0)
             AS value_pence
      FROM job_stages st LEFT JOIN jobs j ON j.stage_id = st.id
     WHERE st.system_key IS DISTINCT FROM 'cancelled'
     GROUP BY st.id, st.name, st.colour, st.sort_order
     ORDER BY st.sort_order, st.name`;
  const [quotes] = await tx<{ count: string; value: string }[]>`
    SELECT COUNT(*) AS count, COALESCE(SUM(r.total_pence), 0) AS value
      FROM quotes q JOIN quote_revisions r ON r.quote_id = q.id AND r.revision = q.current_revision
     WHERE q.status = 'sent'`;

  return {
    today: t,
    yearStart: settings?.yearStart ?? '01-01',
    yearEffectiveFrom: settings?.yearEffectiveFrom ?? t,
    opening: opening ? { date: opening.date, bankPence: n(opening.bankPence) } : null,
    invoices: invoices.map((i) => ({
      id: i.id,
      number: i.number,
      customerId: i.customerId,
      customerName: i.customerName,
      jobNumber: i.jobNumber,
      issueDate: i.issueDate,
      dueDate: i.dueDate,
      labourNetPence: n(i.labourNet),
      netPence: n(i.net),
      taxPence: n(i.tax),
      totalPence: n(i.total),
    })),
    payments: payments.map((p) => ({ ...p, amountPence: n(p.amountPence) })),
    credits: credits.map((c) => ({ ...c, amountPence: n(c.amountPence) })),
    creditUses: creditUses.map((u) => ({ ...u, amountPence: n(u.amountPence) })),
    bills: bills.map((b) => ({ ...b, totalPence: n(b.totalPence), homePence: n(b.homePence) })),
    billPayments: billPayments.map((p) => ({ ...p, amountPence: n(p.amountPence) })),
    budgets: budgets.map((b) => ({ ...b, amountPence: n(b.amountPence) })),
    pipeline: pipeline.map((p) => ({ ...p, count: n(p.count), valuePence: n(p.valuePence) })),
    openQuotes: { count: n(quotes?.count), valuePence: n(quotes?.value) },
  };
}

const adminOnly = (auth: Auth, what: string) => {
  if (!auth.access?.isAdmin) throw new AppError(403, 'admin_only', `Only an admin can ${what}.`);
};

export async function setOpening(tx: Tx, auth: Auth, input: OpeningBalanceUpdate) {
  adminOnly(auth, 'change the opening bank balance');
  await tx`
    INSERT INTO business_books (tenant_id, opening_date, opening_bank_pence, updated_by)
    VALUES (${auth.tenantId}, ${input.date}, ${input.bankPence}, ${auth.userId})
    ON CONFLICT (tenant_id) DO UPDATE
      SET opening_date = EXCLUDED.opening_date, opening_bank_pence = EXCLUDED.opening_bank_pence,
          updated_by = EXCLUDED.updated_by, updated_at = now()`;
  await audit(tx, auth, 'update', 'opening_balance', null, { ...input });
  return getBusiness(tx);
}

/** Replaces the 12 months of the given budget year for the accounts sent (0 clears a month). */
export async function setBudget(tx: Tx, auth: Auth, input: BudgetUpdate) {
  adminOnly(auth, 'change the budget');
  const months = budgetMonths(input.year, input.startMonth ?? 1);
  for (const line of input.lines) {
    await tx`DELETE FROM budgets WHERE account_code = ${line.account}
               AND month BETWEEN ${`${months[0]}-01`}::date AND ${`${months[11]}-01`}::date`;
    for (let i = 0; i < 12; i++) {
      const amount = line.months[i]!;
      if (amount > 0)
        await tx`INSERT INTO budgets (tenant_id, month, account_code, amount_pence, updated_by)
                 VALUES (${auth.tenantId}, ${`${months[i]}-01`}::date, ${line.account}, ${amount}, ${auth.userId})`;
    }
  }
  await audit(tx, auth, 'update', 'budget', null, {
    year: input.year,
    accounts: input.lines.map((l) => l.account),
  });
  return getBusiness(tx);
}

/* --------------------------- supplier bill payments --------------------------- */

export async function billPayments(tx: Tx, billId: string): Promise<BillPaymentDto[]> {
  const [b] = await tx<{ id: string }[]>`SELECT id FROM supplier_bills WHERE id = ${billId}`;
  if (!b) throw notFound('Bill');
  const rows = await tx<
    {
      id: string;
      amountPence: string;
      paidOn: string;
      method: string;
      reference: string | null;
      createdAt: Date;
    }[]
  >`
    SELECT id, amount_pence, paid_on::text AS paid_on, method, reference, created_at
      FROM supplier_bill_payments WHERE bill_id = ${billId} ORDER BY paid_on, created_at`;
  return rows.map((r) => ({
    ...r,
    amountPence: n(r.amountPence),
    createdAt: new Date(r.createdAt).toISOString(),
  }));
}

/**
 * Records money paid to a supplier against an applied bill (the owner's decision, like customer
 * payments). Never more than is still owed; a credit note can't be "paid".
 */
export async function recordBillPayment(
  tx: Tx,
  auth: Auth,
  billId: string,
  input: BillPaymentCreate,
) {
  if (auth.role !== 'owner')
    throw new AppError(403, 'owner_only', 'Only the business owner can record a payment.');
  const [b] = await tx<{ kind: string; status: string; total: string }[]>`
    SELECT kind, status, total_pence AS total FROM supplier_bills WHERE id = ${billId} FOR UPDATE`;
  if (!b) throw notFound('Bill');
  if (b.kind !== 'bill' || b.status !== 'applied')
    throw new AppError(409, 'bill_not_payable', 'Only an applied supplier bill can be paid.');
  const [paid] = await tx<{ s: string }[]>`
    SELECT COALESCE(SUM(amount_pence), 0) AS s FROM supplier_bill_payments WHERE bill_id = ${billId}`;
  const left = n(b.total) - n(paid?.s);
  if (input.amountPence > left)
    throw new AppError(
      422,
      'overpayment',
      left <= 0
        ? 'This bill is already paid in full.'
        : `Only £${(left / 100).toFixed(2)} is still owed on this bill.`,
    );
  const t = await today(tx);
  if (input.paidOn > t)
    throw new AppError(422, 'future_date', 'The payment date can’t be in the future.');
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO supplier_bill_payments (tenant_id, bill_id, amount_pence, paid_on, method, reference, recorded_by)
    VALUES (${auth.tenantId}, ${billId}, ${input.amountPence}, ${input.paidOn}, ${input.method},
            ${input.reference || null}, ${auth.userId})
    RETURNING id`;
  await audit(tx, auth, 'create', 'bill_payment', row!.id, {
    billId,
    amountPence: input.amountPence,
  });
  return billPayments(tx, billId);
}
