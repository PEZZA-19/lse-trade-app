import type { InvoiceDisplayStatus, QuoteStatus } from '@lse/shared';
import type { Tone } from '../components/ui';

export const QUOTE_STATUS: Record<QuoteStatus, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'grey' },
  sent: { label: 'Sent', tone: 'blue' },
  accepted: { label: 'Accepted', tone: 'green' },
  converted: { label: 'Job created', tone: 'purple' },
  declined: { label: 'Declined', tone: 'red' },
  expired: { label: 'Expired', tone: 'orange' },
};

export const LINE_KIND_LABEL = {
  labour: 'Labour',
  material: 'Materials',
  carriage: 'Carriage',
  pc_sum: 'Allowance',
} as const;

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');

const dateFmt = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  timeZone: 'Europe/Guernsey',
});
export const shortDate = (iso: string) => dateFmt.format(new Date(iso));

export const INVOICE_STATUS: Record<InvoiceDisplayStatus, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'grey' },
  approved: { label: 'Approved', tone: 'indigo' },
  sent: { label: 'Sent', tone: 'blue' },
  part_paid: { label: 'Part paid', tone: 'orange' },
  paid: { label: 'Paid', tone: 'green' },
  credit: { label: 'Customer credit', tone: 'teal' },
  overdue: { label: 'Overdue', tone: 'red' },
};

export const todayIso = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Guernsey' }).format(new Date());

/** "Due 25 Nov", "Due today", "3 days overdue" for an unpaid invoice. */
export function dueLabel(inv: { status: string; dueDate: string | null }, today = todayIso()) {
  if (inv.status === 'draft') return 'Not approved yet';
  if (inv.status === 'paid') return 'Paid';
  if (inv.status === 'credit') return 'Comes off their next invoice';
  if (!inv.dueDate) return '';
  const days = Math.round((Date.parse(today) - Date.parse(inv.dueDate)) / 86_400_000);
  if (days > 0) return `${days} ${days === 1 ? 'day' : 'days'} overdue`;
  if (days === 0) return 'Due today';
  return `Due ${shortDate(`${inv.dueDate}T12:00:00Z`)}`;
}
