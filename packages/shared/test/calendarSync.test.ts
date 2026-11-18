import { describe, expect, it } from 'vitest';
import {
  bodyHash,
  eventBody,
  planPull,
  planPush,
  slotText,
  type EventLink,
  type SyncAppointment,
} from '../src';

const appt = (
  id: string,
  startsAt: string,
  endsAt: string,
  over: Partial<SyncAppointment> = {},
) => ({
  id,
  startsAt,
  endsAt,
  jobNumber: '122',
  jobTitle: 'Barn rewire',
  customerName: 'Ann Example',
  siteAddress: '1 Example Lane, Sark',
  assignee: 'Sam',
  ...over,
});
const linkFor = (a: SyncAppointment, remoteId = `r-${a.id}`): EventLink => {
  const b = eventBody(a);
  return {
    appointmentId: a.id,
    remoteId,
    etag: 'e1',
    appHash: bodyHash(b),
    remoteStartsAt: b.startsAt,
    remoteEndsAt: b.endsAt,
  };
};
const A = appt('a1', '2027-01-12T09:00:00Z', '2027-01-12T11:00:00Z');
const B = appt('a2', '2027-01-13T09:00:00Z', '2027-01-13T10:00:00Z');

describe('event body', () => {
  it('says the job and customer, never money, and carries our id', () => {
    const b = eventBody(A, 'https://app.example/');
    expect(b).toMatchObject({
      lseId: 'a1',
      title: 'Job 122: Barn rewire',
      location: '1 Example Lane, Sark',
      startsAt: '2027-01-12T09:00:00.000Z',
    });
    expect(b.description).toContain('Customer: Ann Example');
    expect(b.description).toContain('https://app.example/jobs');
    expect(b.description).not.toMatch(/£/);
  });
  it('hash changes only when what we write changes', () => {
    expect(bodyHash(eventBody(A))).toBe(bodyHash(eventBody({ ...A })));
    expect(bodyHash(eventBody(A))).not.toBe(
      bodyHash(eventBody({ ...A, endsAt: '2027-01-12T12:00:00Z' })),
    );
  });
});

describe('app → calendar', () => {
  it('creates new, updates changed, leaves unchanged, deletes gone', () => {
    const moved = { ...A, startsAt: '2027-01-12T10:00:00Z', endsAt: '2027-01-12T12:00:00Z' };
    const gone = appt('a3', '2027-01-14T09:00:00Z', '2027-01-14T10:00:00Z');
    const ops = planPush([moved, B], [linkFor(A), linkFor(gone)]);
    expect(ops.map((o) => `${o.op}:${o.appointmentId}`)).toEqual([
      'update:a1',
      'create:a2',
      'delete:a3',
    ]);
    expect(planPush([A], [linkFor(A)])).toEqual([]);
  });
});

describe('calendar → app', () => {
  it('a move in the calendar becomes a proposal; our own echo does not', () => {
    const l = linkFor(A);
    const echo = {
      remoteId: l.remoteId,
      lseId: 'a1',
      etag: 'e2',
      cancelled: false,
      startsAt: l.remoteStartsAt,
      endsAt: l.remoteEndsAt,
    };
    expect(planPull([echo], [l], [A])).toEqual([]);
    const moved = {
      ...echo,
      startsAt: '2027-01-14T09:00:00+00:00',
      endsAt: '2027-01-14T11:00:00+00:00',
    };
    expect(planPull([moved], [l], [A])).toEqual([
      {
        type: 'move',
        appointmentId: 'a1',
        remoteId: l.remoteId,
        fromStartsAt: '2027-01-12T09:00:00.000Z',
        fromEndsAt: '2027-01-12T11:00:00.000Z',
        startsAt: '2027-01-14T09:00:00.000Z',
        endsAt: '2027-01-14T11:00:00.000Z',
        conflict: false,
      },
    ]);
  });

  it('flags a conflict when the app changed too; deletes become cancel proposals', () => {
    const l = linkFor(A);
    const appMoved = { ...A, startsAt: '2027-01-12T13:00:00Z', endsAt: '2027-01-12T15:00:00Z' };
    const del = {
      remoteId: l.remoteId,
      lseId: null,
      etag: null,
      cancelled: true,
      startsAt: null,
      endsAt: null,
    };
    expect(planPull([del], [l], [appMoved])).toEqual([
      { type: 'cancel', appointmentId: 'a1', remoteId: l.remoteId, conflict: true },
    ]);
    const moved = {
      ...del,
      cancelled: false,
      startsAt: '2027-01-14T09:00:00Z',
      endsAt: '2027-01-14T10:00:00Z',
    };
    expect(planPull([moved], [l], [appMoved])[0]).toMatchObject({ type: 'move', conflict: true });
  });

  it('changed in both: the most recent change wins (Joe, 18 Nov 2026)', () => {
    const l = linkFor(A);
    const appMoved = {
      ...A,
      startsAt: '2027-01-12T13:00:00Z',
      endsAt: '2027-01-12T15:00:00Z',
      updatedAt: '2027-01-10T12:00:00Z',
    };
    const moved = {
      remoteId: l.remoteId,
      lseId: null,
      etag: null,
      cancelled: false,
      startsAt: '2027-01-14T09:00:00Z',
      endsAt: '2027-01-14T10:00:00Z',
    };
    // Calendar earlier than the app: nothing comes in (the push sends the app's version).
    expect(planPull([{ ...moved, updatedAt: '2027-01-10T11:00:00Z' }], [l], [appMoved])).toEqual(
      [],
    );
    // Calendar later: it wins.
    expect(
      planPull([{ ...moved, updatedAt: '2027-01-10T13:00:00Z' }], [l], [appMoved])[0],
    ).toMatchObject({ type: 'move', conflict: true });
    // Deleted in the calendar before the app's change: the booking is put back.
    const del = { ...moved, cancelled: true, startsAt: null, endsAt: null };
    expect(planPull([{ ...del, updatedAt: '2027-01-10T11:00:00Z' }], [l], [appMoved])).toEqual([
      { type: 'restore', appointmentId: 'a1', remoteId: l.remoteId },
    ]);
    // No app change since the last sync: the calendar's change always comes in.
    expect(
      planPull(
        [{ ...moved, updatedAt: '2027-01-10T11:00:00Z' }],
        [l],
        [{ ...A, updatedAt: '2027-01-10T12:00:00Z' }],
      )[0],
    ).toMatchObject({ type: 'move', conflict: false });
  });

  it('ignores events made by hand, bad times, and appointments already gone', () => {
    const l = linkFor(A);
    const hand = {
      remoteId: 'x',
      lseId: null,
      etag: null,
      cancelled: false,
      startsAt: '2027-01-14T09:00:00Z',
      endsAt: '2027-01-14T10:00:00Z',
    };
    const backwards = { ...hand, remoteId: l.remoteId, endsAt: '2027-01-14T08:00:00Z' };
    expect(planPull([hand, backwards], [l], [A])).toEqual([]);
    expect(planPull([{ ...hand, remoteId: l.remoteId }], [l], [])).toEqual([]);
  });
});

describe('slotText', () => {
  it('reads in Guernsey time', () => {
    expect(slotText('2027-07-15T08:00:00Z', '2027-07-15T10:30:00Z')).toBe(
      'Thu 15 Jul, 09:00–11:30',
    );
  });
});
