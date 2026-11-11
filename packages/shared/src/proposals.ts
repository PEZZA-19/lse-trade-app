/**
 * The approvals inbox. AI helpers (and rule-based ones) only ever write proposals: a draft that
 * says what it will do. The owner approves, edits or discards each one. Approved emails wait
 * two minutes, with a Stop button, before they go.
 */
import { z } from 'zod';

export const PROPOSAL_KINDS = [
  'reply_email',
  'overdue_reminder',
  'quote_draft',
  'price_update',
] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];
export const PROPOSAL_STATUSES = [
  'pending',
  'held',
  'sent',
  'send_blocked',
  'applied',
  'discarded',
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];
export const EMAIL_KINDS: ProposalKind[] = ['reply_email', 'overdue_reminder'];
export const HOLD_SECONDS = 120;

export const PROPOSAL_KIND_LABELS: Record<ProposalKind, string> = {
  reply_email: 'Reply',
  overdue_reminder: 'Payment reminder',
  quote_draft: 'Quote draft',
  price_update: 'Price update',
};

export type EmailPayload = { to: string; toName: string; subject: string; body: string };
export type QuoteDraftPayload = {
  enquiryId: string;
  customerName: string;
  title: string;
  lines: {
    itemId: string | null;
    kind: 'material' | 'labour';
    description: string;
    qtyMilli: number;
    unitPricePence: number | null;
  }[];
  notes: string;
};
export type PriceUpdatePayload = {
  billId: string;
  billLabel: string;
  changes: { description: string; oldCostPence: number | null; newCostPence: number }[];
  jobNumber: string | null;
  jobLines: number;
};

export interface ProposalEventDto {
  event:
    | 'created'
    | 'edited'
    | 'approved'
    | 'stopped'
    | 'sent'
    | 'send_blocked'
    | 'applied'
    | 'discarded';
  byName: string | null;
  data: unknown;
  at: string;
}

export interface ProposalDto {
  id: string;
  agent: string;
  kind: ProposalKind;
  status: ProposalStatus;
  title: string;
  /** What approving will do, in plain words. */
  summary: string;
  payload: EmailPayload | QuoteDraftPayload | PriceUpdatePayload;
  sourceType: string | null;
  sourceId: string | null;
  /** The model that drafted it ("fake" in tests and the preview), or null for rule-based helpers. */
  drafter: string | null;
  holdUntil: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  result: unknown;
  createdAt: string;
  version: number;
  events?: ProposalEventDto[];
}

export const proposalEdit = z.union([
  z.object({
    subject: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(5000),
  }),
  z.object({
    title: z.string().trim().min(1).max(200),
    lines: z
      .array(
        z.object({
          itemId: z.uuid().nullable(),
          kind: z.enum(['material', 'labour']),
          description: z.string().trim().min(1).max(300),
          qtyMilli: z.number().int().min(1).max(10_000_000),
          unitPricePence: z.number().int().min(0).nullable(),
        }),
      )
      .max(50),
  }),
]);
export type ProposalEdit = z.input<typeof proposalEdit>;

export interface ProposalCountsDto {
  pending: number;
  held: number;
}
