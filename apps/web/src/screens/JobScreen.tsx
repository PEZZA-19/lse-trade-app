import {
  formatMinutes,
  formatPence,
  formatQty,
  STAGE_CAUSE_LABEL,
  type JobLineDto,
} from '@lse/shared';
import { useState } from 'react';
import { Elapsed, TimerButton } from '../components/Timer';
import { formatDayShort, formatRange, formatTime } from '../lib/dates';
import { AppointmentSheet, type AppointmentSheetState } from './sheets/AppointmentSheet';
import { AssignSheet } from './sheets/AssignSheet';
import { JobInvoicesSection } from './invoices/JobInvoicesSection';
import { QuoteVsActual } from './job/QuoteVsActual';
import { useParams } from 'react-router';
import { useJob, useJobStages, useMembers } from '../api/hooks';
import { StageDot, StagePill, useChangeStage } from '../components/Stage';
import { formatDateTime } from './syncFormat';
import { IconCalendar, IconJobs, IconQuotes } from '../components/icons';
import {
  Button,
  ButtonRow,
  EmptyState,
  KeyValueRow,
  LinkRow,
  List,
  ListSkeleton,
  Page,
  Section,
  SelectField,
  StaticRow,
} from '../components/ui';
import { initials, LINE_KIND_LABEL } from '../lib/status';

const PLACE = { sark: 'Sark', guernsey: 'Guernsey', other: 'Elsewhere' } as const;

