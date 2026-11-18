import {
  approveDateProblem,
  chargeOutFor,
  DEFAULT_INVOICE_TERMS,
  addDaysIso,
  displayStatus,
  formatPence,
  invoiceNumber,
  invoiceTotals,
  percentOf,
  planCreditUse,
  readiness,
  statusAfterPayment,
  type CreditNoteSummaryDto,
  type CreditUseDto,
  type InvoiceDetailDto,
  type InvoiceLineDto,
  type InvoiceLineKind,
  type InvoiceStatus,
  type InvoiceSummaryDto,
  type JobInvoicingDto,
  type PaymentDto,
  type QuoteInvoiceMode,
  type invoiceCreate,
  type invoiceUpdate,
  type paymentCreate,
} from '@lse/shared';
import type { z } from 'zod';
import type { Tx } from '../db/client';
import { AppError, assertVersion, conflict, invalid, notFound } from '../lib/errors';
import { iso, isoNN, type Auth } from '../lib/types';
import { audit } from './audit';
import { markFullyInvoicedAndPaid } from './jobs';
import { getSettings } from './settings';

/** Approve, mark sent and record payment are the owner's explicit decisions (spec golden rule). */
export function assertOwnerDecision(auth: Auth, what: string) {
  if (auth.role !== 'owner')
    throw new AppError(403, 'owner_only', `Only the business owner can ${what}.`);
}

export async function today(tx: Tx): Promise<string> {
  const [t] = await tx<{ today: string }[]>`
    SELECT (now() AT TIME ZONE timezone)::date::text AS today FROM tenants WHERE id = app_current_tenant()`;
  return t!.today;
}

interface InvoiceRow {
  id: string;
  number: string | null;
  jobId: string;
  jobNumber: string;
  jobTitle: string;
  customerId: string;
  customerName: string;
  status: InvoiceStatus;
  source: 'job' | 'quote';
  quoteMode: QuoteInvoiceMode | null;
  quoteId: string | null;
  quoteAmountPence: string | null;
  issueDate: string | null;
  dueDate: string | null;
  termsDays: number;
  notes: string | null;
  subtotalPence: string;
  taxPence: string;
  totalPence: string;
  paidPence: string;
  creditedPence: string;
  creditUsedPence: string;
  approvedByName: string | null;
  approvedAt: Date | null;
  sentByName: string | null;
  sentAt: Date | null;
  createdAt: Date;
  version: number;
}

const SELECT_INVOICE = `
  SELECT v.id, v.number, v.job_id, j.number AS job_number, j.title AS job_title, c.id AS customer_id, c.name AS customer_name,
         v.status, v.source, v.quote_mode, v.quote_id, v.quote_amount_pence, v.issue_date::text AS issue_date,
         v.due_date::text AS due_date, v.terms_days, v.notes, v.subtotal_pence, v.tax_pence, v.total_pence,
         v.paid_pence, v.credited_pence, v.credit_used_pence, ua.name AS approved_by_name, v.approved_at, us.name AS sent_by_name, v.sent_at,
         v.created_at, v.version
    FROM invoices v
    JOIN jobs j ON j.id = v.job_id
    JOIN customers c ON c.id = j.customer_id
    LEFT JOIN users ua ON ua.id = v.approved_by
    LEFT JOIN users us ON us.id = v.sent_by`;

function toSummary(r: InvoiceRow, todayIso: string): InvoiceSummaryDto {
  const total = Number(r.totalPence);
  const paid = Number(r.paidPence);
  const credited = Number(r.creditedPence);
  return {
    id: r.id,
    number: r.number,
    jobId: r.jobId,
    jobNumber: r.jobNumber,
    jobTitle: r.jobTitle,
    customerName: r.customerName,
    status: r.status,
    displayStatus: displayStatus(r, todayIso),
    source: r.source,
    quoteMode: r.quoteMode,
    issueDate: r.issueDate,
    dueDate: r.dueDate,
    totalPence: total,
    paidPence: paid,
    creditedPence: credited,
    // A customer credit: what is left to use, as a negative amount.
    balancePence:
      r.status === 'credit' ? total + Number(r.creditUsedPence) : total - paid - credited,
    createdAt: isoNN(r.createdAt),
    version: r.version,
  };
}

export type InvoiceFilter = 'all' | 'draft' | 'outstanding' | 'overdue' | 'paid';

