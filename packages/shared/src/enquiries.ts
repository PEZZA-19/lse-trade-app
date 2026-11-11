/**
 * Enquiries: new work asking to happen. They arrive from the website form or are typed in after
 * a call. Each one sits in To Do until it is turned into a quote, a job or an appointment,
 * marked actioned, or rejected.
 */
import { z } from 'zod';

export const ENQUIRY_SOURCES = ['manual', 'phone', 'email', 'web_form'] as const;
export type EnquirySource = (typeof ENQUIRY_SOURCES)[number];
export const ENQUIRY_SOURCE_LABELS: Record<EnquirySource, string> = {
  manual: 'In person',
  phone: 'Phone',
  email: 'Email',
  web_form: 'Website',
};
export const ENQUIRY_STATUSES = ['todo', 'actioned', 'converted', 'rejected'] as const;
export type EnquiryStatus = (typeof ENQUIRY_STATUSES)[number];
export const CONVERT_TARGETS = ['quote', 'job', 'appointment'] as const;
export type ConvertTarget = (typeof CONVERT_TARGETS)[number];

const text = (max: number) => z.string().trim().max(max);
const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));
const email = z
  .string()
  .trim()
  .max(254)
  .nullish()
  .transform((v) => (v ? v.toLowerCase() : null))
  .refine((v) => v === null || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'Enter a valid email');

const contact = {
  name: text(120).min(1, 'Name is required'),
  email,
  phone: optional(40),
  address: optional(300),
  message: text(5000).min(1, 'What do they need?'),
};

/** Typed in by Joe or staff. */
export const enquiryCreate = z
  .object({ ...contact, source: z.enum(['manual', 'phone', 'email']).default('phone') })
  .refine((v) => v.email || v.phone, {
    message: 'Add a phone number or email so you can get back to them',
    path: ['phone'],
  });
export type EnquiryCreate = z.input<typeof enquiryCreate>;

/** From the public website form. Spam checks use the extra fields; they are never stored. */
export const publicEnquiry = z.object({
  ...contact,
  /** Honeypot: hidden from people, filled in by bots. */
  website: z.string().max(500).optional(),
  /** When the form was shown (ms since epoch): real people take a few seconds. */
  startedAt: z.number().int().positive().optional(),
  /** Cloudflare Turnstile token. */
  turnstileToken: z.string().max(4096).optional(),
});
export type PublicEnquiry = z.input<typeof publicEnquiry>;

export const enquiryReject = z.object({ reason: optional(500) });

export const enquiryConvert = z.discriminatedUnion('to', [
  z.object({ to: z.literal('quote'), title: text(200).optional() }),
  z.object({ to: z.literal('job'), title: text(200).optional() }),
  z.object({
    to: z.literal('appointment'),
    title: text(200).optional(),
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }),
  }),
]);
export type EnquiryConvert = z.input<typeof enquiryConvert>;

export interface EnquiryDto {
  id: string;
  source: EnquirySource;
  status: EnquiryStatus;
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  message: string;
  customerId: string | null;
  customerName: string | null;
  convertedTo: ConvertTarget | null;
  quoteId: string | null;
  jobId: string | null;
  appointmentId: string | null;
  rejectReason: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  createdAt: string;
  version: number;
}

export interface EnquiryFormDto {
  formKey: string | null;
  /** Path to POST the form to, relative to the API origin. */
  endpoint: string | null;
}

/** Short title from the first sentence of a message. */
export function enquiryTitle(message: string): string {
  const first = message.trim().split(/(?<=[.!?])\s|\n/)[0] ?? '';
  const t = first.replace(/[.!?]+$/, '').trim();
  return (t.length > 80 ? `${t.slice(0, 77).trimEnd()}…` : t) || 'New enquiry';
}

/** Cheap spam signals for the public form. Returns a reason to drop, or null. */
export function spamReason(input: z.output<typeof publicEnquiry>, now = Date.now()): string | null {
  if (input.website) return 'honeypot';
  if (input.startedAt !== undefined) {
    const took = now - input.startedAt;
    if (took < 3000) return 'too_fast';
    if (took > 24 * 3600_000) return 'stale_form';
  }
  const links = (input.message.match(/https?:\/\/|www\./gi) ?? []).length;
  if (links > 2) return 'links';
  return null;
}
