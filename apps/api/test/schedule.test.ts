import { describe, expect, it } from 'vitest';
import { addMember, adminSql, newTenant } from './helpers';
import { client, clientFor, seedCustomer, type Client } from './api-helpers';

const h = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();

async function newJob(c: Client, title = 'Rewire') {
  const cust = await seedCustomer(c);
  return (await c.req('POST', '/api/jobs', { customerId: cust.id, title })).body;
}

describe('members', () => {
  it('lists the people in this business, owner first', async () => {
    const c = await client();
    await addMember(c.tenantId, 'staff', `sam-${Date.now()}@example.test`);
    const r = await c.req('GET', '/api/members');
    expect(r.status).toBe(200);
    expect(r.body.map((m: { role: string }) => m.role)).toEqual(['owner', 'staff']);
    expect(r.body[0]).toMatchObject({ userId: c.userId, name: 'Test Owner' });
  });
});

describe('appointments for the scheduler', () => {
  it('lists appointments overlapping a range, with their job', async () => {
    const c = await client();
    const j = await newJob(c, 'Barn lights');
    await c.req('POST', `/api/jobs/${j.id}/appointments`, {
      startsAt: h(1),
      endsAt: h(2),
      userId: c.userId,
    });
    await c.req('POST', `/api/jobs/${j.id}/appointments`, { startsAt: h(48), endsAt: h(49) });
    const r = await c.req(
      'GET',
      `/api/appointments?from=${encodeURIComponent(h(0))}&to=${encodeURIComponent(h(24))}`,
    );
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(1);
    expect(r.body[0]).toMatchObject({
      jobId: j.id,
      jobNumber: j.number,
      jobTitle: 'Barn lights',
      userName: 'Test Owner',
      stage: { systemKey: 'scheduled', name: 'Booked in' },
    });
    // Overlap, not containment: an appointment that started before `from` still shows.
    const mid = await c.req(
      'GET',
      `/api/appointments?from=${encodeURIComponent(h(1.5))}&to=${encodeURIComponent(h(3))}`,
    );
    expect(mid.body).toHaveLength(1);
  });

  it('refuses silly ranges', async () => {
    const c = await client();
    expect((await c.req('GET', '/api/appointments')).status).toBe(422);
    const r = await c.req(
      'GET',
      `/api/appointments?from=${encodeURIComponent(h(0))}&to=${encodeURIComponent(h(24 * 90))}`,
    );
    expect(r.status).toBe(422);
  });

  it('moves an appointment (drag) without changing the stage, and checks the person', async () => {
    const c = await client();
    const j = await newJob(c);
    const booked = (
      await c.req('POST', `/api/jobs/${j.id}/appointments`, { startsAt: h(1), endsAt: h(2) })
    ).body;
    const id = booked.appointments[0].id;
    const r = await c.req('PATCH', `/api/appointments/${id}`, {
      startsAt: h(25),
      endsAt: h(27),
      userId: c.userId,
    });
    expect(r.status).toBe(200);
    expect(r.body.userId).toBe(c.userId);
    expect(Date.parse(r.body.endsAt) - Date.parse(r.body.startsAt)).toBe(2 * 3600_000);
    expect(r.body.stage.systemKey).toBe('scheduled');
    expect(
      (await c.req('PATCH', `/api/appointments/${id}`, { startsAt: h(3), endsAt: h(2) })).status,
    ).toBe(422);
    const other = await client();
    expect(
      (
        await c.req('PATCH', `/api/appointments/${id}`, {
          startsAt: h(1),
          endsAt: h(2),
          userId: other.userId,
        })
      ).status,
    ).toBe(422);
    // Another business can't see or move it.
    expect(
      (await other.req('PATCH', `/api/appointments/${id}`, { startsAt: h(1), endsAt: h(2) }))
        .status,
    ).toBe(404);
  });
});