export async function listInvoices(
  tx: Tx,
  q: { filter?: InvoiceFilter; jobId?: string } = {},
): Promise<InvoiceSummaryDto[]> {
  const t = await today(tx);
  const f = q.filter ?? 'all';
  const rows = await tx<InvoiceRow[]>`
    ${tx.unsafe(SELECT_INVOICE)}
     WHERE (${q.jobId ?? null}::uuid IS NULL OR v.job_id = ${q.jobId ?? null})
       AND CASE ${f}
             WHEN 'draft' THEN v.status = 'draft'
             WHEN 'outstanding' THEN v.status IN ('approved', 'sent', 'part_paid')
             WHEN 'overdue' THEN v.status IN ('sent', 'part_paid') AND v.due_date < ${t}::date
             WHEN 'paid' THEN v.status = 'paid'
             ELSE true END
     ORDER BY CASE WHEN v.status = 'draft' THEN 0 ELSE 1 END,
              v.due_date NULLS FIRST, v.created_at DESC
     LIMIT 500`;
  return rows.map((r) => toSummary(r, t));
}

async function loadRow(tx: Tx, id: string): Promise<InvoiceRow> {
  const [r] = await tx<InvoiceRow[]>`${tx.unsafe(SELECT_INVOICE)} WHERE v.id = ${id}`;
  if (!r) throw notFound('Invoice');
  return r;
}

export async function lockInvoice(tx: Tx, id: string) {
  const [r] = await tx<{ status: InvoiceStatus; version: number; jobId: string }[]>`
    SELECT status, version, job_id FROM invoices WHERE id = ${id} FOR UPDATE`;
  if (!r) throw notFound('Invoice');
  return r;
}

/** Invoices go to the bill payer: the first bill-payer contact with an email, else the customer. */
export async function billTo(tx: Tx, jobId: string) {
  const [r] = await tx<
    {
      name: string;
      email: string | null;
      address: string | null;
      contactName: string | null;
      contactEmail: string | null;
    }[]
  >`
    SELECT c.name, c.email, c.billing_address AS address, bp.name AS contact_name, bp.email AS contact_email
      FROM jobs j JOIN customers c ON c.id = j.customer_id
      LEFT JOIN LATERAL (
        SELECT name, email FROM contacts WHERE customer_id = c.id AND role = 'bill_payer'
         ORDER BY (email IS NULL), created_at LIMIT 1) bp ON true
     WHERE j.id = ${jobId}`;
  if (!r) throw notFound('Job');
  return r.contactEmail
    ? { name: `${r.contactName} (${r.name})`, email: r.contactEmail, address: r.address }
    : { name: r.name, email: r.email, address: r.address };
}

export async function getInvoice(tx: Tx, id: string): Promise<InvoiceDetailDto> {
  const r = await loadRow(tx, id);
  const t = await today(tx);
  const lines = await tx<
    (Omit<InvoiceLineDto, 'qtyMilli' | 'unitPricePence' | 'totalPence'> & {
      qtyMilli: string;
      unitPricePence: string;
      totalPence: string;
    })[]
  >`
    SELECT id, position, kind, description, qty_milli, unit_price_pence, total_pence, tax_rate_bp
      FROM invoice_lines WHERE invoice_id = ${id} ORDER BY position`;
  const payments = await tx<
    (Omit<PaymentDto, 'amountPence' | 'createdAt'> & { amountPence: string; createdAt: Date })[]
  >`
    SELECT p.id, p.amount_pence, p.paid_on::text AS paid_on, p.method, p.reference, u.name AS recorded_by_name, p.created_at
      FROM payments p JOIN users u ON u.id = p.recorded_by
     WHERE p.invoice_id = ${id} ORDER BY p.paid_on, p.created_at`;
  const creditNotes = await tx<
    (Omit<CreditNoteSummaryDto, 'amountPence'> & { amountPence: string })[]
  >`
    SELECT id, number, status, issue_date::text AS issue_date, reason, amount_pence
      FROM credit_notes WHERE invoice_id = ${id} ORDER BY created_at`;
  const uses = await creditUsesFor(tx, id);
  const [quote] = r.quoteId
    ? await tx<{ number: string }[]>`SELECT number FROM quotes WHERE id = ${r.quoteId}`
    : [];
  const settings = await getSettings(tx);
  const to = await billTo(tx, r.jobId);
  const [jc] = await tx<
    { invoiceCount: number }[]
  >`SELECT invoice_count FROM jobs WHERE id = ${r.jobId}`;
  const blockers: string[] = [];
  if (r.status === 'draft') {
    for (const m of readiness(settings).invoice.missing) blockers.push(m.label);
    // A job that comes to less than £0 is issued as a customer credit: nothing to email or pay.
    if (!to.email && Number(r.totalPence) > 0) blockers.push('Bill payer email');
    if (Number(r.totalPence) === 0) blockers.push('An amount to invoice');
  }
  return {
    ...toSummary(r, t),
    quoteNumber: quote?.number ?? null,
    termsDays: r.termsDays,
    termsText: settings.invoiceTerms?.trim() || DEFAULT_INVOICE_TERMS(r.termsDays),
    notes: r.notes,
    subtotalPence: Number(r.subtotalPence),
    taxPence: Number(r.taxPence),
    billTo: to,
    approvedByName: r.approvedByName,
    approvedAt: iso(r.approvedAt),
    sentByName: r.sentByName,
    sentAt: iso(r.sentAt),
    lines: lines.map((l) => ({
      ...l,
      qtyMilli: Number(l.qtyMilli),
      unitPricePence: Number(l.unitPricePence),
      totalPence: Number(l.totalPence),
    })),
    payments: payments.map((p) => ({
      ...p,
      amountPence: Number(p.amountPence),
      createdAt: isoNN(p.createdAt),
    })),
    creditNotes: creditNotes.map((c) => ({ ...c, amountPence: Number(c.amountPence) })),
    creditsApplied: uses.filter((u) => u.invoiceId === id),
    creditUses: uses.filter((u) => u.creditId === id),
    creditToUsePence:
      r.status === 'draft' && Number(r.totalPence) > 0
        ? Math.min(
            Number(r.totalPence),
            (await availableCredits(tx, r.customerId)).reduce((a, c) => a + c.remainingPence, 0),
          )
        : 0,
    nextNumber:
      r.status !== 'draft'
        ? null
        : Number(r.totalPence) < 0
          ? await nextCreditNumber(tx)
          : invoiceNumber(r.jobNumber, (jc?.invoiceCount ?? 0) + 1),
    approvalBlockers: blockers,
  };
}

