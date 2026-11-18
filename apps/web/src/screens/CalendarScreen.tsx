import {
  buildIcs,
  calendarLinks,
  feedEvents,
  type AppointmentListItemDto,
  type CalendarFeedDto,
} from '@lse/shared';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { api } from '../api/client';
import {
  useCalendarActivity,
  useCalendarFeeds,
  useCalendarSync,
  useConnectCalendar,
  useDisconnectCalendar,
  useRegenerateFeed,
  useRevokeFeed,
  useRunCalendarSync,
  useUndoCalendarChange,
} from '../api/calendar';
import { useMe } from '../api/hooks';
import { useToast } from '../components/Toast';
import { Button, KeyValueRow, List, Page, Section } from '../components/ui';
import { formatDayShort } from '../lib/dates';

const DEMO = import.meta.env.VITE_DEMO === '1';
const NOTE =
  'Changes show up in Google or Outlook within a few hours (they decide how often to check). The link is private: anyone who has it can see these bookings, so don’t share it. If it gets out, make a new one.';

/**
 * More › Calendar: a private link that puts your booked jobs in Google Calendar, Outlook or Apple
 * Calendar (one way: change bookings here, not there). Everyone can open it, whatever their access.
 */
export function CalendarScreen() {
  return (
    <Page title="Calendar" back={{ label: 'More', to: '/more' }}>
      {DEMO ? <DemoCalendar /> : <LiveCalendar />}
      <TwoWaySection />
    </Page>
  );
}

function LiveCalendar() {
  const feeds = useCalendarFeeds();
  if (feeds.isError)
    return (
      <p className="field-error" role="alert">
        {feeds.error.message}
      </p>
    );
  return (
    <>
      {(feeds.data ?? []).map((f) => (
        <FeedSection key={f.scope} feed={f} />
      ))}
    </>
  );
}

function FeedSection({ feed }: { feed: CalendarFeedDto }) {
  const regen = useRegenerateFeed();
  const revoke = useRevokeFeed();
  const toast = useToast();
  const me = useMe().data;
  const [confirming, setConfirming] = useState(false);
  const all = feed.scope === 'all';
  const title = all ? 'All jobs' : 'Your jobs';
  const name = `${me?.tenant.name ?? 'LSE'}: ${all ? 'all jobs' : 'my jobs'}`;
  const url = feed.path ? `${window.location.origin}${feed.path}` : null;
  const links = url ? calendarLinks(url, name) : null;
  const make = () =>
    regen.mutate(feed.scope, {
      onSuccess: () => {
        setConfirming(false);
        toast.show(url ? 'New link made; the old one no longer works' : 'Calendar link made');
      },
    });
  return (
    <Section
      header={title}
      footer={
        url
          ? undefined
          : all
            ? 'Everyone’s booked jobs in one calendar (admins only).'
            : 'Your booked jobs in Google Calendar, Outlook or Apple Calendar. One way: change bookings here.'
      }
    >
      {url && links && (
        <List className="form-list" label={`${title} calendar link`}>
          <li className="row">
            <code className="code-block" aria-label={`${title} link`}>
              {url}
            </code>
          </li>
        </List>
      )}
      {url && <p className="section__footer">{NOTE}</p>}
      <div className="button-stack">
        {!url ? (
          <Button block loading={regen.isPending} onClick={make}>
            Create Calendar Link
          </Button>
        ) : (
          <>
            <Button
              block
              onClick={() =>
                void navigator.clipboard
                  .writeText(url)
                  .then(() => toast.show('Link copied'))
                  .catch(() => toast.show('Couldn’t copy: select the link and copy it'))
              }
            >
              Copy Link
            </Button>
            <a
              className="btn btn--secondary btn--block"
              href={links!.google}
              target="_blank"
              rel="noreferrer"
            >
              Add to Google Calendar
            </a>
            <a
              className="btn btn--secondary btn--block"
              href={links!.outlook}
              target="_blank"
              rel="noreferrer"
            >
              Add to Outlook
            </a>
            <a className="btn btn--plain btn--block" href={links!.webcal}>
              Open in Calendar App
            </a>
            {confirming ? (
              <div className="confirm-inline" role="group" aria-label="Make a new link?">
                <p className="sheet-hint">
                  The old link stops working, so calendars using it stop updating. Add the new one.
                </p>
                <Button block variant="destructive" loading={regen.isPending} onClick={make}>
                  Make New Link
                </Button>
                <Button block variant="plain" onClick={() => setConfirming(false)}>
                  Keep This Link
                </Button>
              </div>
            ) : (
              <Button block variant="plain" onClick={() => setConfirming(true)}>
                Regenerate Link
              </Button>
            )}
            <Button
              block
              variant="plain"
              loading={revoke.isPending}
              onClick={() =>
                revoke.mutate(feed.scope, {
                  onSuccess: () => toast.show('Calendar link switched off'),
                })
              }
            >
              Switch Off
            </Button>
          </>
        )}
      </div>
      {(regen.error || revoke.error) && (
        <p className="field-error" role="alert">
          {(regen.error ?? revoke.error)!.message}
        </p>
      )}
    </Section>
  );
}

