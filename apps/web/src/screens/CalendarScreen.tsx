import {
  buildIcs,
  calendarLinks,
  feedEvents,
  type AppointmentListItemDto,
  type CalendarFeedDto,
} from '@lse/shared';
import { useState } from 'react';
import { api } from '../api/client';
import { useCalendarFeeds, useRegenerateFeed, useRevokeFeed } from '../api/calendar';
import { useMe } from '../api/hooks';
import { useToast } from '../components/Toast';
import { Button, List, Page, Section } from '../components/ui';

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
    const from = new Date(Date.now() - 60 * 86_400_000);
    const to = new Date(Date.now() + 400 * 86_400_000);
    const appts = await api<AppointmentListItemDto[]>(
      'GET',
      `/appointments?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`,
    );
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
        <Button block onClick={() => void download()}>
          Download Calendar File (.ics)
        </Button>
      </div>
    </Section>
  );
}
