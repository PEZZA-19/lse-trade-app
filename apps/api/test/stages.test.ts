import { describe, expect, it } from 'vitest';
import { appSql, addMember, adminSql, newTenant } from './helpers';
import { client, clientFor, seedCustomer, type Client } from './api-helpers';
import { withTenant } from '../src/db/client';
import * as jobs from '../src/services/jobs';
import { SYSTEM_STAGE_DEFAULTS } from '@lse/shared';

const hourFromNow = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

async function newJob(c: Client) {
  const cust = await seedCustomer(c);
  const r = await c.req('POST', '/api/jobs', { customerId: cust.id, title: 'Rewire' });
  expect(r.status).toBe(201);
  return r.body;
}
const key = (j: { stage: { systemKey: string | null } }) => j.stage.systemKey;
const causes = (j: { history: { cause: string }[] }) => j.history.map((h) => h.cause);

describe('system stages', () => {
  it('every business gets the 8 system stages in order, Booked in for Scheduled', async () => {
    const c = await client();
    const r = await c.req('GET', '/api/job-stages');
    expect(r.body.map((s: { name: string }) => s.name)).toEqual([
      'Unassigned',
      'Assigned',
      'Booked in',
      'In Progress',
      'To Invoice',
      'Complete',
      'On Hold',
      'Cancelled',
    ]);
    const byKey = Object.fromEntries(r.body.map((s: { systemKey: string }) => [s.systemKey, s]));
    expect(
      r.body.map((s: Record<string, unknown>) => ({
        systemKey: s.systemKey,
        name: s.name,
        colour: s.colour,
        isActive: s.isActive,
        sortOrder: s.sortOrder,
      })),
    ).toEqual(SYSTEM_STAGE_DEFAULTS); // the migration and the shared defaults agree
    expect(byKey.complete.isActive).toBe(false);
    expect(byKey.cancelled.isActive).toBe(false);
    expect(byKey.on_hold).toMatchObject({ canRename: true, canDelete: true });
    expect(byKey.scheduled).toMatchObject({ canRename: false, canDelete: false });
  });

  it('a new job starts Unassigned with a "created" history entry', async () => {
    const c = await client();
    const j = await newJob(c);
    expect(key(j)).toBe('unassigned');
    expect(j.history).toHaveLength(1);
    expect(j.history[0]).toMatchObject({
      fromName: null,
      toName: 'Unassigned',
      cause: 'created',
      userName: 'Test Owner',
    });
  });
});