/** The preview runs without a server, so there is no link to subscribe to: offer a one-off file. */
function DemoCalendar() {
  const me = useMe().data;
  const toast = useToast();
  const download = async () => {
    // The schedule API answers up to about two months at a time: ask in 8-week steps.
    const day = 86_400_000;
    const start = Date.now() - 56 * day;
    const seen = new Map<string, AppointmentListItemDto>();
    for (let t = start; t < start + 448 * day; t += 56 * day) {
      const from = new Date(t).toISOString();
      const to = new Date(t + 56 * day).toISOString();
      const page = await api<AppointmentListItemDto[]>(
        'GET',
        `/appointments?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      );
      for (const a of page) seen.set(a.id, a);
    }
    const appts = [...seen.values()];
    const rows = appts
      .filter((a) => a.stage.systemKey !== 'cancelled' && a.userId === me?.user.id)
      .map((a) => ({
        id: a.id,
        startsAt: a.startsAt,
        endsAt: a.endsAt,
        jobId: a.jobId,
        jobNumber: a.jobNumber,
        jobTitle: a.jobTitle,
        customerName: a.customerName,
        customerPhone: null,
        siteAddress: a.siteAddress,
        assignee: a.userName,
      }));
    const ics = buildIcs({
      name: `${me?.tenant.name ?? 'LSE'}: my jobs (demo)`,
      events: feedEvents(rows, null),
      now: new Date(),
    });
    const href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
    const a = document.createElement('a');
    a.href = href;
    a.download = 'LSE jobs (demo).ics';
    a.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
    toast.show(`${rows.length} bookings saved to a calendar file`);
  };
  return (
    <Section
      header="Your jobs"
      footer="A one-off file doesn’t update. The live link keeps Google or Outlook up to date: changes show up within a few hours."
    >
      <p className="readiness" role="note">
        Works once the app is online. This demo runs on your computer with no server, so it can’t
        give Google or Outlook a link to check. You can download your bookings as a calendar file to
        see how they look.
      </p>
      <div className="button-stack">
        <Button
          block
          onClick={() =>
            void download().catch((e: Error) => toast.show(e.message, { tone: 'error' }))
          }
        >
          Download Calendar File (.ics)
        </Button>
      </div>
    </Section>
  );
}

const TWO_WAY_NOTE =
  'Two-way: your booked jobs go into an “LSE jobs” calendar in your Google account, and if someone moves or deletes one there, the app updates straight away. Each change is listed below with Undo. If a booking was changed in both places, the most recent change wins. The app only sees that one calendar, not the rest of your Google Calendar. It syncs by itself every 15 minutes.';

/** Two-way sync with Google Calendar, per person. */
function TwoWaySection() {
  const status = useCalendarSync(!DEMO);
  const connect = useConnectCalendar();
  const run = useRunCalendarSync();
  const disconnect = useDisconnectCalendar();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const returned = params.get('connected') ?? params.get('calendar_error');
  const told = useRef<string | null>(null);
  // Back from Google's sign-in page: say how it went once, then tidy the address bar.
  useEffect(() => {
    if (!returned || told.current === returned) return;
    told.current = returned;
    const error = params.get('calendar_error');
    if (error) toast.show(error, { tone: 'error' });
    else
      toast.show(
        `Google Calendar connected${params.get('account') ? ` (${params.get('account')})` : ''}`,
      );
    setParams({}, { replace: true });
  }, [returned, params, setParams, toast]);
  if (DEMO)
    return (
      <Section header="Two-way sync with Google Calendar" footer={TWO_WAY_NOTE}>
        <p className="section__footer" style={{ marginTop: 0 }}>
          Needs the app online and a one-off setup with Google, so it isn’t in this demo.
        </p>
      </Section>
    );
  const s = status.data;
  const c = s?.connections.find((x) => x.provider === 'google');
  const notSetUp = s?.available.google === false;
  const problem = c?.lastError ?? (c?.status === 'needs_reconnect' ? 'Connect again.' : null);
  return (
    <Section
      header="Two-way sync with Google Calendar"
      footer={
        connect.error ? (
          <span role="alert" style={{ color: 'var(--red)' }}>
            {connect.error.message}
          </span>
        ) : notSetUp ? (
          'Google Calendar needs setting up first: a one-off job for whoever runs the app (see docs/GOOGLE_CALENDAR_SETUP.md). Until then, use the calendar link above.'
        ) : (
          TWO_WAY_NOTE
        )
      }
    >
      <List label="Google Calendar">
        <li>
          <KeyValueRow
            label={c ? `Google · ${c.accountEmail ?? c.calendarName}` : 'Google Calendar'}
            value={
              notSetUp ? (
                <span style={{ color: 'var(--label-2)' }}>Needs setting up</span>
              ) : !c || c.status === 'needs_reconnect' ? (
                <Button
                  variant="plain"
                  onClick={() => connect.mutate('google')}
                  loading={connect.isPending}
                >
                  {c ? 'Connect Again' : 'Connect'}
                </Button>
              ) : (
                `${c.linkedEvents} ${c.linkedEvents === 1 ? 'job' : 'jobs'}${c.lastSyncedAt ? ` · ${formatDayShort(new Date(c.lastSyncedAt))}` : ''}`
              )
            }
          />
        </li>
        {problem && (
          <li>
            <p role="alert" className="section__footer" style={{ color: 'var(--red)', margin: 0 }}>
              {problem}
            </p>
          </li>
        )}
      </List>
      {c && (
        <div className="button-stack">
          {c.status !== 'needs_reconnect' && (
            <Button
              block
              onClick={() =>
                run.mutate(undefined, {
                  onSuccess: (r) =>
                    r.problems?.length
                      ? toast.show(r.problems[0]!, { tone: 'error' })
                      : toast.show(
                          r.applied
                            ? `${r.applied} ${r.applied === 1 ? 'change' : 'changes'} from Google Calendar applied`
                            : `Calendar up to date (${r.created + r.updated + r.deleted} changed)`,
                        ),
                  onError: (e) => toast.show(e.message, { tone: 'error' }),
                })
              }
              loading={run.isPending}
            >
              Sync Now
            </Button>
          )}
          <Button
            variant="destructive"
            block
            onClick={() =>
              disconnect.mutate(c.id, {
                onSuccess: () => toast.show('Google Calendar disconnected'),
              })
            }
          >
            Disconnect Google Calendar
          </Button>
        </div>
      )}
      {c && <CalendarActivity />}
    </Section>
  );
}

/** Changes made in Google Calendar and applied here, newest first, each with Undo. */
function CalendarActivity() {
  const activity = useCalendarActivity();
  const undo = useUndoCalendarChange();
  const toast = useToast();
  const items = activity.data ?? [];
  if (!items.length) return null;
  return (
    <>
      <h3 className="section__header" style={{ marginTop: 'var(--space-4)' }}>
        Changes from Google Calendar
      </h3>
      <List label="Changes from Google Calendar">
        {items.slice(0, 10).map((a) => (
          <li key={a.id}>
            <div className="row">
              <div className="row__main">
                <span className="row__title">{a.title}</span>
                <span className="row__sub" style={{ whiteSpace: 'normal' }}>
                  {a.undoneAt ? 'Undone. ' : ''}
                  {a.detail} · {formatDayShort(new Date(a.createdAt))}
                </span>
              </div>
              {a.canUndo && (
                <Button
                  variant="plain"
                  aria-label={`Undo: ${a.title}`}
                  loading={undo.isPending && undo.variables === a.id}
                  onClick={() =>
                    undo.mutate(a.id, {
                      onSuccess: () => toast.show('Undone. Google Calendar is being put back too.'),
                      onError: (e) => toast.show(e.message, { tone: 'error' }),
                    })
                  }
                >
                  Undo
                </Button>
              )}
            </div>
          </li>
        ))}
      </List>
    </>
  );
}