describe('timer and timesheets', () => {
  it('stopping the timer creates a timesheet entry on the job', async () => {
    const c = await client();
    const j = await newJob(c);
    const started = await c.req('POST', `/api/jobs/${j.id}/timer/start`, { at: h(-2) });
    expect(started.body).toMatchObject({ timerRunning: true, stage: { systemKey: 'in_progress' } });
    expect(Date.now() - Date.parse(started.body.timerStartedAt)).toBeGreaterThan(119 * 60_000);
    expect((await c.req('GET', '/api/timer')).body).toMatchObject({
      jobId: j.id,
      jobNumber: j.number,
    });

    const stopped = await c.req('POST', `/api/jobs/${j.id}/timer/stop`, { at: h(-0.5) });
    expect(stopped.body.timerRunning).toBe(false);
    expect(stopped.body.timesheets).toHaveLength(1);
    expect(stopped.body.timesheets[0]).toMatchObject({
      minutes: 90,
      source: 'timer',
      userName: 'Test Owner',
    });
    expect(stopped.body.totalMinutes).toBe(90);
    expect((await c.req('GET', '/api/timer')).body).toBeNull();
    // Stopping again is harmless.
    const again = await c.req('POST', `/api/jobs/${j.id}/timer/stop`);
    expect(again.body.timesheets).toHaveLength(1);
  });

  it('uses the device time within limits', async () => {
    const c = await client();
    const j = await newJob(c);
    expect((await c.req('POST', `/api/jobs/${j.id}/timer/start`, { at: h(1) })).status).toBe(422);
    expect((await c.req('POST', `/api/jobs/${j.id}/timer/start`, { at: h(-24 * 8) })).status).toBe(
      422,
    );
    // A stop time before the start can't make negative time.
    await c.req('POST', `/api/jobs/${j.id}/timer/start`, { at: h(-1) });
    const r = await c.req('POST', `/api/jobs/${j.id}/timer/stop`, { at: h(-2) });
    expect(r.body.timesheets[0].minutes).toBe(0);
  });

  it('one timer per person: refuses, or switches when asked (recording the first job’s time)', async () => {
    const c = await client();
    const [a, b] = [await newJob(c, 'A'), await newJob(c, 'B')];
    await c.req('POST', `/api/jobs/${a.id}/timer/start`, { at: h(-1) });
    const refused = await c.req('POST', `/api/jobs/${b.id}/timer/start`);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({
      code: 'timer_running',
      message: `Your timer is running on job ${a.number}. Stop it first.`,
    });
    const switched = await c.req('POST', `/api/jobs/${b.id}/timer/start`, { switch: true });
    expect(switched.body.timerRunning).toBe(true);
    const aNow = (await c.req('GET', `/api/jobs/${a.id}`)).body;
    expect(aNow.timerRunning).toBe(false);
    expect(aNow.timesheets[0].minutes).toBe(60);
    expect((await c.req('GET', '/api/timer')).body.jobId).toBe(b.id);
  });

  it('a replayed start/stop (offline queue) does the work once', async () => {
    const c = await client();
    const j = await newJob(c);
    const key = { 'idempotency-key': `timer-${crypto.randomUUID()}` };
    const body = { at: h(-1) };
    await c.req('POST', `/api/jobs/${j.id}/timer/start`, body, key);
    const stopKey = { 'idempotency-key': `timer-${crypto.randomUUID()}` };
    await c.req('POST', `/api/jobs/${j.id}/timer/stop`, { at: h(-0.25) }, stopKey);
    // The start arrives again (e.g. the first response was lost): replayed, no new timer.
    const replay = await c.req('POST', `/api/jobs/${j.id}/timer/start`, body, key);
    expect(replay.status).toBe(200);
    const now = (await c.req('GET', `/api/jobs/${j.id}`)).body;
    expect(now.timerRunning).toBe(false);
    expect(now.timesheets).toHaveLength(1);
  });

  it('timers are per person', async () => {
    const t = await newTenant();
    const email = await addMember(t.tenantId, 'staff');
    const [u] = await adminSql<{ id: string }[]>`SELECT id FROM users WHERE email = ${email}`;
    const staff = await clientFor(email, { tenantId: t.tenantId, userId: u!.id });
    const j = await newJob(staff);
    await staff.req('POST', `/api/jobs/${j.id}/timer/start`);
    const ownerEmail = await addMember(t.tenantId, 'owner');
    const [o] = await adminSql<{ id: string }[]>`SELECT id FROM users WHERE email = ${ownerEmail}`;
    const owner = await clientFor(ownerEmail, { tenantId: t.tenantId, userId: o!.id });
    expect((await owner.req('GET', '/api/timer')).body).toBeNull();
    expect((await owner.req('GET', `/api/jobs/${j.id}`)).body.timerRunning).toBe(false);
    expect((await staff.req('GET', `/api/jobs/${j.id}`)).body.timerRunning).toBe(true);
  });
});