describe('automatic transitions', () => {
  it('assign → Assigned, appointment → Booked in, timer → In Progress; each writes history', async () => {
    const c = await client();
    const j = await newJob(c);
    const a = await c.req('POST', `/api/jobs/${j.id}/assignees`, { userId: c.userId });
    expect(key(a.body)).toBe('assigned');
    expect(a.body.assignees).toEqual([{ userId: c.userId, name: 'Test Owner' }]);

    const b = await c.req('POST', `/api/jobs/${j.id}/appointments`, {
      startsAt: hourFromNow(1),
      endsAt: hourFromNow(3),
    });
    expect(b.status).toBe(201);
    expect(key(b.body)).toBe('scheduled');
    expect(b.body.stage.name).toBe('Booked in');

    const t = await c.req('POST', `/api/jobs/${j.id}/timer/start`);
    expect(key(t.body)).toBe('in_progress');
    expect(t.body.timerRunning).toBe(true);
    expect(causes(t.body)).toEqual(['created', 'assigned', 'appointment_created', 'timer_started']);
    const last = t.body.history.at(-1);
    expect(last).toMatchObject({
      fromName: 'Booked in',
      toName: 'In Progress',
      userName: 'Test Owner',
      toColour: 'orange',
    });
    expect(Date.parse(last.createdAt)).toBeGreaterThan(Date.now() - 60_000);
  });

  it('an appointment books in an Unassigned job directly; a second one changes nothing', async () => {
    const c = await client();
    const j = await newJob(c);
    await c.req('POST', `/api/jobs/${j.id}/appointments`, {
      startsAt: hourFromNow(1),
      endsAt: hourFromNow(2),
    });
    const r = await c.req('POST', `/api/jobs/${j.id}/appointments`, {
      startsAt: hourFromNow(5),
      endsAt: hourFromNow(6),
    });
    expect(key(r.body)).toBe('scheduled');
    expect(causes(r.body)).toEqual(['created', 'appointment_created']);
  });

  it('deleting the last appointment steps back to Assigned (or Unassigned)', async () => {
    const c = await client();
    const j = await newJob(c);
    const one = (
      await c.req('POST', `/api/jobs/${j.id}/appointments`, {
        startsAt: hourFromNow(1),
        endsAt: hourFromNow(2),
      })
    ).body;
    const two = (
      await c.req('POST', `/api/jobs/${j.id}/appointments`, {
        startsAt: hourFromNow(3),
        endsAt: hourFromNow(4),
      })
    ).body;
    let r = await c.req('DELETE', `/api/appointments/${one.appointments[0].id}`);
    expect(key(r.body)).toBe('scheduled'); // one left
    r = await c.req('DELETE', `/api/appointments/${two.appointments[1].id}`);
    expect(key(r.body)).toBe('unassigned');
    expect(r.body.history.at(-1)).toMatchObject({
      cause: 'appointment_deleted',
      fromName: 'Booked in',
      toName: 'Unassigned',
    });

    await c.req('POST', `/api/jobs/${j.id}/assignees`, { userId: c.userId });
    const a = (
      await c.req('POST', `/api/jobs/${j.id}/appointments`, {
        startsAt: hourFromNow(1),
        endsAt: hourFromNow(2),
      })
    ).body;
    r = await c.req('DELETE', `/api/appointments/${a.appointments[0].id}`);
    expect(key(r.body)).toBe('assigned');
  });

  it('assigning a job that is already Booked in or later leaves the stage alone', async () => {
    const c = await client();
    const j = await newJob(c);
    await c.req('PATCH', `/api/jobs/${j.id}`, { stageKey: 'on_hold' });
    const r = await c.req('POST', `/api/jobs/${j.id}/assignees`, { userId: c.userId });
    expect(key(r.body)).toBe('on_hold');
  });

  it('removing the last person steps Assigned back to Unassigned; others keep their stage', async () => {
    const c = await client();
    const j = await newJob(c);
    const staffEmail = await addMember(c.tenantId, 'staff');
    const [staff] = await adminSql<
      { id: string }[]
    >`SELECT id FROM users WHERE email = ${staffEmail}`;
    await c.req('POST', `/api/jobs/${j.id}/assignees`, { userId: c.userId });
    await c.req('POST', `/api/jobs/${j.id}/assignees`, { userId: staff!.id });
    let r = await c.req('DELETE', `/api/jobs/${j.id}/assignees/${staff!.id}`);
    expect(key(r.body)).toBe('assigned'); // someone is still on it
    r = await c.req('DELETE', `/api/jobs/${j.id}/assignees/${c.userId}`);
    expect(key(r.body)).toBe('unassigned');
    expect(r.body.history.at(-1)).toMatchObject({
      cause: 'last_unassigned',
      fromName: 'Assigned',
      toName: 'Unassigned',
    });

    // Booked in stays Booked in: the appointment still stands.
    await c.req('POST', `/api/jobs/${j.id}/assignees`, { userId: c.userId });
    await c.req('POST', `/api/jobs/${j.id}/appointments`, {
      startsAt: hourFromNow(1),
      endsAt: hourFromNow(2),
    });
    r = await c.req('DELETE', `/api/jobs/${j.id}/assignees/${c.userId}`);
    expect(key(r.body)).toBe('scheduled');
  });

  it('a cancelled job refuses the timer; Complete stays Complete when a timer runs', async () => {
    const c = await client();
    const j = await newJob(c);
    await c.req('PATCH', `/api/jobs/${j.id}`, { stageKey: 'cancelled' });
    const r = await c.req('POST', `/api/jobs/${j.id}/timer/start`);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('job_cancelled');
    expect((await c.req('GET', '/api/timer')).body).toBeNull();

    await c.req('PATCH', `/api/jobs/${j.id}`, { stageKey: 'complete' });
    const t = await c.req('POST', `/api/jobs/${j.id}/timer/start`);
    expect(t.status).toBe(200);
    expect(key(t.body)).toBe('complete'); // a snagging visit doesn't reopen it
    await c.req('POST', `/api/jobs/${j.id}/timer/stop`);
  });

  it('a job in a custom stage: assigning and booking leave it, the timer moves it to In Progress', async () => {
    const c = await client();
    const j = await newJob(c);
    const st = (
      await c.req('POST', '/api/job-stages', { name: 'Waiting on parts', colour: 'teal' })
    ).body;
    await c.req('PATCH', `/api/jobs/${j.id}`, { stageId: st.id });
    let r = await c.req('POST', `/api/jobs/${j.id}/assignees`, { userId: c.userId });
    expect(r.body.stage.id).toBe(st.id);
    r = await c.req('POST', `/api/jobs/${j.id}/appointments`, {
      startsAt: hourFromNow(1),
      endsAt: hourFromNow(2),
    });
    expect(r.body.stage.id).toBe(st.id);
    r = await c.req('POST', `/api/jobs/${j.id}/timer/start`);
    expect(key(r.body)).toBe('in_progress');
    expect(r.body.history.at(-1)).toMatchObject({
      fromName: 'Waiting on parts',
      toName: 'In Progress',
      cause: 'timer_started',
    });
    await c.req('POST', `/api/jobs/${j.id}/timer/stop`);
  });

  it('one running timer per person', async () => {
    const c = await client();
    const [a, b] = [await newJob(c), await newJob(c)];
    await c.req('POST', `/api/jobs/${a.id}/timer/start`);
    const r = await c.req('POST', `/api/jobs/${b.id}/timer/start`);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('timer_running');
    await c.req('POST', `/api/jobs/${a.id}/timer/stop`);
    expect((await c.req('POST', `/api/jobs/${b.id}/timer/start`)).status).toBe(200);
  });

  it('invoicing hook: fully invoiced and paid → Complete, off the active list', async () => {
    const c = await client();
    const j = await newJob(c);
    await c.req('PATCH', `/api/jobs/${j.id}`, { stageKey: 'to_invoice' });
    const done = await withTenant(appSql, c, (tx) =>
      jobs.markFullyInvoicedAndPaid(tx, { ...c, role: 'owner' }, j.id),
    );
    expect(key(done)).toBe('complete');
    expect(done.history.at(-1)).toMatchObject({
      cause: 'invoiced_and_paid',
      fromName: 'To Invoice',
    });
    expect((await c.req('GET', '/api/jobs?active=true')).body.items).toHaveLength(0);
  });

  it('can only assign members of this business', async () => {
    const [c, other] = [await client(), await client()];
    const j = await newJob(c);
    const r = await c.req('POST', `/api/jobs/${j.id}/assignees`, { userId: other.userId });
    expect(r.status).toBe(422);
  });

  it('rejects an appointment that ends before it starts', async () => {
    const c = await client();
    const j = await newJob(c);
    const r = await c.req('POST', `/api/jobs/${j.id}/appointments`, {
      startsAt: hourFromNow(2),
      endsAt: hourFromNow(1),
    });
    expect(r.status).toBe(422);
  });
});