/* ---------------------------- customer credit ----------------------------- */

/** Every use of a customer credit that touches this invoice (as the credit or as the invoice). */
async function creditUsesFor(tx: Tx, id: string): Promise<CreditUseDto[]> {
  const rows = await tx<(Omit<CreditUseDto, 'amountPence'> & { amountPence: string })[]>`
    SELECT u.id, u.credit_invoice_id AS credit_id, cr.number AS credit_number, u.invoice_id,
           iv.number AS invoice_number, u.applied_on::text AS applied_on, u.amount_pence
      FROM credit_uses u
      JOIN invoices cr ON cr.id = u.credit_invoice_id
      JOIN invoices iv ON iv.id = u.invoice_id
     WHERE u.credit_invoice_id = ${id} OR u.invoice_id = ${id}
     ORDER BY u.applied_on, u.created_at`;
  return rows.map((u) => ({ ...u, amountPence: Number(u.amountPence) }));
}

/** The CN number issuing a customer credit now would take (credit notes share the sequence). */
async function nextCreditNumber(tx: Tx): Promise<string | null> {
  const [seq] = await tx<{ prefix: string; padding: number; nextValue: string }[]>`
    SELECT prefix, padding, next_value FROM number_sequences WHERE kind = 'credit_note'`;
  if (!seq) return null;
  const v = String(Number(seq.nextValue));
  return seq.prefix + v.padStart(Math.max(seq.padding, v.length), '0');
}

/** A customer's credit still to use, oldest first (locked, so two approvals can't both use it). */
export async function availableCredits(
  tx: Tx,
  customerId: string,
  lock = false,
  /** Only credits issued on or before this date (an invoice dated earlier can't use a later credit). */
  asOf?: string,
): Promise<{ id: string; number: string; issueDate: string; remainingPence: number }[]> {
  const rows = await tx<{ id: string; number: string; issueDate: string; remaining: string }[]>`
    SELECT v.id, v.number, v.issue_date::text AS issue_date,
           (-v.total_pence - v.credit_used_pence) AS remaining
      FROM invoices v JOIN jobs j ON j.id = v.job_id
     WHERE j.customer_id = ${customerId} AND v.status = 'credit'
       AND -v.total_pence - v.credit_used_pence > 0
       AND (${asOf ?? null}::date IS NULL OR v.issue_date <= ${asOf ?? null}::date)
     ORDER BY v.issue_date, v.number
     ${lock ? tx`FOR UPDATE OF v` : tx``}`;
  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    issueDate: r.issueDate,
    remainingPence: Number(r.remaining),
  }));
}

/**
 * Uses the customer's credit on an invoice just approved: oldest credit first, up to what the
 * invoice owes. Dated the invoice's issue date. Returns the amount taken off.
 */
