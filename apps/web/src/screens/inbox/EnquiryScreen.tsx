import { ENQUIRY_SOURCE_LABELS, type ProposalDto } from '@lse/shared';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMe } from '../../api/hooks';
import { useDraft, useEnquiry, useEnquiryAction } from '../../api/inbox';
import { IconTray } from '../../components/icons';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import {
  Button,
  EmptyState,
  KeyValueRow,
  List,
  ListSkeleton,
  Page,
  Section,
  TextAreaField,
  TextField,
} from '../../components/ui';
import { shortDate } from '../../lib/status';
import { fromInputs, toDateInput } from '../../lib/dates';

/** One enquiry: the message, and what to do with it. */
export function EnquiryScreen() {
  const { id = '' } = useParams();
  const q = useEnquiry(id);
  const me = useMe();
  const navigate = useNavigate();
  const toast = useToast();
  const [sheet, setSheet] = useState<'reject' | 'appointment' | null>(null);
  const action = useEnquiryAction(q.data ?? { id, version: 0 });
  const draft = useDraft();
  if (q.isPending)
    return (
      <Page title="Enquiry" back={{ label: 'Enquiries', to: '/enquiries' }}>
        <ListSkeleton />
      </Page>
    );
  if (q.isError)
    return (
      <Page title="Enquiry" back={{ label: 'Enquiries', to: '/enquiries' }}>
        <EmptyState
          icon={<IconTray />}
          title="Couldn’t load the enquiry"
          message={q.error.message}
        />
      </Page>
    );
  const e = q.data;
  const todo = e.status === 'todo';
  const isOwner = me.data?.role === 'owner';

  const convert = (to: 'quote' | 'job') =>
    action.mutate(
      { kind: 'convert', input: { to } },
      {
        onSuccess: (r) => {
          toast.show(to === 'quote' ? 'Draft quote created' : 'Job created');
          navigate(to === 'quote' ? `/quotes/${r.quoteId}` : `/jobs/${r.jobId}`);
        },
      },
    );
  const ask = (path: string, what: string) =>
    draft.mutate(path, {
      onSuccess: (p) => {
        toast.show(`${what} drafted: it’s waiting in Approvals`);
        navigate(`/approvals/${(p as ProposalDto).id}`);
      },
    });

  return (
    <Page
      title={e.name}
      subtitle={`${ENQUIRY_SOURCE_LABELS[e.source]} · ${shortDate(e.createdAt)}`}
      back={{ label: 'Enquiries', to: '/enquiries' }}
    >
      <Section header="Message">
        <p className="message-block">{e.message}</p>
      </Section>
      <Section header="Contact">
        <List className="form-list" label="Contact">
          {e.phone && (
            <KeyValueRow label="Phone" value={<a href={`tel:${e.phone}`}>{e.phone}</a>} />
          )}
          {e.email && (
            <KeyValueRow label="Email" value={<a href={`mailto:${e.email}`}>{e.email}</a>} />
          )}
          {e.address && <KeyValueRow label="Address" value={e.address} />}
          {e.customerId && (
            <KeyValueRow
              label="Customer"
              value={<Link to={`/customers/${e.customerId}`}>{e.customerName}</Link>}
            />
          )}
        </List>
      </Section>
      {todo ? (
        <>
          <Section
            header="Turn it into"
            footer="Finds the customer by email or phone, or adds them."
          >
            <div className="button-stack">
              <Button
                variant="primary"
                block
                onClick={() => convert('quote')}
                loading={action.isPending && action.variables?.kind === 'convert'}
              >
                Quote
              </Button>
              <Button variant="secondary" block onClick={() => convert('job')}>
                Job
              </Button>
              <Button variant="secondary" block onClick={() => setSheet('appointment')}>
                Appointment…
              </Button>
            </div>
          </Section>
          <Section
            header="AI helper"
            footer="Drafts only. Each one waits in Approvals for the owner to approve, edit or discard."
          >
            <div className="button-stack">
              <Button
                variant="secondary"
                block
                disabled={!e.email}
                onClick={() => ask(`/enquiries/${e.id}/draft-reply`, 'Reply')}
                loading={draft.isPending && draft.variables?.endsWith('reply')}
              >
                {e.email ? 'Draft a Reply' : 'Draft a Reply (needs an email)'}
              </Button>
              <Button
                variant="secondary"
                block
                onClick={() => ask(`/enquiries/${e.id}/draft-quote`, 'Quote')}
                loading={draft.isPending && draft.variables?.endsWith('quote')}
              >
                Draft a Quote
              </Button>
            </div>
            {draft.isError && (
              <p className="field-error" role="alert">
                {draft.error.message}
              </p>
            )}
          </Section>
          <Section>
            <div className="button-stack">
              <Button
                variant="plain"
                block
                onClick={() =>
                  action.mutate(
                    { kind: 'actioned' },
                    { onSuccess: () => toast.show('Marked actioned') },
                  )
                }
              >
                Mark Actioned
              </Button>
              <Button variant="destructive" block onClick={() => setSheet('reject')}>
                Reject…
              </Button>
            </div>
          </Section>
        </>
      ) : (
        <Section header="Outcome">
          <List className="form-list" label="Outcome">
            <KeyValueRow
              label={
                e.status === 'converted'
                  ? `Turned into a ${e.convertedTo}`
                  : e.status === 'rejected'
                    ? 'Rejected'
                    : 'Actioned'
              }
              value={`${e.decidedByName ?? ''}${e.decidedAt ? ` · ${shortDate(e.decidedAt)}` : ''}`}
            />
            {e.rejectReason && <KeyValueRow label="Reason" value={e.rejectReason} />}
            {e.quoteId && (
              <KeyValueRow
                label="Quote"
                value={<Link to={`/quotes/${e.quoteId}`}>Open quote</Link>}
              />
            )}
            {e.jobId && (
              <KeyValueRow label="Job" value={<Link to={`/jobs/${e.jobId}`}>Open job</Link>} />
            )}
          </List>
        </Section>
      )}
      {action.isError && (
        <p className="field-error" role="alert">
          {action.error.message}
        </p>
      )}
      {!isOwner && todo && (
        <p className="sheet-hint">
          Anyone in the business can deal with enquiries; AI drafts still need the owner.
        </p>
      )}
      {sheet === 'reject' && (
        <RejectSheet
          onClose={() => setSheet(null)}
          onReject={(reason) =>
            action.mutate(
              { kind: 'reject', reason },
              {
                onSuccess: () => {
                  setSheet(null);
                  toast.show('Enquiry rejected');
                },
              },
            )
          }
          busy={action.isPending}
        />
      )}
      {sheet === 'appointment' && (
        <AppointmentFromEnquiry
          busy={action.isPending}
          onClose={() => setSheet(null)}
          onBook={(startsAt, endsAt) =>
            action.mutate(
              { kind: 'convert', input: { to: 'appointment', startsAt, endsAt } },
              {
                onSuccess: (r) => {
                  setSheet(null);
                  toast.show('Job created and booked in');
                  navigate(`/jobs/${r.jobId}`);
                },
              },
            )
          }
        />
      )}
    </Page>
  );
}

