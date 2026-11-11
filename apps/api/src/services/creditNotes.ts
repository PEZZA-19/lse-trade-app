/**
 * Customer credit notes (see @lse/shared creditNotes). Anyone drafts; the owner approves, which
 * takes the CN number and reduces the invoice balance in the same transaction. Nothing is sent.
 */
import {
  creditBlocker,
  formatDocNumber,
  formatPence,
  statusAfterPayment,
  type CreditNoteDto,
  type CreditNoteStatus,
  type creditNoteCreate,
} from '@lse/shared';
import type { z } from 'zod';
import type { Tx } from '../db/client';
import { assertVersion, conflict, invalid, notFound } from '../lib/errors';
import { iso, isoNN, type Auth } from '../lib/types';
import { audit } from './audit';
import {
  assertOwnerDecision,
  billTo,
  completeJobIfSettled,
  getInvoice,
  lockInvoice,
  today,
} from './invoices';

interface Row {
  id: string;
  number: string | null;
  status: CreditNoteStatus;
  issueDate: string | null;
  reason: string;
  amountPence: string;
  invoiceId: string;
  approvedByName: string | null;
  approvedAt: Date | null;
  createdAt: Date;
  version: number;
}

export async function getCreditNote(tx: Tx, id: string): Promise<CreditNoteDto> {
  const [r] = await tx<Row[]>`
    SELECT cn.id, cn.number, cn.status, cn.issue_date::text AS issue_date, cn.reason, cn.amount_pence,
           cn.invoice_id, u.name AS approved_by_name, cn.approved_at, cn.created_at, cn.version
      FROM credit_notes cn LEFT JOIN users u ON u.id = cn.approved_by
     WHERE cn.id = ${id}`;
  if (!r) throw notFound('Credit note');
  const inv = await getInvoice(tx, r.invoiceId);
  let nextNumber: string | null = null;
  if (r.status === 'draft') {
    const [seq] = await tx<{ prefix: string; padding: number; nextValue: string }[]>`
      SELECT prefix, padding, next_value FROM number_sequences WHERE kind = 'credit_note'`;
    if (seq) nextNumber = formatDocNumber(seq.prefix, seq.padding, Number(seq.nextValue));
  }
  return {
    id: r.id,
    number: r.number,
    status: r.status,
    issueDate: r.issueDate,
    reason: r.reason,
    amountPence: Number(r.amountPence),
    invoiceId: inv.id,
    invoiceNumber: inv.number ?? 'Draft',
    invoiceTotalPence: inv.totalPence,
    invoiceBalancePence: inv.balancePence,
    jobId: inv.jobId,
    jobNumber: inv.jobNumber,
    jobTitle: inv.jobTitle,
    billTo: await billTo(tx, inv.jobId),
    approvedByName: r.approvedByName,
    approvedAt: iso(r.approvedAt),
    createdAt: isoNN(r.createdAt),
    nextNumber,
    version: r.version,
  };
}

/** Drafts outstanding on the invoice, so two drafts can't together credit more than is owed. */
async function draftTotal(tx: Tx, invoiceId: string, except?: string): Promise<number> {
  const [d] = await tx<{ sum: string }[]>`
    SELECT coalesce(sum(amount_pence), 0) AS sum FROM credit_notes
     WHERE invoice_id = ${invoiceId} AND status = 'draft' AND id <> ${except ?? '00000000-0000-0000-0000-000000000000'}`;
  return Number(d!.sum);
}

function tooMuch(balance: number) {
  return invalid(`That is more than the ${formatPence(balance)} still owed on the invoice.`, {
    fields: { amountPence: `At most ${formatPence(balance)}` },
  });
}

