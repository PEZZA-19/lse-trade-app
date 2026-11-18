import { describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/client';
import { connect } from '../src/services/calendarSync';
import { client, clientFor, fakeCalendar, seedCustomer, type Client } from './api-helpers';
import { addMember, adminSql, appSql } from './helpers';

/** Whole hours from a fixed point, so the same h(n) always means the same instant. */
const BASE = Math.ceil(Date.now() / 3_600_000) * 3_600_000;
const h = (hours: number) => new Date(BASE + hours * 3_600_000).toISOString();
const isoH = (hours: number) => new Date(h(hours)).toISOString();

async function connectGoogle(c: Client, calendarId = `cal-${c.userId}`) {
  return withTenant(
    appSql,
    { tenantId: c.tenantId, userId: c.userId, role: 'owner' } as never,
    (tx) =>
      connect(tx, { tenantId: c.tenantId, userId: c.userId, role: 'owner' } as never, {
        provider: 'google',
        accountEmail: 'owner@example.com',
        calendarId,
        tokenEnc: 'sealed-token',
      }),
  );
}

async function bookedJob(c: Client, userId = c.userId) {
  const cust = await seedCustomer(c);
  const job = (await c.req('POST', '/api/jobs', { customerId: cust.id, title: 'Barn rewire' }))
    .body;
  const after = (
    await c.req('POST', `/api/jobs/${job.id}/appointments`, {
      startsAt: h(24),
      endsAt: h(26),
      userId,
    })
  ).body;
  return { job, appt: after.appointments[0] };
}

/** The appointment's start as stored, or null when it's gone. */
async function apptStart(id: string): Promise<string | null> {
  const [r] = await adminSql<
    { startsAt: Date }[]
  >`SELECT starts_at FROM appointments WHERE id = ${id}`;
  return r ? new Date(r.startsAt).toISOString() : null;
}

describe('two-way calendar sync', () => {
  it('says which calendars can be connected; nothing is connected at first', async () => {
    const c = await client();
    const s = (await c.req('GET', '/api/calendar-sync')).body;
    expect(s).toEqual({ available: { google: true }, connections: [] });
    // Google Calendar only: Outlook isn't offered.
    const ms = await c.req('POST', '/api/calendar-sync/connect/microsoft');
    expect(ms.status).toBe(422);
  });

  it('pushes appointments, ignores its own echo, applies a calendar move straight away', async () => {
    const c = await client();
    const { job, appt } = await bookedJob(c);
    await connectGoogle(c);
    const first = (await c.req('POST', '/api/calendar-sync/run')).body;
    expect(first).toEqual({ created: 1, updated: 0, deleted: 0, applied: 0, problems: [] });
    const ev = fakeCalendar.live().find((e) => e.lseId === appt.id)!;
    expect(ev.title).toBe(`Job ${job.number}: Barn rewire`);
    // Running again: our own write echoes back, nothing to do.
    expect((await c.req('POST', '/api/calendar-sync/run')).body).toEqual({
      created: 0,
      updated: 0,
      deleted: 0,
      applied: 0,
      problems: [],
    });

    // Moved in Google: the app moves too, nothing waits in Approvals, and it's in the activity log.
    fakeCalendar.move(ev.remoteId, isoH(48), isoH(50));
    expect((await c.req('POST', '/api/calendar-sync/run')).body.applied).toBe(1);
    expect(await apptStart(appt.id)).toBe(isoH(48));
    const open = (await c.req('GET', '/api/proposals')).body;
    expect(open.filter((x: { kind: string }) => x.kind === 'calendar_change')).toEqual([]);
    const log = (await c.req('GET', '/api/calendar-sync/activity')).body;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      title: `Job ${job.number}: moved in Google Calendar`,
      kind: 'moved',
      conflict: false,
      canUndo: true,
      undoneAt: null,
    });
    expect(log[0].detail).toMatch(/^Now .+ \(was .+\)\.$/);
    // The next sync has nothing to send back: Google already shows the new time.
    expect((await c.req('POST', '/api/calendar-sync/run')).body).toMatchObject({
      updated: 0,
      applied: 0,
    });
    expect(fakeCalendar.events.get(ev.remoteId)!.startsAt).toBe(isoH(48));
  });

  it('Undo puts a move back in the app and in the calendar; only once', async () => {
    const c = await client();
    const { appt } = await bookedJob(c);
    await connectGoogle(c);
    await c.req('POST', '/api/calendar-sync/run');
    const ev = fakeCalendar.live().find((e) => e.lseId === appt.id)!;
    fakeCalendar.addByHand(isoH(30), isoH(31));
    fakeCalendar.move(ev.remoteId, isoH(72), isoH(73));
    expect((await c.req('POST', '/api/calendar-sync/run')).body.applied).toBe(1);
    const [entry] = (await c.req('GET', '/api/calendar-sync/activity')).body;
    const undo = await c.req('POST', `/api/calendar-sync/activity/${entry.id}/undo`);
    expect(undo.status, JSON.stringify(undo.body)).toBe(200);
    expect(undo.body).toMatchObject({ canUndo: false });
    expect(undo.body.undoneAt).not.toBeNull();
    expect(await apptStart(appt.id)).toBe(new Date(appt.startsAt).toISOString());
    // Undo syncs straight away: Google shows the old time again.
    expect(fakeCalendar.events.get(ev.remoteId)!.startsAt).toBe(
      new Date(appt.startsAt).toISOString(),
    );
    const again = await c.req('POST', `/api/calendar-sync/activity/${entry.id}/undo`);
    expect(again.status).toBe(409);
    expect(again.body.error.message ?? again.body.message).toMatch(/already been undone/);

    // Moved in the app → updated in the calendar; deleted in the app → deleted there.
    await c.req('PATCH', `/api/appointments/${appt.id}`, { startsAt: h(96), endsAt: h(97) });
    expect((await c.req('POST', '/api/calendar-sync/run')).body).toMatchObject({ updated: 1 });
    expect(fakeCalendar.events.get(ev.remoteId)!.startsAt).toBe(isoH(96));
    await c.req('DELETE', `/api/appointments/${appt.id}`);
    expect((await c.req('POST', '/api/calendar-sync/run')).body).toMatchObject({ deleted: 1 });
    expect(fakeCalendar.events.get(ev.remoteId)!.cancelled).toBe(true);
  });

  it('a move can’t be undone once the appointment changed again', async () => {
    const c = await client();
    const { appt } = await bookedJob(c);
    await connectGoogle(c);
    await c.req('POST', '/api/calendar-sync/run');
    const ev = fakeCalendar.live().find((e) => e.lseId === appt.id)!;
    fakeCalendar.move(ev.remoteId, isoH(72), isoH(73));
    await c.req('POST', '/api/calendar-sync/run');
    await c.req('PATCH', `/api/appointments/${appt.id}`, { startsAt: h(90), endsAt: h(91) });
    const [entry] = (await c.req('GET', '/api/calendar-sync/activity')).body;
    expect(entry.canUndo).toBe(false);
    const r = await c.req('POST', `/api/calendar-sync/activity/${entry.id}/undo`);
    expect(r.status).toBe(409);
    expect(await apptStart(appt.id)).toBe(isoH(90));
  });

  it('a delete in the calendar removes the appointment straight away; Undo brings it back', async () => {
    const c = await client();
    const { job, appt } = await bookedJob(c);
    await connectGoogle(c);
    await c.req('POST', '/api/calendar-sync/run');
    const stageBefore = (await c.req('GET', `/api/jobs/${job.id}`)).body.stage;
    const ev = fakeCalendar.live().find((e) => e.lseId === appt.id)!;
    fakeCalendar.delete(ev.remoteId);
    expect((await c.req('POST', '/api/calendar-sync/run')).body.applied).toBe(1);
    expect(await apptStart(appt.id)).toBeNull();
    const [entry] = (await c.req('GET', '/api/calendar-sync/activity')).body;
    expect(entry).toMatchObject({ kind: 'deleted', canUndo: true });
    expect(entry.title).toMatch(/deleted in Google Calendar/);

    const undo = await c.req('POST', `/api/calendar-sync/activity/${entry.id}/undo`);
    expect(undo.status, JSON.stringify(undo.body)).toBe(200);
    expect(await apptStart(appt.id)).toBe(new Date(appt.startsAt).toISOString());
    expect((await c.req('GET', `/api/jobs/${job.id}`)).body.stage).toEqual(stageBefore);
    // Back in Google as a new event.
    expect(fakeCalendar.live().filter((e) => e.lseId === appt.id)).toHaveLength(1);
  });

  it('changed in both: the app’s more recent change wins and goes to Google (Joe, 18 Nov 2026)', async () => {
    const c = await client();
    const { appt } = await bookedJob(c);
    await connectGoogle(c);
    await c.req('POST', '/api/calendar-sync/run');
    const ev = fakeCalendar.live().find((e) => e.lseId === appt.id)!;
    const earlier = new Date(Date.now() - 3_600_000).toISOString();
    // Moved in Google an hour ago, then changed in the app now (before a sync).
    fakeCalendar.move(ev.remoteId, isoH(50), isoH(52), earlier);
    await c.req('PATCH', `/api/appointments/${appt.id}`, { startsAt: h(60), endsAt: h(61) });
    const r = (await c.req('POST', '/api/calendar-sync/run')).body;
    expect(r.applied).toBe(0);
    expect(await apptStart(appt.id)).toBe(isoH(60));
    expect(fakeCalendar.events.get(ev.remoteId)!.startsAt).toBe(isoH(60));
    expect((await c.req('GET', '/api/calendar-sync/activity')).body).toEqual([]);

    // Deleted in Google earlier, changed in the app since: the booking stays and is put back.
    fakeCalendar.delete(ev.remoteId, new Date(Date.now() - 60_000).toISOString());
    await c.req('PATCH', `/api/appointments/${appt.id}`, { startsAt: h(62), endsAt: h(63) });
    await c.req('POST', '/api/calendar-sync/run');
    expect(await apptStart(appt.id)).toBe(isoH(62));
    const back = fakeCalendar.live().filter((e) => e.lseId === appt.id);
    expect(back).toHaveLength(1);
    expect(back[0]!.startsAt).toBe(isoH(62));
    // And it settles: another run changes nothing.
    expect((await c.req('POST', '/api/calendar-sync/run')).body).toMatchObject({
      applied: 0,
      created: 0,
      updated: 0,
      deleted: 0,
    });
  });

  it('changed in both: Google’s more recent change wins and the log says so', async () => {
    const c = await client();
    const { appt } = await bookedJob(c);
    await connectGoogle(c);
    await c.req('POST', '/api/calendar-sync/run');
    const ev = fakeCalendar.live().find((e) => e.lseId === appt.id)!;
    await c.req('PATCH', `/api/appointments/${appt.id}`, { startsAt: h(60), endsAt: h(61) });
    fakeCalendar.move(ev.remoteId, isoH(50), isoH(52));
    expect((await c.req('POST', '/api/calendar-sync/run')).body.applied).toBe(1);
    expect(await apptStart(appt.id)).toBe(isoH(50));
    const [entry] = (await c.req('GET', '/api/calendar-sync/activity')).body;
    expect(entry.conflict).toBe(true);
    expect(entry.detail).toMatch(
      /also been changed in the app, but the calendar change was more recent/,
    );
    // Undo goes back to the app's own change.
    await c.req('POST', `/api/calendar-sync/activity/${entry.id}/undo`);
    expect(await apptStart(appt.id)).toBe(isoH(60));
  });

  it('another person can’t see or undo my calendar changes', async () => {
    const c = await client();
    const email = await addMember(c.tenantId, 'staff');
    const [u] = await adminSql<{ id: string }[]>`SELECT id FROM users WHERE email = ${email}`;
    const staff = await clientFor(email, { tenantId: c.tenantId, userId: u!.id });
    const { appt } = await bookedJob(c);
    await connectGoogle(c);
    await c.req('POST', '/api/calendar-sync/run');
    const ev = fakeCalendar.live().find((e) => e.lseId === appt.id)!;
    fakeCalendar.move(ev.remoteId, isoH(72), isoH(73));
    await c.req('POST', '/api/calendar-sync/run');
    const [entry] = (await c.req('GET', '/api/calendar-sync/activity')).body;
    expect((await staff.req('GET', '/api/calendar-sync/activity')).body).toEqual([]);
    expect((await staff.req('POST', `/api/calendar-sync/activity/${entry.id}/undo`)).status).toBe(
      404,
    );
  });

  it('each person syncs only their own appointments and connection', async () => {
    const c = await client();
    const email = await addMember(c.tenantId, 'staff');
    const [u] = await adminSql<{ id: string }[]>`SELECT id FROM users WHERE email = ${email}`;
    const staff = await clientFor(email, { tenantId: c.tenantId, userId: u!.id });
    const { appt: ownerAppt } = await bookedJob(c);
    const { appt: staffAppt } = await bookedJob(c, staff.userId);
    await connectGoogle(staff);
    expect((await staff.req('POST', '/api/calendar-sync/run')).body.created).toBe(1);
    const ids = fakeCalendar.live().map((e) => e.lseId);
    expect(ids).toContain(staffAppt.id);
    expect(ids).not.toContain(ownerAppt.id);
    const conn = (await staff.req('GET', '/api/calendar-sync')).body.connections[0];
    expect(conn).toMatchObject({ provider: 'google', linkedEvents: 1 });
    expect((await c.req('DELETE', `/api/calendar-sync/${conn.id}`)).status).toBe(404);
    expect((await staff.req('DELETE', `/api/calendar-sync/${conn.id}`)).status).toBe(204);
  });
});
