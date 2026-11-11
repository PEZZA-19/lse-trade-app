import { z } from 'zod';

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

/** Accepts "12-34-56", "12 34 56" or "123456"; empty clears. */
const digitsField = (n: number, message: string) =>
  z
    .string()
    .nullish()
    .transform((v) => (v ?? '').replace(/[\s-]/g, ''))
    .refine((v) => v === '' || new RegExp(`^\\d{${n}}$`).test(v), message);

/** Number sequences a business can edit. Invoices/credit notes are gap-free (HMRC/States audit). */
export const EDITABLE_SEQUENCES = ['quote', 'job', 'invoice', 'credit_note'] as const;

export const sequenceUpdate = z.object({
  kind: z.enum(EDITABLE_SEQUENCES),
  // Letters, dash and slash only: a digit in the prefix could make two numbers look the same.
  prefix: z
    .string()
    .trim()
    .regex(/^[A-Za-z/-]{0,12}$/, 'Prefix can use letters, - and / (up to 12)'),
  padding: z.number().int().min(0).max(8),
  nextValue: z.number().int().min(1).max(99_999_999),
});
export type SequenceUpdate = z.infer<typeof sequenceUpdate>;

export const settingsUpdate = z
  .object({
    name: z.string().trim().min(1, 'Business name is required').max(160),
    legalName: optionalText(160),
    address: optionalText(500),
    phone: optionalText(40),
    email: z
      .union([z.email('Enter a valid email').trim().toLowerCase().max(254), z.literal('')])
      .nullish()
      .transform((v) => (v ? v : null)),
    labourRatePence: z.number().int().min(0).max(100_000_00),
    defaultMarkupBp: z.number().int().min(10000).max(100000),
    quoteValidDays: z.number().int().min(1).max(365),
    paymentTermsDays: z.number().int().min(0).max(120),
    /** Basis points. Guernsey/Sark have no VAT/GST, so 0 by default. */
    taxRateBp: z.number().int().min(0).max(10000),
    quoteTerms: optionalText(5000),
    invoiceTerms: optionalText(5000),
    bankAccountName: optionalText(80),
    bankSortCode: digitsField(6, 'Sort code is 6 digits').transform((v) =>
      v ? `${v.slice(0, 2)}-${v.slice(2, 4)}-${v.slice(4, 6)}` : null,
    ),
    bankAccountNumber: digitsField(8, 'Account number is 8 digits').transform((v) => v || null),
    sequences: z.array(sequenceUpdate).max(4),
  })
  .partial();
export type SettingsUpdate = z.input<typeof settingsUpdate>;

export interface SequenceDto {
  kind: (typeof EDITABLE_SEQUENCES)[number];
  prefix: string;
  padding: number;
  nextValue: number;
  gapsAllowed: boolean;
  /** Highest number already used; nextValue must stay above it. */
  lastUsed: number | null;
}

export interface SettingsDto {
  name: string;
  legalName: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  labourRatePence: number;
  defaultMarkupBp: number;
  quoteValidDays: number;
  paymentTermsDays: number;
  taxRateBp: number;
  quoteTerms: string | null;
  invoiceTerms: string | null;
  bankAccountName: string | null;
  bankSortCode: string | null;
  bankAccountNumber: string | null;
  currency: string;
  timezone: string;
  sequences: SequenceDto[];
}

export interface MissingItem {
  field: keyof SettingsDto;
  label: string;
}
export interface ReadinessDto {
  /** Everything needed before a quote can be marked as sent. */
  quote: { ready: boolean; missing: MissingItem[] };
  /** Everything needed before an invoice can be sent (bank details, terms). */
  invoice: { ready: boolean; missing: MissingItem[] };
}

type ReadinessInput = Pick<
  SettingsDto,
  | 'name'
  | 'address'
  | 'phone'
  | 'email'
  | 'labourRatePence'
  | 'bankAccountName'
  | 'bankSortCode'
  | 'bankAccountNumber'
>;

/**
 * Pre-send completeness check. Shared by the API (enforced) and the app (to explain, before tapping).
 * A customer should never receive a document without who it's from and how to reach them.
 */
export function readiness(s: ReadinessInput): ReadinessDto {
  const quoteMissing: MissingItem[] = [];
  if (!s.name?.trim()) quoteMissing.push({ field: 'name', label: 'Business name' });
  if (!s.address?.trim()) quoteMissing.push({ field: 'address', label: 'Business address' });
  if (!s.phone?.trim() && !s.email?.trim())
    quoteMissing.push({ field: 'phone', label: 'Phone or email' });
  if (!(s.labourRatePence > 0))
    quoteMissing.push({ field: 'labourRatePence', label: 'Labour rate' });
  const invoiceMissing = [...quoteMissing];
  if (!s.bankAccountName)
    invoiceMissing.push({ field: 'bankAccountName', label: 'Bank account name' });
  if (!s.bankSortCode) invoiceMissing.push({ field: 'bankSortCode', label: 'Sort code' });
  if (!s.bankAccountNumber)
    invoiceMissing.push({ field: 'bankAccountNumber', label: 'Account number' });
  return {
    quote: { ready: quoteMissing.length === 0, missing: quoteMissing },
    invoice: { ready: invoiceMissing.length === 0, missing: invoiceMissing },
  };
}