export async function createCreditNote(
  tx: Tx,
  auth: Auth,
  invoiceId: string,
  input: z.output<typeof creditNoteCreate>,
): Promise<CreditNoteDto> {
  await lockInvoice(tx, invoiceId);
  const inv = await getInvoice(tx, invoiceId);
  const blocked = creditBlocker(inv);
  if (blocked) throw conflict('invoice_not_creditable', blocked);
  const room = inv.balancePence - (await draftTotal(tx, invoiceId));
  if (input.amountPence > room) {
    if (room < inv.balancePence)
      throw invalid(
        `Another draft credit note already covers part of this invoice; ${formatPence(Math.max(0, room))} is left to credit.`,
        { fields: { amountPence: `At most ${formatPence(Math.max(0, room))}` } },
      );
    throw tooMuch(inv.balancePence);
  }
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO credit_notes (tenant_id, invoice_id, reason, amount_pence, created_by)
    VALUES (${auth.tenantId}, ${invoiceId}, ${input.reason}, ${input.amountPence}, ${auth.userId})
    RETURNING id`;
  await audit(tx, auth, 'create', 'credit_note', row!.id, {
    invoiceId,
    amountPence: input.amountPence,
  });
  return getCreditNote(tx, row!.id);
}

async function lockCredit(tx: Tx, id: string) {
  const [r] = await tx<
    { status: CreditNoteStatus; version: number; invoiceId: string; amountPence: string }[]
  >`
    SELECT status, version, invoice_id, amount_pence FROM credit_notes WHERE id = ${id} FOR UPDATE`;
  if (!r) throw notFound('Credit note');
  return r;
}

export async function deleteCreditNote(tx: Tx, auth: Auth, id: string): Promise<void> {
  const cur = await lockCredit(tx, id);
  if (cur.status !== 'draft')
    throw conflict(
      'credit_note_locked',
      'An approved credit note keeps its number and cannot be deleted.',
    );
  await tx`DELETE FROM credit_notes WHERE id = ${id}`;
  await audit(tx, auth, 'delete', 'credit_note', id);
}

/** Owner taps Approve: the next CN number, today's date, and the amount comes off the invoice. */
export async function approveCreditNote(
  tx: Tx,
  auth: Auth,
  id: string,
  expectedVersion?: number,
): Promise<CreditNoteDto & { jobCompleted: boolean }> {
  assertOwnerDecision(auth, 'approve a credit note');
  // Lock order: invoice first (as payments do), then the credit note.
  const [peek] = await tx<
    { invoiceId: string }[]
  >`SELECT invoice_id FROM credit_notes WHERE id = ${id}`;
  if (!peek) throw notFound('Credit note');
  const invLock = await lockInvoice(tx, peek.invoiceId);
  const cur = await lockCredit(tx, id);
  await assertVersion(expectedVersion, cur.version, () => getCreditNote(tx, id));
  if (cur.status !== 'draft')
    throw conflict('credit_note_not_draft', 'This credit note is already approved.');
  const inv = await getInvoice(tx, cur.invoiceId);
  const blocked = creditBlocker(inv);
  if (blocked) throw conflict('invoice_not_creditable', blocked);
  const amount = Number(cur.amountPence);
  if (amount > inv.balancePence) throw tooMuch(inv.balancePence);
  const [num] = await tx<
    { value: number; formatted: string }[]
  >`SELECT * FROM allocate_number('credit_note')`;
  const formatted = num!.formatted;
  const value = num!.value;
  const t = await today(tx);
  await tx`
    UPDATE credit_notes
       SET status = 'approved', number = ${formatted}, seq_value = ${value}, issue_date = ${t}::date,
           approved_by = ${auth.userId}, approved_at = now()
     WHERE id = ${id}`;
  const credited = inv.creditedPence + amount;
  const status = statusAfterPayment(inv.totalPence, inv.paidPence, credited);
  await tx`UPDATE invoices SET credited_pence = ${credited}, status = ${status} WHERE id = ${cur.invoiceId}`;
  await audit(tx, auth, 'approve', 'credit_note', id, {
    number: formatted,
    invoiceId: cur.invoiceId,
    amountPence: amount,
    invoiceStatus: { from: invLock.status, to: status },
  });
  const jobCompleted = status === 'paid' ? await completeJobIfSettled(tx, auth, inv.jobId) : false;
  return { ...(await getCreditNote(tx, id)), jobCompleted };
}
