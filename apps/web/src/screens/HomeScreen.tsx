import { useState } from 'react';
import { Link } from 'react-router';
import { canSee } from '@lse/shared';
import { useAccess, useAppointments, useJobs, useMe, useRunningTimer } from '../api/hooks';
import { useEnquiryCounts, useProposalCounts } from '../api/inbox';
import { IconCalendar, IconCustomers, IconJobs, IconQuotes } from '../components/icons';
import { StagePill } from '../components/Stage';
import { Elapsed, TimerButton } from '../components/Timer';
import { Button, EmptyState, LinkRow, List, ListSkeleton, Page, Section } from '../components/ui';
import { addDays, formatDayLong, formatTime, startOfDay } from '../lib/dates';
import { AppointmentSheet, type AppointmentSheetState } from './sheets/AppointmentSheet';
import { NewCustomerSheet } from './sheets/NewCustomerSheet';
import { NewJobSheet } from './sheets/NewJobSheet';
import { NewQuoteSheet } from './sheets/NewQuoteSheet';

/** Today: the running timer, today's appointments, jobs on the go, and quick create. */
export function HomeScreen() {
  const [today] = useState(() => startOfDay(new Date()));
  const appts = useAppointments(today, addDays(today, 1));
  const timer = useRunningTimer();
  const quotesOk = canSee(useAccess(), 'quotes');
  const jobs = useJobs('active');
  const me = useMe();
  const [sheet, setSheet] = useState<'job' | 'quote' | 'customer' | null>(null);
  const [booking, setBooking] = useState<AppointmentSheetState | null>(null);

  const onTheGo = (jobs.data?.items ?? []).filter(
    (j) => j.stage.systemKey === 'in_progress' || j.id === timer.data?.jobId,
  );
  const toBook = (jobs.data?.items ?? []).filter(
    (j) => j.stage.systemKey === 'unassigned' || j.stage.systemKey === 'assigned',
  );
  const firstName = me.data?.user.name.split(' ')[0];
  const waiting = useProposalCounts().data;
  const todo = useEnquiryCounts().data?.todo ?? 0;
  const pending = waiting?.pending ?? 0;

  return (
    <Page
      title="Today"
      subtitle={`${formatDayLong(today)}${firstName ? ` · Hi ${firstName}` : ''}`}
    >
      {timer.data && (
        <div className="timer-card" role="region" aria-label="Running timer">
          <div className="timer-card__main">
            <span className="timer-card__label">Timer running</span>
            <Link className="timer-card__job" to={`/jobs/${timer.data.jobId}`}>
              Job {timer.data.jobNumber} · {timer.data.jobTitle}
            </Link>
            <Elapsed startedAt={timer.data.startedAt} />
          </div>
          <TimerButton
            compact
            job={{ id: timer.data.jobId, number: timer.data.jobNumber, title: timer.data.jobTitle }}
          />
        </div>
      )}

      <nav className="home-inbox" aria-label="Inbox">
        <Link to="/approvals" data-attention={pending > 0}>
          <strong>{pending}</strong>
          <span>
            {pending === 1 ? 'Draft to approve' : 'Drafts to approve'}
            {waiting?.held ? ` · ${waiting.held} sending` : ''}
          </span>
        </Link>
        <Link to="/enquiries" data-attention={todo > 0}>
          <strong>{todo}</strong>
          <span>{todo === 1 ? 'Enquiry to do' : 'Enquiries to do'}</span>
        </Link>
      </nav>

      <div className="quick-actions" role="group" aria-label="Create">
        <button type="button" onClick={() => setSheet('job')}>
          <IconJobs />
          New job
        </button>
        <button type="button" onClick={() => setBooking({ mode: 'create' })}>
          <IconCalendar />
          Book
        </button>
        {quotesOk && (
          <button type="button" onClick={() => setSheet('quote')}>
            <IconQuotes />
            New quote
          </button>
        )}
        <button type="button" onClick={() => setSheet('customer')}>
          <IconCustomers />
          Customer
        </button>
      </div>

      <Section header="Appointments" aside={<Link to="/schedule">Schedule</Link>}>
        {appts.isPending ? (
          <ListSkeleton rows={2} />
        ) : appts.isError ? (
          <EmptyState
            icon={<IconCalendar />}
            title="Couldn’t load today’s appointments"
            message={appts.error.message}
            action={<Button onClick={() => appts.refetch()}>Try again</Button>}
          />
        ) : appts.data.length === 0 ? (
          <EmptyState
            icon={<IconCalendar />}
            title="Nothing booked today"
            message="Book a job in from here or the Schedule."
          />
        ) : (
          <List label="Today’s appointments">
            {appts.data.map((a) => (
              <li key={a.id}>
                <div className="row">
                  <span className="row__time" aria-hidden>
                    <strong>{formatTime(a.startsAt)}</strong>
                    {formatTime(a.endsAt)}
                  </span>
                  <Link className="row__main row__link" to={`/jobs/${a.jobId}`}>
                    <span className="row__title">
                      {a.jobNumber} · {a.jobTitle}
                    </span>
                    <span className="row__sub">
                      {[a.customerName, a.siteAddress, a.userName].filter(Boolean).join(' · ')}
                    </span>
                  </Link>
                  <TimerButton
                    compact
                    job={{ id: a.jobId, number: a.jobNumber, title: a.jobTitle }}
                  />
                </div>
              </li>
            ))}
          </List>
        )}
      </Section>

      {onTheGo.length > 0 && (
        <Section header="In progress">
          <List label="Jobs in progress">
            {onTheGo.map((j) => (
              <li key={j.id}>
                <LinkRow
                  to={`/jobs/${j.id}`}
                  title={`${j.number} · ${j.title}`}
                  sub={[j.customerName, j.siteAddress].filter(Boolean).join(' · ')}
                  meta={<StagePill stage={j.stage} />}
                />
              </li>
            ))}
          </List>
        </Section>
      )}

      {toBook.length > 0 && (
        <Section header="Not booked in yet" footer="Tap Book to give one a time.">
          <List label="Jobs to book in">
            {toBook.slice(0, 5).map((j) => (
              <li key={j.id}>
                <LinkRow
                  to={`/jobs/${j.id}`}
                  title={`${j.number} · ${j.title}`}
                  sub={j.customerName}
                  meta={<StagePill stage={j.stage} />}
                />
              </li>
            ))}
          </List>
        </Section>
      )}

      <NewJobSheet open={sheet === 'job'} onClose={() => setSheet(null)} />
      <NewQuoteSheet open={sheet === 'quote'} onClose={() => setSheet(null)} />
      <NewCustomerSheet open={sheet === 'customer'} onClose={() => setSheet(null)} />
      <AppointmentSheet state={booking} onClose={() => setBooking(null)} />
    </Page>
  );
}