async function applyCredits(
  tx: Tx,
  auth: Auth,
  invoiceId: string,
  customerId: string,
  owedPence: number,
  date: string,
): Promise<number> {
  const plan = planCreditUse(await availableCredits(tx, customerId, true, date), owedPence);
  let used = 0;
  for (const p of plan) {
    await tx`INSERT INTO credit_uses (tenant_id, credit_invoice_id, invoice_id, amount_pence, applied_on, created_by)
             VALUES (${auth.tenantId}, ${p.creditId}, ${invoiceId}, ${p.amountPence}, ${date}::date, ${auth.userId})`;
    await tx`UPDATE invoices SET credit_used_pence = credit_used_pence + ${p.amountPence} WHERE id = ${p.creditId}`;
    used += p.amountPence;
  }
  if (used) {
    await tx`UPDATE invoices SET credited_pence = credited_pence + ${used} WHERE id = ${invoiceId}`;
    await audit(tx, auth, 'use_credit', 'invoice', invoiceId, { uses: plan });
  }
  return used;
}

/* ------------------------------- creation -------------------------------- */

interface JobRow {
  id: string;
  number: string;
  title: string;
  sourceQuoteId: string | null;
  sourceQuoteRevision: number | null;
}

async function lockJob(tx: Tx, jobId: string): Promise<JobRow> {
  const [j] = await tx<JobRow[]>`
    SELECT id, number, title, source_quote_id, source_quote_revision FROM jobs WHERE id = ${jobId} FOR UPDATE`;
  if (!j) throw notFound('Job');
  return j;
}

async function quoteState(tx: Tx, job: JobRow) {
  if (!job.sourceQuoteId) return null;
  const [q] = await tx<{ id: string; number: string; totalPence: string }[]>`
    SELECT q.id, q.number, r.total_pence
      FROM quotes q JOIN quote_revisions r ON r.quote_id = q.id AND r.revision = ${job.sourceQuoteRevision ?? 1}
     WHERE q.id = ${job.sourceQuoteId}`;
  if (!q) return null;
  const [inv] = await tx<{ invoiced: string; numbers: string[] }[]>`
    SELECT coalesce(sum(quote_amount_pence), 0) AS invoiced,
           coalesce(array_agg(coalesce(number, 'draft') ORDER BY created_at), '{}') AS numbers
      FROM invoices WHERE job_id = ${job.id} AND source = 'quote'`;
  const totalPence = Number(q.totalPence);
  const invoicedPence = Number(inv!.invoiced);
  return {
    id: q.id,
    number: q.number,
    totalPence,
    invoicedPence,
    remainingPence: totalPence - invoicedPence,
    numbers: inv!.numbers.filter(Boolean),
  };
}

interface Unbilled {
  timesheets: {
    id: string;
    startedAt: Date;
    minutes: number;
    userName: string;
    chargeOutPence: number | null;
  }[];
  lines: {
    id: string;
    kind: InvoiceLineKind;
    description: string;
    qtyMilli: number;
    unitSellPence: number;
    totalPence: number;
  }[];
}

async function unbilled(tx: Tx, jobId: string): Promise<Unbilled> {
  const timesheets = await tx<Unbilled['timesheets']>`
    SELECT t.id, t.started_at, u.name AS user_name, co.charge_out_pence::int AS charge_out_pence,
           greatest(1, round(extract(epoch FROM (t.ended_at - t.started_at)) / 60))::int AS minutes
      FROM timesheets t JOIN users u ON u.id = t.user_id
      LEFT JOIN member_charge_out co ON co.user_id = t.user_id
     WHERE t.job_id = ${jobId} AND t.invoice_id IS NULL AND t.ended_at IS NOT NULL
     ORDER BY t.started_at`;
  const lines = await tx<
    (Omit<Unbilled['lines'][number], 'qtyMilli' | 'unitSellPence' | 'totalPence'> & {
      qtyMilli: string;
      unitSellPence: string;
      totalPence: string;
    })[]
  >`
    SELECT id, kind, description, qty_milli, unit_sell_pence, total_pence FROM job_lines
     WHERE job_id = ${jobId} AND source IN ('manual', 'supplier_bill') AND invoice_id IS NULL ORDER BY position`;
  return {
    timesheets: [...timesheets],
    lines: lines.map((l) => ({
      ...l,
      qtyMilli: Number(l.qtyMilli),
      unitSellPence: Number(l.unitSellPence),
      totalPence: Number(l.totalPence),
    })),
  };
}

const dayLabel = (d: Date, tz: string) =>
  new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: tz,
  }).format(d);

