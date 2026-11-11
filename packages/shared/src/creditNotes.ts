/**
 * Customer credit notes: money taken off an issued invoice (a mistake, goodwill, work not done).
 * Drafted by anyone, approved by the owner, numbered on approval (CN-0001) so the sequence has no
 * gaps. Approving reduces the invoice balance; recorded payments are never changed. Nothing is
 * sent to the customer by the app: sharing the PDF is a separate, explicit tap.
 */
import { z } from 'zod';
import type { Pence } from './money';

export const creditNoteCreate = z.object({
  amountPence: z
    .number({ error: 'Enter the amount to credit' })
    .int()
    .min(1, 'Enter the amount to credit')
    .max(100_000_000_00),
  reason: z.string().trim().min(1, 'Say why, for the customer and your records').max(500),
});
export type CreditNoteCreate = z.input<typeof creditNoteCreate>;

export type CreditNoteStatus = 'draft' | 'approved';

export interface CreditNoteSummaryDto {
  id: string;
  number: string | null;
  status: CreditNoteStatus;
  issueDate: string | null;
  reason: string;
  amountPence: Pence;
}

export interface CreditNoteDto extends CreditNoteSummaryDto {
  invoiceId: string;
  invoiceNumber: string;
  invoiceTotalPence: Pence;
  /** What is still owed on the invoice now (before this credit, while it is a draft). */
  invoiceBalancePence: Pence;
  jobId: string;
  jobNumber: string;
  jobTitle: string;
  billTo: { name: string; email: string | null; address: string | null };
  approvedByName: string | null;
  approvedAt: string | null;
  createdAt: string;
  /** Drafts: the number approving it now would give. */
  nextNumber: string | null;
  version: number;
}

/** Plain-English reason a credit can't be raised on an invoice, or null if it can. */
export function creditBlocker(inv: { status: string; balancePence: Pence }): string | null {
  if (inv.status === 'draft' || inv.status === 'approved')
    return 'A draft or unsent invoice can still be changed: edit or delete it instead.';
  if (inv.balancePence <= 0)
    return 'Nothing is owed on this invoice. Refunds of money already paid come later.';
  return null;
}