export function JobScreen() {
  const { id = '' } = useParams();
  const job = useJob(id);
  const stages = useJobStages();
  const members = useMembers();
  const memberName = (id: string) => members.data?.find((m) => m.userId === id)?.name ?? 'Someone';
  const [assigning, setAssigning] = useState(false);
  const [booking, setBooking] = useState<AppointmentSheetState | null>(null);
  const { change, pendingId, set } = useChangeStage();

  if (job.isPending)
    return (
      <Page title="" back={{ label: 'Jobs', to: '/jobs' }}>
        <ListSkeleton rows={3} />
      </Page>
    );
  if (job.isError)
    return (
      <Page title="Job" back={{ label: 'Jobs', to: '/jobs' }}>
        <EmptyState
          icon={<IconJobs />}
          title="Couldn’t load this job"
          message={job.error.message}
          action={<Button onClick={() => job.refetch()}>Try again</Button>}
        />
      </Page>
    );
  const j = job.data;
  const quoted = j.lines.filter((l) => l.source === 'quote');
  const extra = j.lines.filter((l) => l.source !== 'quote');
  const pending = pendingId === j.id ? set.variables?.stage : undefined;
  // The job's own stage is always listed, even before the stage list has loaded.
  const options = stages.data?.some((s) => s.id === j.stage.id)
    ? stages.data
    : [j.stage, ...(stages.data ?? [])];

  return (
    <Page title={`Job ${j.number}`} subtitle={j.title} back={{ label: 'Jobs', to: '/jobs' }}>
      <div className="hero">
        <div
          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}
        >
          <StagePill stage={pending ?? j.stage} />
          {pending && <span className="save-status save-status--pending">Saving…</span>}
        </div>
        <div className="hero__meta">
          {[j.customerName, j.site?.address, PLACE[j.placeOfWork]].filter(Boolean).join(' · ')}
        </div>
      </div>

      <Section header="Stage">
        <List className="form-list">
          <SelectField
            label="Stage"
            value={pending?.id ?? j.stage.id}
            disabled={!!pending}
            onChange={(e) => {
              const to = options.find((s) => s.id === e.target.value);
              if (to) change(j, to);
            }}
          >
            {options.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </SelectField>
        </List>
      </Section>

      <Section
        header="Timer"
        footer={
          j.totalMinutes
            ? `Total time on this job: ${formatMinutes(j.totalMinutes)}`
            : 'Starting the timer moves the job to In Progress. Works with no signal.'
        }
      >
        <List>
          <li>
            <div className="row">
              <span className="row__main">
                {j.timerRunning && j.timerStartedAt ? (
                  <>
                    <Elapsed startedAt={j.timerStartedAt} />
                    <span className="row__sub">Started {formatTime(j.timerStartedAt)}</span>
                  </>
                ) : (
                  <span className="row__title">Not running</span>
                )}
              </span>
              <TimerButton compact job={j} />
            </div>
          </li>
        </List>
      </Section>

      <Section header="Assigned to">
        <List label="Assigned to">
          {j.assignees.map((a) => (
            <li key={a.userId}>
              <StaticRow>
                <span className="row__lead" aria-hidden>
                  {initials(a.name)}
                </span>
                <span className="row__main">
                  <span className="row__title">{a.name}</span>
                </span>
              </StaticRow>
            </li>
          ))}
          <li>
            <ButtonRow
              onClick={() => setAssigning(true)}
              title={
                <span style={{ color: 'var(--accent)' }}>
                  {j.assignees.length ? 'Change…' : 'Assign someone…'}
                </span>
              }
            />
          </li>
        </List>
      </Section>

      <Section header="Appointments">
        <List label="Appointments">
          {j.appointments.map((a) => (
            <li key={a.id}>
              <ButtonRow
                onClick={() =>
                  setBooking({
                    mode: 'edit',
                    appointment: { ...a, jobNumber: j.number, jobTitle: j.title },
                  })
                }
                lead={
                  <IconCalendar
                    width={22}
                    height={22}
                    color="var(--accent)"
                    style={{ marginRight: 12 }}
                  />
                }
                title={formatDayShort(new Date(a.startsAt))}
                sub={`${formatRange(a.startsAt, a.endsAt)}${a.userId ? ` · ${memberName(a.userId)}` : ''}`}
                chevron
              />
            </li>
          ))}
          <li>
            <ButtonRow
              onClick={() =>
                setBooking({ mode: 'create', jobId: j.id, jobLabel: `job ${j.number}` })
              }
              title={<span style={{ color: 'var(--accent)' }}>Book appointment…</span>}
            />
          </li>
        </List>
      </Section>

      {j.timesheets.length > 0 && (
        <Section header="Time" footer={`${formatMinutes(j.totalMinutes)} in total`}>
          <List label="Timesheet entries">
            {j.timesheets.map((t) => (
              <li key={t.id}>
                <KeyValueRow
                  label={`${formatDayShort(new Date(t.startedAt))} · ${formatRange(t.startedAt, t.endedAt)} · ${t.userName}`}
                  value={formatMinutes(t.minutes)}
                />
              </li>
            ))}
          </List>
        </Section>
      )}

      <JobInvoicesSection jobId={j.id} />

      <Section header="Customer">
        <List>
          <li>
            <LinkRow
              to={`/customers/${j.customerId}`}
              title={j.customerName}
              sub={
                j.site
                  ? j.site.label
                    ? `${j.site.label}: ${j.site.address}`
                    : j.site.address
                  : 'No site'
              }
            />
          </li>
          {j.sourceQuoteId && (
            <li>
              <LinkRow
                to={`/quotes/${j.sourceQuoteId}`}
                lead={<IconQuotes width={22} height={22} color="var(--accent)" />}
                title={`From quote ${j.sourceQuoteNumber}${j.sourceQuoteRevision && j.sourceQuoteRevision > 1 ? ` rev ${String.fromCharCode(64 + j.sourceQuoteRevision)}` : ''}`}
                sub="What was quoted is kept below as the plan"
              />
            </li>
          )}
        </List>
      </Section>

      {j.description && (
        <Section header="Notes">
          <List>
            <li>
              <div className="row" style={{ whiteSpace: 'pre-wrap' }}>
                {j.description}
              </div>
            </li>
          </List>
        </Section>
      )}

      {quoted.length > 0 && (
        <Section
          header="Quoted work"
          footer="Invoice it from Invoices above: whole, a deposit, a percentage or the rest."
        >
          <List>
            {quoted.map((l) => (
              <JobLineRow key={l.id} line={l} />
            ))}
            <li>
              <KeyValueRow label="Quoted total" value={formatPence(j.quotedTotalPence)} strong />
            </li>
          </List>
        </Section>
      )}

      <Section
        header="Materials and extras"
        footer="From supplier bills and by hand. On a time-and-materials invoice these are billed at the sell price shown."
      >
        <List>
          {extra.map((l) => (
            <JobLineRow key={l.id} line={l} />
          ))}
          {extra.length > 0 && (
            <li>
              <KeyValueRow
                label="Total"
                value={formatPence(extra.reduce((a, l) => a + l.totalPence, 0))}
                strong
              />
            </li>
          )}
          <li>
            <LinkRow
              to="/bills"
              title="Supplier Bills"
              sub="Enter a bill and pick this job to add its materials"
            />
          </li>
        </List>
      </Section>

      <QuoteVsActual jobId={j.id} />

      {j.history.length > 0 && (
        <Section header="History" footer="Every stage change, automatic or by hand.">
          <List label="Stage history">
            {[...j.history].reverse().map((h) => (
              <li key={h.id}>
                <StaticRow>
                  <StageDot colour={h.toColour} />
                  <span className="row__main">
                    <span className="row__title">
                      {h.fromName ? `${h.fromName} → ${h.toName}` : h.toName}
                    </span>
                    <span className="row__sub">
                      {[STAGE_CAUSE_LABEL[h.cause], h.userName, formatDateTime(h.createdAt)]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                </StaticRow>
              </li>
            ))}
          </List>
        </Section>
      )}
      <AssignSheet open={assigning} job={j} onClose={() => setAssigning(false)} />
      <AppointmentSheet state={booking} onClose={() => setBooking(null)} />
    </Page>
  );
}

function JobLineRow({ line: l }: { line: JobLineDto }) {
  return (
    <li>
      <div className="row">
        <span className="row__main">
          <span className="row__title">{l.description}</span>
          <span className="row__sub">
            {l.source === 'supplier_bill' ? 'From supplier bill' : LINE_KIND_LABEL[l.kind]} ·{' '}
            {formatQty(l.qtyMilli)} × {formatPence(l.unitSellPence)}
          </span>
        </span>
        <span className="row__meta num" style={{ color: 'var(--label)' }}>
          {formatPence(l.totalPence)}
        </span>
      </div>
    </li>
  );
}
