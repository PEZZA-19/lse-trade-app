/** System prompts and answer shapes for each AI helper. Drafts only; Joe decides. */
import { z } from 'zod';

const money = z.number().int().min(0).max(100_000_000);

export const BILL_READ_SYSTEM = `You read supplier invoices for a small electrical business.
Return JSON only: {"supplier","reference","billDate":"YYYY-MM-DD"|null,"dueDate":"YYYY-MM-DD"|null,
"orderNumber"|null,"yourReference"|null,"kind":"bill"|"credit_note","lines":[{"qty":number,"code"|null,
"description","unitPricePence":int,"discountPercent":number,"totalPence":int}],"goodsPence":int|null,
"vatPence":int|null,"totalPence":int|null}. Copy numbers exactly as printed. If unsure, leave null.`;

export const aiBillAnswer = z.object({
  supplier: z.string().min(1).max(100),
  reference: z.string().max(100),
  billDate: z.iso.date().nullable(),
  dueDate: z.iso.date().nullable(),
  orderNumber: z.string().max(100).nullable(),
  yourReference: z.string().max(100).nullable(),
  kind: z.enum(['bill', 'credit_note']),
  lines: z
    .array(
      z.object({
        qty: z.number().positive().max(1_000_000),
        code: z.string().max(60).nullable(),
        description: z.string().min(1).max(300),
        unitPricePence: money,
        discountPercent: z.number().min(0).max(100),
        totalPence: money,
      }),
    )
    .max(200),
  goodsPence: money.nullable(),
  vatPence: money.nullable(),
  totalPence: money.nullable(),
});
export type AiBillAnswer = z.infer<typeof aiBillAnswer>;

export const REPLY_SYSTEM = `You draft short, friendly replies for a one-man electrical business
on Sark. Plain British English, no jargon, no promises about price or dates that are not in the
input, no sign-off (the email account adds the signature). Return JSON only: {"subject","body"}.`;

export const REMINDER_SYSTEM = `You draft a polite payment reminder for an overdue invoice. Be warm and
brief; state the invoice number, amount and due date exactly as given; no threats, no sign-off.
Return JSON only: {"subject","body"}.`;

export const emailAnswer = z.object({
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(5000),
});
export type EmailAnswer = z.infer<typeof emailAnswer>;

export const QUOTE_SYSTEM = `You turn a customer enquiry into a first-draft quote for an
electrician. Use only price-list items given in the input (by id); add labour as hours. Return
JSON only: {"title","lines":[{"itemId"|null,"kind":"material"|"labour","description","qty":number}],
"notes"}. Leave anything uncertain out and say so in notes.`;

export const quoteAnswer = z.object({
  title: z.string().min(1).max(200),
  lines: z
    .array(
      z.object({
        itemId: z.uuid().nullable(),
        kind: z.enum(['material', 'labour']),
        description: z.string().min(1).max(300),
        qty: z.number().positive().max(10_000),
      }),
    )
    .max(50),
  notes: z.string().max(2000),
});
export type QuoteAnswer = z.infer<typeof quoteAnswer>;
