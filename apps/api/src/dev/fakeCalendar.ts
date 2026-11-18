/**
 * An in-memory calendar for tests and local development: behaves like Google/Graph incremental
 * sync (a change log and a sync token), including our own writes echoing back.
 */
import type { CalendarEventBody, RemoteChange } from '@lse/shared';
import type { CalendarAdapter, CalendarConnection } from '../services/calendarSync';

interface FakeEvent {
  remoteId: string;
  lseId: string | null;
  startsAt: string;
  endsAt: string;
  title: string;
  etag: number;
  cancelled: boolean;
}

export class FakeCalendar implements CalendarAdapter {
  events = new Map<string, FakeEvent>();
  private log: RemoteChange[] = [];
  private n = 0;

  private record(e: FakeEvent, at?: string) {
    this.log.push({
      remoteId: e.remoteId,
      lseId: e.lseId,
      etag: String(e.etag),
      cancelled: e.cancelled,
      startsAt: e.cancelled ? null : e.startsAt,
      endsAt: e.cancelled ? null : e.endsAt,
      updatedAt: at ?? new Date().toISOString(),
    });
  }

  async upsert(_c: CalendarConnection, body: CalendarEventBody, remoteId: string | null) {
    const id = remoteId ?? `evt-${++this.n}`;
    const prev = this.events.get(id);
    const e: FakeEvent = {
      remoteId: id,
      lseId: body.lseId,
      startsAt: body.startsAt,
      endsAt: body.endsAt,
      title: body.title,
      etag: (prev?.etag ?? 0) + 1,
      cancelled: false,
    };
    this.events.set(id, e);
    this.record(e);
    return { remoteId: id, etag: String(e.etag) };
  }

  async remove(_c: CalendarConnection, remoteId: string) {
    const e = this.events.get(remoteId);
    if (!e) return;
    e.cancelled = true;
    e.etag++;
    this.record(e);
  }

  async changes(_c: CalendarConnection, syncToken: string | null) {
    const from = syncToken ? Number(syncToken) : 0;
    return { changes: this.log.slice(from), nextSyncToken: String(this.log.length) };
  }

  /** Someone moves the event in their calendar app (at: when, default now). */
  move(remoteId: string, startsAt: string, endsAt: string, at?: string) {
    const e = this.events.get(remoteId)!;
    Object.assign(e, { startsAt, endsAt, etag: e.etag + 1 });
    this.record(e, at);
  }
  /** Someone deletes the event in their calendar app (at: when, default now). */
  delete(remoteId: string, at?: string) {
    const e = this.events.get(remoteId)!;
    Object.assign(e, { cancelled: true, etag: e.etag + 1 });
    this.record(e, at);
  }
  /** Someone adds their own event to the calendar. */
  addByHand(startsAt: string, endsAt: string) {
    const e: FakeEvent = {
      remoteId: `hand-${++this.n}`,
      lseId: null,
      startsAt,
      endsAt,
      title: 'Dentist',
      etag: 1,
      cancelled: false,
    };
    this.events.set(e.remoteId, e);
    this.record(e);
  }
  live() {
    return [...this.events.values()].filter((e) => !e.cancelled);
  }
}