function RejectSheet(props: {
  onClose: () => void;
  onReject: (reason: string | null) => void;
  busy: boolean;
}) {
  const [reason, setReason] = useState('');
  return (
    <Sheet
      open
      title="Reject Enquiry"
      onClose={props.onClose}
      action={
        <Button
          variant="plain"
          onClick={() => props.onReject(reason.trim() || null)}
          loading={props.busy}
          style={{ fontWeight: 600, color: 'var(--red)' }}
        >
          Reject
        </Button>
      }
    >
      <Section footer="Only you see the reason. Nothing is sent to them.">
        <List className="form-list">
          <TextAreaField
            label="Reason (optional)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            data-autofocus
          />
        </List>
      </Section>
    </Sheet>
  );
}

function AppointmentFromEnquiry(props: {
  onClose: () => void;
  onBook: (s: string, e: string) => void;
  busy: boolean;
}) {
  const [date, setDate] = useState(() => toDateInput(new Date(Date.now() + 86_400_000)));
  const [start, setStart] = useState('09:00');
  const [end, setEnd] = useState('10:00');
  const s = fromInputs(date, start);
  const en = fromInputs(date, end);
  const ok = s && en && en > s;
  return (
    <Sheet
      open
      title="Book a Visit"
      onClose={props.onClose}
      action={
        <Button
          variant="plain"
          disabled={!ok}
          loading={props.busy}
          onClick={() => ok && props.onBook(s.toISOString(), en.toISOString())}
          style={{ fontWeight: 600 }}
        >
          Book
        </Button>
      }
    >
      <Section footer="Creates the customer (if new) and a job, booked in at this time.">
        <List className="form-list">
          <TextField
            label="Date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          <TextField
            label="Starts"
            type="time"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
          <TextField
            label="Ends"
            type="time"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            error={ok ? undefined : 'The end must be after the start'}
          />
        </List>
      </Section>
    </Sheet>
  );
}