type LineDraft = {
  kind: InvoiceLineKind;
  description: string;
  qtyMilli: number;
  unitPricePence: number;
  taxRateBp: number;
};

async function writeLines(tx: Tx, auth: Auth, invoiceId: string, lines: LineDraft[]) {
  const t = invoiceTotals(lines);
  await tx`DELETE FROM invoice_lines WHERE invoice_id = ${invoiceId}`;
  if (lines.length)
    await tx`INSERT INTO invoice_lines ${tx(
      lines.map((l, i) => ({
        tenant_id: auth.tenantId,
        invoice_id: invoiceId,
        position: i,
        kind: l.kind,
        description: l.description.slice(0, 500),
        qty_milli: l.qtyMilli,
        unit_price_pence: l.unitPricePence,
        total_pence: t.lineTotals[i]!,
        tax_rate_bp: l.taxRateBp,
      })),
    )}`;
  await tx`UPDATE invoices SET subtotal_pence = ${t.subtotalPence}, tax_pence = ${t.taxPence}, total_pence = ${t.totalPence}
            WHERE id = ${invoiceId}`;
  return t;
}

/** Creates a DRAFT. Drafts have no number; nothing leaves the app. */
export async function createInvoice(
  tx: Tx,
  auth: Auth,
  jobId: string,
  input: z.output<typeof invoiceCreate>,
): Promise<InvoiceDetailDto> {
  const job = await lockJob(tx, jobId);
  const settings = await getSettings(tx);
  const tax = settings.taxRateBp;
  let lines: LineDraft[] = [];
  let quoteId: string | null = null;
  let quoteAmount: number | null = null;
  let mode: QuoteInvoiceMode | null = null;
  let reserve: Unbilled | null = null;

  if (input.source === 'job') {
    const u = await unbilled(tx, jobId);
    if (!u.timesheets.length && !u.lines.length)
      throw invalid('There is no unbilled time or materials on this job yet.');
    for (const ts of u.timesheets) {
      const h = Math.floor(ts.minutes / 60);
      const m = ts.minutes % 60;
      lines.push({
        kind: 'labour',
        description: `Labour ${dayLabel(ts.startedAt, settings.timezone)} – ${ts.userName} (${h ? `${h} h ` : ''}${m} min)`,
        qtyMilli: Math.round((ts.minutes * 1000) / 60),
        // Each person's own charge-out rate, else the business labour rate.
        unitPricePence: chargeOutFor(ts.chargeOutPence, settings.labourRatePence),
        taxRateBp: tax,
      });
    }
    for (const l of u.lines) {
      lines.push({
        kind: l.kind,
        description: l.description,
        qtyMilli: l.qtyMilli,
        unitPricePence: l.unitSellPence,
        taxRateBp: tax,
      });
    }
    reserve = u;
  } else {
    const q = await quoteState(tx, job);
    if (!q)
      throw invalid(
        'This job did not come from a quote, so invoice its time and materials instead.',
      );
    quoteId = q.id;
    mode = input.mode;
    const quoteLines = async (): Promise<LineDraft[]> => {
      const rows = await tx<
        {
          kind: InvoiceLineKind;
          description: string;
          qtyMilli: string;
          unitSellPence: string;
          totalPence: string;
        }[]
      >`
        SELECT kind, description, qty_milli, unit_sell_pence, total_pence FROM job_lines
         WHERE job_id = ${jobId} AND source = 'quote' ORDER BY position`;
      return rows
        .filter((r) => !(r.kind === 'carriage' && Number(r.totalPence) === 0))
        .map((r) => ({
          kind: r.kind,
          description: r.description,
          qtyMilli: Number(r.qtyMilli),
          unitPricePence: Number(r.unitSellPence),
          taxRateBp: tax,
        }));
    };
    // A quote that comes to less than £0 (credits outweigh the work) is invoiced whole, once,
    // and becomes a customer credit on approval.
    if (q.invoicedPence === 0 ? q.totalPence === 0 : q.remainingPence <= 0)
      throw invalid(`Quote ${q.number} is already fully invoiced.`);
    switch (input.mode) {
      case 'whole':
        if (q.invoicedPence > 0)
          throw invalid(`Part of quote ${q.number} is already invoiced. Use "Remainder" instead.`);
        lines = await quoteLines();
        quoteAmount = q.totalPence;
        break;
      case 'deposit':
      case 'percent': {
        const amount =
          input.mode === 'deposit' ? input.amountPence : percentOf(q.totalPence, input.percentBp);
        if (amount < 1) throw invalid('That works out at less than a penny.');
        if (amount > q.remainingPence)
          throw invalid(
            `That is more than the ${formatPence(q.remainingPence)} left to invoice on quote ${q.number}.`,
          );
        const label =
          input.mode === 'deposit'
            ? `Deposit for quote ${q.number}: ${job.title}`
            : `${(input.percentBp / 100).toFixed(2).replace(/\.?0+$/, '')}% of quote ${q.number}: ${job.title}`;
        lines = [
          {
            kind: 'deposit',
            description: label,
            qtyMilli: 1000,
            unitPricePence: amount,
            taxRateBp: tax,
          },
        ];
        quoteAmount = amount;
        break;
      }
      case 'remainder':
        lines = await quoteLines();
        if (q.invoicedPence > 0)
          lines.push({
            kind: 'adjustment',
            description: `Less already invoiced (${q.numbers.join(', ')})`,
            qtyMilli: 1000,
            unitPricePence: -q.invoicedPence,
            taxRateBp: tax,
          });
        quoteAmount = q.remainingPence;
        break;
    }
  }
  if (!lines.length) throw invalid('There is nothing to put on this invoice.');
  const [inv] = await tx<{ id: string }[]>`
    INSERT INTO invoices (tenant_id, job_id, source, quote_mode, quote_id, quote_amount_pence, terms_days, created_by)
    VALUES (${auth.tenantId}, ${jobId}, ${input.source}, ${mode}, ${quoteId}, ${quoteAmount},
            ${settings.paymentTermsDays}, ${auth.userId})
    RETURNING id`;
  await writeLines(tx, auth, inv!.id, lines);
  if (reserve) {
    const ts = reserve.timesheets.map((t) => t.id);
    const jl = reserve.lines.map((l) => l.id);
    if (ts.length)
      await tx`UPDATE timesheets SET invoice_id = ${inv!.id} WHERE id = ANY(${ts}::uuid[])`;
    if (jl.length)
      await tx`UPDATE job_lines SET invoice_id = ${inv!.id} WHERE id = ANY(${jl}::uuid[])`;
  }
  await audit(tx, auth, 'create', 'invoice', inv!.id, { jobId, source: input.source, mode });
  return getInvoice(tx, inv!.id);
}

