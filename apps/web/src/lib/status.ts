import type { JobStatus, QuoteStatus } from '@lse/shared';
import type { Tone } from '../components/ui';

export const QUOTE_STATUS: Record<QuoteStatus, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'grey' },
  sent: { label: 'Sent', tone: 'blue' },
  accepted: { label: 'Accepted', tone: 'green' },
  converted: { label: 'Job created', tone: 'purple' },
  declined: { label: 'Declined', tone: 'red' },
  expired: { label: 'Expired', tone: 'orange' },
};

export const JOB_STATUS: Record<JobStatus, { label: string; tone: Tone }> = {
  open: { label: 'To do', tone: 'blue' },
  scheduled: { label: 'Booked in', tone: 'purple' },
  in_progress: { label: 'In progress', tone: 'orange' },
  completed: { label: 'Done', tone: 'green' },
  cancelled: { label: 'Cancelled', tone: 'grey' },
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
