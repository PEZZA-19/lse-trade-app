/**
 * Two-way calendar sync (Google Calendar only for now: Joe, 18 Nov 2026), the provider-free part: what each side
 * should do, worked out from the app's appointments, the links we keep to calendar events, and the
 * changes a calendar reports. The API runs the plans through a provider adapter.
 *
 * Rules (PROGRESS.md design note): the app writes only to its own "LSE jobs" calendar; events made
 * by hand in that calendar are ignored; a move or delete made in the calendar updates the app
 * straight away (Joe, 18 Nov 2026) and is logged on the Calendar screen with Undo. If both sides
 * changed since the last sync, the calendar's change wins and the log says so.
 */
import { z } from 'zod';

/** Google Calendar only for now (Joe, 18 Nov 2026); the plans below don't depend on the provider. */
export const CALENDAR_PROVIDERS = ['google'] as const;
export type CalendarProvider = (typeof CALENDAR_PROVIDERS)[number];
export const calendarProvider = z.enum(CALENDAR_PROVIDERS);
export const CALENDAR_PROVIDER_LABELS: Record<CalendarProvider, string> = {
  google: 'Google Calendar',
};
/** The calendar the app makes in the person's account and writes to (never their own calendars). */
export const SYNC_CALENDAR_NAME = 'LSE jobs';

/** An appointment as the sync sees it (no money, same as the one-way feed). */
export interface SyncAppointment {
  id: string;
  startsAt: string;
  endsAt: string;
  jobNumber: string;
  jobTitle: string;
  customerName: string;
  siteAddress: string | null;
  assignee: string | null;
  /** When it was last changed in the app (for conflicts: the most recent change wins). */
  updatedAt?: string | null;
}

/** What we write to the calendar for one appointment. */
export interface CalendarEventBody {
  /** Our appointment id, stored on the event (Google private extended property `lseId`). */
  lseId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  location: string | null;
  description: string;
}

/** The link between an appointment and its event in one connected calendar. */
export interface EventLink {
  appointmentId: string;
  remoteId: string;
  etag: string | null;
  /** Hash of the body we last wrote: tells us whether the app changed since. */
  appHash: string;
  /** Times the calendar had at the last sync: tells us whether the calendar changed since. */
  remoteStartsAt: string;
  remoteEndsAt: string;
}

/** One change reported by the calendar (incremental sync). */
export interface RemoteChange {
  remoteId: string;
  /** Our appointment id if the event carries it; null for events made by hand. */
  lseId: string | null;
  etag: string | null;
  cancelled: boolean;
  startsAt: string | null;
  endsAt: string | null;
  /** When it was last changed in the calendar (for conflicts: the most recent change wins). */
  updatedAt?: string | null;
}

export function eventBody(a: SyncAppointment, appOrigin: string | null = null): CalendarEventBody {
  const lines = [
    `Customer: ${a.customerName}`,
    a.assignee ? `Booked: ${a.assignee}` : null,
    appOrigin ? `${appOrigin.replace(/\/$/, '')}/jobs` : null,
    'Moving or deleting this event asks for approval in the app before anything changes.',
  ].filter(Boolean);
  return {
    lseId: a.id,
    title: `Job ${a.jobNumber}: ${a.jobTitle}`.slice(0, 250),
    startsAt: new Date(a.startsAt).toISOString(),
    endsAt: new Date(a.endsAt).toISOString(),
    location: a.siteAddress,
    description: lines.join('\n'),
  };
}

