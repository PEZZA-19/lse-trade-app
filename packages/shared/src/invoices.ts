import { z } from 'zod';
import { lineTotal, type Pence } from './money';

export const INVOICE_STATUSES = ['draft', 'approved', 'sent', 'part_paid', 'paid'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
/** What the app shows: the stored status, or "overdue" worked out from the due date. */
export type InvoiceDisplayStatus = InvoiceStatus | 'overdue';

export const INVOICE_STATUS_LABELS: Record<InvoiceDisplayStatus, string> = {
  draft: 'Draft',
  approved: 'Approved',
  sent: 'Sent',
  part_paid: 'Part paid',
  paid: 'Paid',
  overdue: 'Overdue',
};

export const QUOTE_INVOICE_MODES = ['whole', 'deposit', 'percent', 'remainder'] as const;
export type QuoteInvoiceMode = (typeof QUOTE_INVOICE_MODES)[number];

export const PAYMENT_METHODS = ['bank_transfer', 'cash', 'card', 'cheque', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  bank_transfer: 'Bank transfer',
  cash: 'Cash',
  card: 'Card',
  cheque: 'Cheque',
  other: 'Other',
};

export const INVOICE_LINE_KINDS = [
  'labour',
  'material',
  'carriage',
  'pc_sum',
  'deposit',
  'adjustment',
] as const;
export type InvoiceLineKind = (typeof INVOICE_LINE_KINDS)[number];

const isoDate = z.iso.date();

/** Create a draft invoice for a job: time and materials, or from its accepted quote. */
export const invoiceCreate = z.union([
  z.object({ source: z.literal('job') }),
  z.discriminatedUnion('mode', [
    z.object({ source: z.literal('quote'), mode: z.literal('whole') }),
    z.object({ source: z.literal('quote'), mode: z.literal('remainder') }),
    z.object({
      source: z.literal('quote'),
      mode: z.literal('deposit'),
      amountPence: z.number().int().min(1).max(100_000_000_00),
    }),
    z.object({
      source: z.literal('quote'),
      mode: z.literal('percent'),
      /** 1..99.99% in basis points; 100% is "whole". */
      percentBp: z.number().int().min(1).max(9999),
    }),
  ]),
]);
export type InvoiceCreate = z.input<typeof invoiceCreate>;

export const invoiceLineInput = z.object({
  kind: z.enum(INVOICE_LINE_KINDS),
  description: z.string().trim().min(1, 'Description is required').max(500),
  qtyMilli: z.number().int().min(-1_000_000_000).max(1_000_000_000),
  unitPricePence: z.number().int().min(-100_000_000_00).max(100_000_000_00),
  taxRateBp: z.number().int().min(0).max(10000).default(0),
});
export type InvoiceLineInput = z.input<typeof invoiceLineInput>;

/** Drafts only. */
export const invoiceUpdate = z.object({
  notes: z
    .string()
    .trim()
    .max(4000)
    .nullish()
    .transform((v) => (v ? v : null))
    .optional(),
  termsDays: z.number().int().min(0).max(365).optional(),
  lines: z.array(invoiceLineInput).min(1).max(500).optional(),
});
export type InvoiceUpdate = z.input<typeof invoiceUpdate>;

export const paymentCreate = z.object({
  amountPence: z.number().int().min(1).max(100_000_000_00),
  paidOn: isoDate,
  method: z.enum(PAYMENT_METHODS),
  reference: z
    .string()
    .trim()
    .max(200)
    .nullish()
    .transform((v) => (v ? v : null)),
});
export type PaymentCreate = z.input<typeof paymentCreate>;

/* -------------------------------- maths --------------------------------- */

/** 122 for the first invoice on job 122, then 122-2, 122-3... */
export function invoiceNumber(jobNumber: string, nth: number): string {
  if (!Number.isInteger(nth) || nth < 1) throw new Error('nth must be a positive integer');
  return nth === 1 ? jobNumber : `${jobNumber}-${nth}`;
}

/** Tax on a line total, rounded half up (half away from zero for credits). */
export function lineTax(totalPence: Pence, taxRateBp: number): Pence {
  const raw = (Math.abs(totalPence) * taxRateBp) / 10000;
  const t = Math.floor(raw + 0.5);
  return totalPence < 0 ? -t : t;
}

export function invoiceTotals(
  lines: { qtyMilli: number; unitPricePence: Pence; taxRateBp: number }[],
): { subtotalPence: Pence; taxPence: Pence; totalPence: Pence; lineTotals: Pence[] } {
  let subtotalPence = 0;
  let taxPence = 0;
  const lineTotals = lines.map((l) => {
    const t = signedLineTotal(l.qtyMilli, l.unitPricePence);
    subtotalPence += t;
    taxPence += lineTax(t, l.taxRateBp);
    return t;
  });
  return { subtotalPence, taxPence, totalPence: subtotalPence + taxPence, lineTotals };
}

/** lineTotal rounds up; for credit lines round the magnitude up so -£x.xx mirrors £x.xx. */
export function signedLineTotal(qtyMilli: number, unitPence: Pence): Pence {
  const neg = qtyMilli < 0 !== unitPence < 0 && qtyMilli !== 0 && unitPence !== 0;
  const t = lineTotal(Math.abs(qtyMilli), Math.abs(unitPence));
  return neg ? -t : t;
}

/** Percentage of an amount in basis points, rounded to the nearest penny. */
export function percentOf(amountPence: Pence, percentBp: number): Pence {
  return Math.round((amountPence * percentBp) / 10000);
}

/** Adds whole days to a yyyy-mm-dd date. */
export function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function displayStatus(
  inv: { status: InvoiceStatus; dueDate: string | null },
  todayIso: string,
): InvoiceDisplayStatus {
  if (
    (inv.status === 'sent' || inv.status === 'part_paid') &&
    inv.dueDate &&
    inv.dueDate < todayIso
  )
    return 'overdue';
  return inv.status;
}

/** Status after a payment is recorded. */
export function statusAfterPayment(totalPence: Pence, paidPence: Pence): InvoiceStatus {
  return paidPence >= totalPence ? 'paid' : 'part_paid';
}

export const DEFAULT_INVOICE_TERMS = (days: number) =>
  `Payment is due within ${days} days of the invoice date. Overdue balances may be charged interest at 5% per month.`;

/* --------------------------------- DTOs --------------------------------- */

export interface InvoiceLineDto {
  id: string;
  position: number;
  kind: InvoiceLineKind;
  description: string;
  qtyMilli: number;
  unitPricePence: Pence;
  totalPence: Pence;
  taxRateBp: number;
}

export interface PaymentDto {
  id: string;
  amountPence: Pence;
  paidOn: string;
  method: PaymentMethod;
  reference: string | null;
  recordedByName: string;
  createdAt: string;
}

export interface InvoiceSummaryDto {
  id: string;
  number: string | null;
  jobId: string;
  jobNumber: string;
  jobTitle: string;
  customerName: string;
  status: InvoiceStatus;
  displayStatus: InvoiceDisplayStatus;
  source: 'job' | 'quote';
  quoteMode: QuoteInvoiceMode | null;
  issueDate: string | null;
  dueDate: string | null;
  totalPence: Pence;
  paidPence: Pence;
  balancePence: Pence;
  createdAt: string;
  version: number;
}

export interface InvoiceDetailDto extends InvoiceSummaryDto {
  quoteNumber: string | null;
  termsDays: number;
  termsText: string;
  notes: string | null;
  subtotalPence: Pence;
  taxPence: Pence;
  billTo: { name: string; email: string | null; address: string | null };
  approvedByName: string | null;
  approvedAt: string | null;
  sentByName: string | null;
  sentAt: string | null;
  lines: InvoiceLineDto[];
  payments: PaymentDto[];
  /** Drafts: the number approving it now would give (another approval first would take it). */
  nextNumber: string | null;
  /** Why it can't be approved yet (settings or bill-to details missing). */
  approvalBlockers: string[];
}

/** What can still be invoiced on a job; drives the "New invoice" sheet. */
export interface JobInvoicingDto {
  jobId: string;
  quote: {
    id: string;
    number: string;
    totalPence: Pence;
    invoicedPence: Pence;
    remainingPence: Pence;
  } | null;
  /** Timer entries and job lines not yet on an invoice (time and materials). */
  unbilledMinutes: number;
  unbilledLabourPence: Pence;
  unbilledMaterialsPence: Pence;
  invoices: InvoiceSummaryDto[];
}