describe('manual changes', () => {
  it('any stage can be set by hand, each change in history with cause "manual"', async () => {
    const c = await client();
    const j = await newJob(c);
    await c.req('PATCH', `/api/jobs/${j.id}`, { stageKey: 'on_hold' });
    const r = await c.req('PATCH', `/api/jobs/${j.id}`, { stageKey: 'cancelled' });
    expect(key(r.body)).toBe('cancelled');
    expect(
      r.body.history
        .slice(1)
        .map((h: { fromName: string; toName: string; cause: string }) => [
          h.fromName,
          h.toName,
          h.cause,
        ]),
    ).toEqual([
      ['Unassigned', 'On Hold', 'manual'],
      ['On Hold', 'Cancelled', 'manual'],
    ]);
    // Setting the same stage again writes nothing.
    const again = await c.req('PATCH', `/api/jobs/${j.id}`, { stageKey: 'cancelled' });
    expect(again.body.history).toHaveLength(3);
  });

  it('converting a quote starts the job Unassigned with "created from quote"', async () => {
    const c = await client();
    const cust = await seedCustomer(c);
    const q = (
      await c.req('POST', '/api/quotes', {
        customerId: cust.id,
        title: 'Q',
        lines: [{ kind: 'labour', description: 'Work', qtyMilli: 1000 }],
      })
    ).body;
    await c.req('POST', `/api/quotes/${q.id}/send`);
    await c.req('POST', `/api/quotes/${q.id}/accept`, { acceptedOptions: [] });
    const j = (await c.req('POST', `/api/quotes/${q.id}/convert`)).body;
    expect(key(j)).toBe('unassigned');
    expect(causes(j)).toEqual(['created_from_quote']);
  });

  it('cannot move a job into another business’s stage', async () => {
    const [a, b] = [await client(), await client()];
    const j = await newJob(a);
    const bStages = (await b.req('GET', '/api/job-stages')).body;
    const r = await a.req('PATCH', `/api/jobs/${j.id}`, { stageId: bStages[1].id });
    expect(r.status).toBe(422);
    expect(key((await a.req('GET', `/api/jobs/${j.id}`)).body)).toBe('unassigned');
  });

  it('history is append-only for the app role', async () => {
    const c = await client();
    await newJob(c);
    await expect(
      withTenant(appSql, c, (tx) => tx`UPDATE job_history SET to_name = 'Forged'`),
    ).rejects.toThrow(/permission denied/);
    await expect(withTenant(appSql, c, (tx) => tx`DELETE FROM job_history`)).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe('custom stages', () => {
  it('owner adds a custom stage with name, colour, active flag and order', async () => {
    const c = await client();
    const r = await c.req('POST', '/api/job-stages', { name: 'Waiting on parts', colour: 'teal' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      systemKey: null,
      isActive: true,
      sortOrder: 90,
      canRename: true,
      canDelete: true,
    });
    const j = await newJob(c);
    const moved = await c.req('PATCH', `/api/jobs/${j.id}`, { stageId: r.body.id });
    expect(moved.body.stage).toMatchObject({
      name: 'Waiting on parts',
      colour: 'teal',
      systemKey: null,
    });
    // Still active.
    expect((await c.req('GET', '/api/jobs?active=true')).body.items).toHaveLength(1);
    // Turn "active" off: the job drops off the active list.
    await c.req('PATCH', `/api/job-stages/${r.body.id}`, { isActive: false });
    expect((await c.req('GET', '/api/jobs?active=true')).body.items).toHaveLength(0);
    // Filter by stage.
    expect((await c.req('GET', `/api/jobs?stageId=${r.body.id}`)).body.items).toHaveLength(1);
  });

  it('stage names are unique per business (case-insensitive)', async () => {
    const c = await client();
    const r = await c.req('POST', '/api/job-stages', { name: 'on hold', colour: 'teal' });
    expect(r.status).toBe(422);
    expect(r.body.error.details.fields.name).toBe('Already used');
  });

  it('system stages: no renaming or deleting, except To Invoice and On Hold', async () => {
    const c = await client();
    const stages = (await c.req('GET', '/api/job-stages')).body as {
      id: string;
      systemKey: string;
    }[];
    const id = (k: string) => stages.find((s) => s.systemKey === k)!.id;
    const rn = await c.req('PATCH', `/api/job-stages/${id('scheduled')}`, { name: 'Diary' });
    expect(rn.status).toBe(409);
    expect(rn.body.error.code).toBe('stage_locked');
    expect((await c.req('DELETE', `/api/job-stages/${id('complete')}`)).status).toBe(409);
    expect(
      (await c.req('PATCH', `/api/job-stages/${id('complete')}`, { isActive: true })).status,
    ).toBe(409);
    // Colour and order are fine on any stage.
    expect(
      (await c.req('PATCH', `/api/job-stages/${id('scheduled')}`, { colour: 'teal', sortOrder: 5 }))
        .status,
    ).toBe(200);
    // To Invoice / On Hold can be renamed and deleted.
    const r = await c.req('PATCH', `/api/job-stages/${id('to_invoice')}`, {
      name: 'Ready to bill',
    });
    expect(r.body.name).toBe('Ready to bill');
    expect((await c.req('DELETE', `/api/job-stages/${id('on_hold')}`)).status).toBe(204);
  });

  it('a stage in use cannot be deleted; history keeps the old name after deletion', async () => {
    const c = await client();
    const s = (await c.req('POST', '/api/job-stages', { name: 'Awaiting access', colour: 'pink' }))
      .body;
    const j = await newJob(c);
    await c.req('PATCH', `/api/jobs/${j.id}`, { stageId: s.id });
    const busy = await c.req('DELETE', `/api/job-stages/${s.id}`);
    expect(busy.status).toBe(409);
    expect(busy.body.error.message).toBe('1 job is in "Awaiting access". Move them first.');
    await c.req('PATCH', `/api/jobs/${j.id}`, { stageKey: 'assigned' });
    expect((await c.req('DELETE', `/api/job-stages/${s.id}`)).status).toBe(204);
    const after = (await c.req('GET', `/api/jobs/${j.id}`)).body;
    expect(after.history.map((h: { toName: string }) => h.toName)).toEqual([
      'Unassigned',
      'Awaiting access',
      'Assigned',
    ]);
  });

  it('staff can use stages but not change them', async () => {
    const t = await newTenant();
    const email = await addMember(t.tenantId, 'staff');
    const [u] = await adminSql<{ id: string }[]>`SELECT id FROM users WHERE email = ${email}`;
    const staff = await clientFor(email, { tenantId: t.tenantId, userId: u!.id });
    expect((await staff.req('GET', '/api/job-stages')).status).toBe(200);
    expect((await staff.req('POST', '/api/job-stages', { name: 'X', colour: 'red' })).status).toBe(
      403,
    );
    const j = await newJob(staff);
    expect(key((await staff.req('PATCH', `/api/jobs/${j.id}`, { stageKey: 'on_hold' })).body)).toBe(
      'on_hold',
    );
  });
});