/** Small stable hash (FNV-1a, hex) of what we write; equal hash = nothing to push. */
export function bodyHash(b: CalendarEventBody): string {
  const s = [b.lseId, b.title, b.startsAt, b.endsAt, b.location ?? '', b.description].join(
    '\u241f',
  );
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export type PushOp =
  | { op: 'create'; appointmentId: string; body: CalendarEventBody; hash: string }
  | {
      op: 'update';
      appointmentId: string;
      remoteId: string;
      etag: string | null;
      body: CalendarEventBody;
      hash: string;
    }
  | { op: 'delete'; appointmentId: string; remoteId: string };

/** App → calendar: create what's new, update what changed, delete what's gone. */
export function planPush(
  appointments: SyncAppointment[],
  links: EventLink[],
  appOrigin: string | null = null,
): PushOp[] {
  const byAppt = new Map(links.map((l) => [l.appointmentId, l]));
  const ops: PushOp[] = [];
  const live = new Set<string>();
  for (const a of appointments) {
    live.add(a.id);
    const body = eventBody(a, appOrigin);
    const hash = bodyHash(body);
    const link = byAppt.get(a.id);
    if (!link) ops.push({ op: 'create', appointmentId: a.id, body, hash });
    else if (link.appHash !== hash)
      ops.push({
        op: 'update',
        appointmentId: a.id,
        remoteId: link.remoteId,
        etag: link.etag,
        body,
        hash,
      });
  }
  for (const l of links)
    if (!live.has(l.appointmentId))
      ops.push({ op: 'delete', appointmentId: l.appointmentId, remoteId: l.remoteId });
  return ops;
}

export type PullProposal =
  | {
      type: 'move';
      appointmentId: string;
      remoteId: string;
      fromStartsAt: string;
      fromEndsAt: string;
      startsAt: string;
      endsAt: string;
      /** The app changed it too since the last sync: applying overwrites that. */
      conflict: boolean;
    }
  | { type: 'cancel'; appointmentId: string; remoteId: string; conflict: boolean }
  /**
   * Deleted in the calendar, but changed in the app more recently: the app's booking stays and is
   * put back in the calendar as a new event.
   */
  | { type: 'restore'; appointmentId: string; remoteId: string };

/** A calendar change applied to the app (a move or a delete). */
export type AppliedCalendarChange = Exclude<PullProposal, { type: 'restore' }>;

/**
 * Calendar → app: changes to apply for linked events that were moved or deleted in the calendar.
 * Our own writes echo back with the times we wrote, so they produce nothing.
 */
export function planPull(
  changes: RemoteChange[],
  links: EventLink[],
  appointments: SyncAppointment[],
  appOrigin: string | null = null,
): PullProposal[] {
  const byRemote = new Map(links.map((l) => [l.remoteId, l]));
  const byAppt = new Map(links.map((l) => [l.appointmentId, l]));
  const appts = new Map(appointments.map((a) => [a.id, a]));
  const out: PullProposal[] = [];
  for (const c of changes) {
    const link = byRemote.get(c.remoteId) ?? (c.lseId ? byAppt.get(c.lseId) : undefined);
    if (!link) continue; // made by hand in the calendar, or not ours: ignored
    const a = appts.get(link.appointmentId);
    if (!a) continue; // already gone in the app; the push deletes the event
    const appChanged = bodyHash(eventBody(a, appOrigin)) !== link.appHash;
    // Changed in both since the last sync (Joe, 18 Nov 2026: "If changed in either it updates
    // both"): the most recent change wins. If the app's is newer, nothing comes in; the push then
    // sends the app's version to the calendar. Without both times, the calendar's change wins.
    const appNewer =
      appChanged &&
      !!a.updatedAt &&
      !!c.updatedAt &&
      new Date(a.updatedAt).getTime() > new Date(c.updatedAt).getTime();
    if (appNewer) {
      if (c.cancelled) out.push({ type: 'restore', appointmentId: a.id, remoteId: link.remoteId });
      continue;
    }
    if (c.cancelled) {
      out.push({
        type: 'cancel',
        appointmentId: a.id,
        remoteId: link.remoteId,
        conflict: appChanged,
      });
      continue;
    }
    if (!c.startsAt || !c.endsAt) continue;
    const s = new Date(c.startsAt).toISOString();
    const e = new Date(c.endsAt).toISOString();
    if (s === link.remoteStartsAt && e === link.remoteEndsAt) continue; // our own write, or no time change
    if (!(e > s)) continue;
    out.push({
      type: 'move',
      appointmentId: a.id,
      remoteId: link.remoteId,
      fromStartsAt: new Date(a.startsAt).toISOString(),
      fromEndsAt: new Date(a.endsAt).toISOString(),
      startsAt: s,
      endsAt: e,
      conflict: appChanged,
    });
  }
  return out;
}

/** "Thu 19 Nov, 09:00–11:00" in the business's time zone. */
export function slotText(startsAt: string, endsAt: string, timeZone = 'Europe/Guernsey'): string {
  const d = new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone,
  }).format(new Date(startsAt));
  const t = (x: string) =>
    new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone }).format(
      new Date(x),
    );
  return `${d}, ${t(startsAt)}–${t(endsAt)}`;
}

/** Payload of a calendar_change proposal. */
export interface CalendarChangePayload {
  provider: CalendarProvider;
  connectionId: string;
  change: AppliedCalendarChange;
}

export interface CalendarConnectionDto {
  id: string;
  provider: CalendarProvider;
  accountEmail: string | null;
  calendarName: string;
  status: 'connected' | 'needs_reconnect';
  lastSyncedAt: string | null;
  /** Why the last sync failed, in plain English (null when it went fine). */
  lastError: string | null;
  linkedEvents: number;
}

export interface CalendarSyncStatusDto {
  /** Which providers this installation can connect to (Google OAuth client set up). */
  available: Record<CalendarProvider, boolean>;
  connections: CalendarConnectionDto[];
}

export interface CalendarSyncResultDto {
  created: number;
  updated: number;
  deleted: number;
  /** Moves and deletes made in the calendar, applied to the app straight away (Joe, 18 Nov 2026). */
  applied: number;
  /** Calendars that couldn't be synced this time, and why. */
  problems?: string[];
}

/** A change made in the calendar and applied to the app, with Undo (Calendar screen). */
export interface CalendarActivityDto {
  id: string;
  provider: CalendarProvider;
  appointmentId: string;
  jobId: string | null;
  kind: 'moved' | 'deleted';
  /** "Job 112: moved in Google Calendar". */
  title: string;
  /** "Now Thu 19 Nov, 09:00–11:00 (was Wed 18 Nov, 09:00–11:00)." */
  detail: string;
  conflict: boolean;
  createdAt: string;
  undoneAt: string | null;
  /** Only the latest change to an appointment, while the app still matches it, can be undone. */
  canUndo: boolean;
}