/* ------------------------------ draft edits ------------------------------ */

export async function updateDraft(
  tx: Tx,
  auth: Auth,
  id: string,
  input: z.output<typeof invoiceUpdate>,
  expectedVersion?: number,
): Promise<InvoiceDetailDto> {
  const cur = await lockInvoice(tx, id);
  await assertVersion(expectedVersion, cur.version, () => getInvoice(tx, id));
  if (cur.status !== 'draft')
    throw conflict('invoice_locked', 'Only a draft invoice can be changed.');
  const cols: Record<string, unknown> = {};
  if (input.notes !== undefined) cols.notes = input.notes;
  if (input.termsDays !== undefined) cols.terms_days = input.termsDays;
  if (input.lines) {
    const [inv] = await tx<
      { source: string; quoteMode: string | null }[]
    >`SELECT source, quote_mode FROM invoices WHERE id = ${id}`;
    // A quote invoice's amount counts against the quote; keep it in step with its lines.
    const t = await writeLines(tx, auth, id, input.lines);
    if (inv!.source === 'quote') cols.quote_amount_pence = t.subtotalPence;
  }
  // Always bump the row (version) so other devices see the change.
  await tx`UPDATE invoices SET ${tx({ ...cols, updated_at: new Date() })} WHERE id = ${id}`;
  await audit(tx, auth, 'update', 'invoice', id, { fields: Object.keys(input) });
  return getInvoice(tx, id);
}

/** Only drafts can be deleted, so numbers never leave a gap. Reserved time is freed. */
export async function deleteDraft(tx: Tx, auth: Auth, id: string): Promise<void> {
  const cur = await lockInvoice(tx, id);
  if (cur.status !== 'draft')
    throw conflict('invoice_locked', 'An approved invoice keeps its number and cannot be deleted.');
  await tx`DELETE FROM invoices WHERE id = ${id}`;
  await audit(tx, auth, 'delete', 'invoice', id);
}

/* --------------------------- owner decisions ----------------------------- */

