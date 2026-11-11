import { z } from 'zod';
import { SYSTEM_STAGE_KEYS } from './stages';

/* ----------------------------- primitives ----------------------------- */

export const id = z.uuid();
const trimmed = (max: number) => z.string().trim().max(max);
/** Optional free text: empty strings become null so the database never stores "". */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));
const pence = z.number().int().min(-100_000_000_00).max(100_000_000_00);
const qtyMilli = z.number().int().min(-1_000_000_000).max(1_000_000_000);
/** Markup multiplier in basis points, 1.0x..10x. */
const markupBp = z.number().int().min(10000).max(100000);

/* ----------------------------- customers ------------------------------ */

export const siteInput = z.object({
  label: optionalText(80),
  address: trimmed(500).min(1, 'Address is required'),
  notes: optionalText(2000),
});
export type SiteInput = z.input<typeof siteInput>;

export const CONTACT_ROLES = [
  'bill_payer',
  'site_contact',
  'tenant',
  'landlord',
  'agent',
  'managing_agent',
  'other',
] as const;
export const contactRole = z.enum(CONTACT_ROLES);
export type ContactRole = z.infer<typeof contactRole>;
/** Plain-English labels for the UI. */
export const CONTACT_ROLE_LABELS: Record<ContactRole, string> = {
  bill_payer: 'Pays the bills',
  site_contact: 'On-site contact',
  tenant: 'Tenant',
  landlord: 'Landlord',
  agent: 'Letting agent',
  managing_agent: 'Managing agent',
  other: 'Other',
};

const email = z
  .string()
  .trim()
  .max(254)
  .nullish()
  .transform((v) => (v ? v.toLowerCase() : null))
  .pipe(z.email('Enter a valid email').nullable());

export const contactInput = z.object({
  name: trimmed(160).min(1, 'Name is required'),
  role: contactRole.default('other'),
  siteId: id.nullish().transform((v) => v ?? null),
  email,
  phone: optionalText(40),
  notes: optionalText(2000),
});
export type ContactInput = z.input<typeof contactInput>;

export const customerInput = z.object({
  name: trimmed(160).min(1, 'Name is required'),
  email,
  phone: optionalText(40),
  billingAddress: optionalText(500),
  notes: optionalText(4000),
  markupBp: markupBp.nullish().transform((v) => v ?? null),
});
export type CustomerInput = z.input<typeof customerInput>;
export const customerCreate = customerInput.extend({
  sites: z.array(siteInput).max(50).default([]),
  /** Contacts created with the customer; siteIndex links one to a site in `sites`. */
  contacts: z
    .array(
      contactInput.omit({ siteId: true }).extend({ siteIndex: z.number().int().min(0).nullish() }),
    )
    .max(50)
    .default([]),
});
export type CustomerCreate = z.input<typeof customerCreate>;
export const customerUpdate = customerInput.partial();

/* ------------------------------- quotes ------------------------------- */

export const LINE_KINDS = ['labour', 'material', 'carriage', 'pc_sum'] as const;
export const lineKind = z.enum(LINE_KINDS);

export const quoteLineInput = z.object({
  kind: lineKind,
  description: trimmed(500).min(1, 'Description is required'),
  qtyMilli: qtyMilli.default(1000),
  unitCostPence: pence.nullish().transform((v) => v ?? null),
  markupBp: markupBp.nullish().transform((v) => v ?? null),
  unitPricePence: pence.nullish().transform((v) => v ?? null),
  optionLabel: optionalText(80),
  taxRateBp: z.number().int().min(0).max(10000).default(0),
});
export type QuoteLineInput = z.input<typeof quoteLineInput>;

export const QUOTE_STATUSES = [
  'draft',
  'sent',
  'accepted',
  'converted',
  'declined',
  'expired',
] as const;
export const quoteStatus = z.enum(QUOTE_STATUSES);
export type QuoteStatus = z.infer<typeof quoteStatus>;

export const quoteCreate = z.object({
  customerId: id,
  siteId: id.nullish().transform((v) => v ?? null),
  title: trimmed(200).min(1, 'Give the quote a short title'),
  notes: optionalText(4000),
  validDays: z.number().int().min(1).max(365).default(30),
  lines: z.array(quoteLineInput).max(500).default([]),
});
export type QuoteCreate = z.input<typeof quoteCreate>;

/** Replaces the editable content of the current (draft) revision. */
export const quoteRevisionUpdate = z.object({
  title: trimmed(200).min(1).optional(),
  siteId: id.nullish(),
  notes: optionalText(4000).optional(),
  validDays: z.number().int().min(1).max(365).optional(),
  lines: z.array(quoteLineInput).max(500).optional(),
});
export type QuoteRevisionUpdate = z.input<typeof quoteRevisionUpdate>;

export const quoteAccept = z.object({
  acceptedOptions: z.array(trimmed(80).min(1)).max(50).default([]),
});

/* -------------------------------- jobs -------------------------------- */

export const PLACES_OF_WORK = ['sark', 'guernsey', 'other'] as const;

export const jobCreate = z.object({
  customerId: id,
  siteId: id.nullish().transform((v) => v ?? null),
  title: trimmed(200).min(1, 'Give the job a short title'),
  description: optionalText(4000),
  placeOfWork: z.enum(PLACES_OF_WORK).default('sark'),
});
export type JobCreate = z.input<typeof jobCreate>;

export const jobUpdate = z.object({
  title: trimmed(200).min(1).optional(),
  description: optionalText(4000).optional(),
  /** Manual stage change: by id (any stage, incl. custom) or by system key. */
  stageId: id.optional(),
  stageKey: z.enum(SYSTEM_STAGE_KEYS).optional(),
  siteId: id.nullish(),
  placeOfWork: z.enum(PLACES_OF_WORK).optional(),
});

/* ------------------------------- paging ------------------------------- */

export const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