/** Owner taps Approve: pre-send checks, then the gap-free number (job number, -2, -3...). */
export async function approve(
  tx: Tx,
  auth: Auth,
  id: string,
  expectedVersion?: number,
  issueDate?: string,
  useCredit?: boolean,
): Promise<InvoiceDetailDto> {
  assertOwnerDecision(auth, 'approve an invoice');
  const cur = await lockInvoice(tx, id);
  await assertVersion(expectedVersion, cur.version, () => getInvoice(tx, id));
  if (cur.status !== 'draft')
    throw conflict('invoice_not_draft', 'This invoice is already approved.');
  const job = await lockJob(tx, cur.jobId);
  const detail = await getInvoice(tx, id);
  if (detail.approvalBlockers.length)
    throw new AppError(
      422,
      'not_ready',
      `Before approving, add: ${detail.approvalBlockers.join(', ')}.`,
      {
        missing: detail.approvalBlockers,
      },
    );
  const t = issueDate ?? (await today(tx));
  if (issueDate) {
    const problem = approveDateProblem(issueDate, await today(tx));
    if (problem)
      throw new AppError(422, 'validation_failed', problem, { fields: { issueDate: problem } });
  }
  if (detail.totalPence < 0) {
    // Less than £0: issued as a customer credit (CN number), used on the customer's next invoices.
    const [num] = await tx<
      { formatted: string }[]
    >`SELECT formatted FROM allocate_number('credit_note')`;
    await tx`
      UPDATE invoices SET status = 'credit', number = ${num!.formatted}, issue_date = ${t}::date,
             due_date = NULL, approved_by = ${auth.userId}, approved_at = now()
       WHERE id = ${id}`;
    await audit(tx, auth, 'issue_credit', 'invoice', id, {
      number: num!.formatted,
      amountPence: -detail.totalPence,
    });
    await completeJobIfSettled(tx, auth, job.id);
    return getInvoice(tx, id);
  }
  // Customer credit is never used silently (Joe, 18 Nov 2026): the approve sheet asks.
  const [own] = await tx<
    { customerId: string }[]
  >`SELECT customer_id FROM jobs WHERE id = ${job.id}`;
  const creditAvailable = (await availableCredits(tx, own!.customerId, false, t)).reduce(
    (a, c) => a + c.remainingPence,
    0,
  );
  if (creditAvailable > 0 && useCredit === undefined)
    throw new AppError(
      422,
      'credit_choice_needed',
      `${detail.customerName} has ${formatPence(creditAvailable)} credit. Choose whether to take it off this invoice or keep it for later.`,
      { creditAvailablePence: creditAvailable },
    );
  const [{ n }] = (await tx`
    UPDATE jobs SET invoice_count = invoice_count + 1 WHERE id = ${job.id} RETURNING invoice_count AS n`) as unknown as [
    { n: number },
  ];
  const number = invoiceNumber(job.number, n);
  await tx`
    UPDATE invoices SET status = 'approved', number = ${number}, issue_date = ${t}::date,
           due_date = ${addDaysIso(t, detail.termsDays)}::date, approved_by = ${auth.userId}, approved_at = now()
     WHERE id = ${id}`;
  await audit(tx, auth, 'approve', 'invoice', id, {
    number,
    ...(creditAvailable > 0 ? { creditKeptForLater: !useCredit } : {}),
  });
  if (useCredit) await applyCredits(tx, auth, id, own!.customerId, detail.totalPence, t);
  return getInvoice(tx, id);
}

/** Owner taps "Mark as sent". Records the fact; this app does not email anything yet. */
export async function markSent(tx: Tx, auth: Auth, id: string): Promise<InvoiceDetailDto> {
  assertOwnerDecision(auth, 'mark an invoice as sent');
  const cur = await lockInvoice(tx, id);
  if (cur.status !== 'approved')
    throw conflict(
      'invoice_not_approved',
      cur.status === 'draft'
        ? 'Approve the invoice before sending it.'
        : 'This invoice has already been sent.',
    );
  // Fully covered by customer credit: nothing left to pay, so it is settled once sent.
  const [b] = await tx<{ total: string; paid: string; credited: string }[]>`
    SELECT total_pence AS total, paid_pence AS paid, credited_pence AS credited FROM invoices WHERE id = ${id}`;
  const status = statusAfterPayment(Number(b!.total), Number(b!.paid), Number(b!.credited));
  await tx`UPDATE invoices SET status = ${status}, sent_by = ${auth.userId}, sent_at = now() WHERE id = ${id}`;
  await audit(tx, auth, 'mark_sent', 'invoice', id);
  if (status === 'paid') await completeJobIfSettled(tx, auth, cur.jobId);
  return getInvoice(tx, id);
}

/**
 * Owner records money received. A payment that clears the last balance on a fully invoiced job
 * calls markFullyInvoicedAndPaid, which moves the job to Complete.
 */
export async function recordPayment(
  tx: Tx,
  auth: Auth,
  id: string,
  input: z.output<typeof paymentCreate>,
): Promise<InvoiceDetailDto & { jobCompleted: boolean }> {
  assertOwnerDecision(auth, 'record a payment');
  const cur = await lockInvoice(tx, id);
  if (cur.status !== 'sent' && cur.status !== 'part_paid')
    throw conflict(
      'invoice_not_sent',
      cur.status === 'paid'
        ? 'This invoice is already paid.'
        : 'Mark the invoice as sent before recording a payment.',
    );
  await lockJob(tx, cur.jobId);
  const [inv] = await tx<{ totalPence: string; paidPence: string; creditedPence: string }[]>`
    SELECT total_pence, paid_pence, credited_pence FROM invoices WHERE id = ${id}`;
  const balance = Number(inv!.totalPence) - Number(inv!.paidPence) - Number(inv!.creditedPence);
  if (input.amountPence > balance)
    throw invalid(`That is more than the ${formatPence(balance)} still owed.`, {
      fields: { amountPence: `At most ${formatPence(balance)}` },
    });
  const t = await today(tx);
  if (input.paidOn > t)
    throw invalid('The payment date cannot be in the future.', {
      fields: { paidOn: 'In the future' },
    });
  await tx`INSERT INTO payments (tenant_id, invoice_id, amount_pence, paid_on, method, reference, recorded_by)
           VALUES (${auth.tenantId}, ${id}, ${input.amountPence}, ${input.paidOn}::date, ${input.method}, ${input.reference}, ${auth.userId})`;
  const paid = Number(inv!.paidPence) + input.amountPence;
  const status = statusAfterPayment(Number(inv!.totalPence), paid, Number(inv!.creditedPence));
  await tx`UPDATE invoices SET paid_pence = ${paid}, status = ${status} WHERE id = ${id}`;
  await audit(tx, auth, 'record_payment', 'invoice', id, {
    amountPence: input.amountPence,
    method: input.method,
  });
  const jobCompleted = status === 'paid' ? await completeJobIfSettled(tx, auth, cur.jobId) : false;
  return { ...(await getInvoice(tx, id)), jobCompleted };
}

/**
 * Fully invoiced and paid = at least one invoice, every invoice paid, and nothing left to bill:
 * a quoted job has no quote remainder; a time-and-materials job has no unbilled time or lines.
 */
export async function isSettled(tx: Tx, jobId: string): Promise<boolean> {
  const job = await lockJob(tx, jobId);
  const [s] = await tx<{ total: number; unpaid: number }[]>`
    SELECT count(*)::int AS total, count(*) FILTER (WHERE status NOT IN ('paid', 'credit'))::int AS unpaid
      FROM invoices WHERE job_id = ${jobId}`;
  if (!s!.total || s!.unpaid) return false;
  const q = await quoteState(tx, job);
  if (q) return q.remainingPence <= 0;
  const u = await unbilled(tx, jobId);
  return !u.timesheets.length && !u.lines.length;
}

export async function completeJobIfSettled(tx: Tx, auth: Auth, jobId: string): Promise<boolean> {
  if (!(await isSettled(tx, jobId))) return false;
  await markFullyInvoicedAndPaid(tx, auth, jobId);
  return true;
}

/* ------------------------------ job summary ------------------------------ */

export async function jobInvoicing(tx: Tx, jobId: string): Promise<JobInvoicingDto> {
  const [job] = await tx<JobRow[]>`
    SELECT id, number, title, source_quote_id, source_quote_revision FROM jobs WHERE id = ${jobId}`;
  if (!job) throw notFound('Job');
  const settings = await getSettings(tx);
  const q = await quoteState(tx, job);
  const u = await unbilled(tx, jobId);
  const minutes = u.timesheets.reduce((a, t) => a + t.minutes, 0);
  const labour = invoiceTotals(
    u.timesheets.map((t) => ({
      qtyMilli: Math.round((t.minutes * 1000) / 60),
      unitPricePence: chargeOutFor(t.chargeOutPence, settings.labourRatePence),
      taxRateBp: 0,
    })),
  ).subtotalPence;
  return {
    jobId,
    quote: q
      ? {
          id: q.id,
          number: q.number,
          totalPence: q.totalPence,
          invoicedPence: q.invoicedPence,
          remainingPence: q.remainingPence,
        }
      : null,
    unbilledMinutes: minutes,
    unbilledLabourPence: labour,
    unbilledMaterialsPence: u.lines.reduce((a, l) => a + l.totalPence, 0),
    invoices: await listInvoices(tx, { jobId }),
  };
}
