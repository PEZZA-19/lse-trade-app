import { ACCESS_AREAS, type JobDetailDto } from '@lse/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/client';
import { connect } from '../src/services/calendarSync';
import { idempotent } from '../src/lib/idempotency';
import { client, clientFor, fakeCalendar, seedCustomer, type Client } from './api-helpers';
import { addMember, adminSql, appSql } from './helpers';

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const photo = { dataUrl: `data:image/png;base64,${PNG}`, caption: 'Synthetic test photo' };
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const future = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
const range = () => `from=${encodeURIComponent(ago(60))}&to=${encodeURIComponent(future(100))}`;
type Probe = [method: string, path: string, body?: unknown];

async function member(c: Client, role: 'staff' | 'subcontractor' | 'accountant') {
  const email = await addMember(c.tenantId, role);
  const [user] = await adminSql<{ id: string }[]>`SELECT id FROM users WHERE email = ${email}`;
  return clientFor(email, { tenantId: c.tenantId, userId: user!.id });
}
async function ok(c: Client, method: string, path: string, body?: unknown, status = 200) {
  const r = await c.req(method, path, body);
  expect(r.status, `${method} ${path}: ${JSON.stringify(r.body)}`).toBe(status);
  return r.body;
}
async function makeJob(c: Client, customerId: string, title: string): Promise<JobDetailDto> {
  return ok(c, 'POST', '/api/jobs', { customerId, title }, 201);
}
async function grant(
  owner: Client,
  sub: Client,
  areas: readonly string[] = ACCESS_AREAS,
  isAdmin = false,
) {
  await ok(owner, 'PUT', `/api/team/${sub.userId}/access`, { isAdmin, areas });
}

async function fixture() {
  const owner = await client();
  const sub = await member(owner, 'subcontractor');
  const staff = await member(owner, 'staff');
  const customer = await seedCustomer(owner);
  const mine = await makeJob(owner, customer.id, 'Assigned synthetic job');
  const cross = await makeJob(owner, customer.id, 'Other-person synthetic job');
  const unassigned = await makeJob(owner, customer.id, 'Unassigned synthetic job');
  await ok(owner, 'POST', `/api/jobs/${mine.id}/assignees`, { userId: sub.userId });
  await ok(owner, 'POST', `/api/jobs/${cross.id}/assignees`, { userId: staff.userId });
  const other = await client();
  const otherCustomer = await seedCustomer(other);
  const foreign = await makeJob(other, otherCustomer.id, 'Other-tenant synthetic job');
  // Even the same user ID in a different tenant must not grant access here.
  await addMember(other.tenantId, 'subcontractor', sub.email);
  await ok(other, 'POST', `/api/jobs/${foreign.id}/assignees`, { userId: sub.userId });
  return { owner, sub, staff, customer, mine, cross, unassigned, other, foreign };
}

describe('assignment-scoped API access (real sessions, app-role RLS)', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => {
    f = await fixture();
  });

  it('filters before search, counts and paging; assignment is user + tenant, not a stage or booking', async () => {
    const { owner, sub, mine, cross, unassigned, foreign, customer } = f;
    // An appointment booked to this user still does not assign its job.
    await ok(
      owner,
      'POST',
      `/api/jobs/${unassigned.id}/appointments`,
      {
        startsAt: future(20),
        endsAt: future(21),
        userId: sub.userId,
      },
      201,
    );
    for (const query of ['', '?active=true', `?customerId=${customer.id}`, '?limit=1&offset=0']) {
      const list = await ok(sub, 'GET', `/api/jobs${query}`);
      expect(list.total).toBe(1);
      expect(list.items.map((j: { id: string }) => j.id)).toEqual([mine.id]);
    }
    for (const query of [
      '?q=Other-person',
      '?q=Unassigned',
      '?limit=1&offset=1',
      `?q=${cross.number}`,
    ]) {
      const list = await ok(sub, 'GET', `/api/jobs${query}`);
      expect(list.items).toEqual([]);
      expect(list.total).toBe(query.includes('offset') ? 1 : 0);
    }
    expect(
      (await ok(sub, 'GET', `/api/customers/${customer.id}`)).jobs.map((j: { id: string }) => j.id),
    ).toEqual([mine.id]);
    for (const job of [cross, unassigned, foreign]) {
      const r = await sub.req('GET', `/api/jobs/${job.id}`);
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe('not_found');
      expect(JSON.stringify(r.body)).not.toContain(job.title);
    }
    const visible = await ok(sub, 'GET', `/api/jobs/${mine.id}`);
    expect(visible.title).toBe(mine.title);
    expect(JSON.stringify(visible)).not.toMatch(/"\w+(Pence|Bp)":\s*\d/);
  });

  it('blocks every job-parent read/write, including stage, timer and assignment escalation', async () => {
    const { owner, sub, cross, unassigned, foreign, mine, customer } = f;
    // Enable every area: 404 must come from job scope, not area/navigation restrictions.
    await grant(owner, sub);
    for (const job of [cross, unassigned, foreign]) {
      const probes: Probe[] = [
        ['GET', `/api/jobs/${job.id}`],
        ['PATCH', `/api/jobs/${job.id}`, { title: 'MUTATED', stageKey: 'complete' }],
        ['POST', `/api/jobs/${job.id}/assignees`, { userId: sub.userId }],
        ['DELETE', `/api/jobs/${job.id}/assignees/${sub.userId}`],
        [
          'POST',
          `/api/jobs/${job.id}/appointments`,
          { startsAt: future(30), endsAt: future(31), userId: sub.userId },
        ],
        ['POST', `/api/jobs/${job.id}/timer/start`, {}],
        ['POST', `/api/jobs/${job.id}/timer/stop`, {}],
        ['POST', `/api/jobs/${job.id}/timesheets`, { startedAt: ago(100), endedAt: ago(90) }],
        [
          'POST',
          `/api/jobs/${job.id}/lines`,
          { description: 'Test', unitCostPence: 100, qtyMilli: 1000 },
        ],
        ['GET', `/api/jobs/${job.id}/notes`],
        ['POST', `/api/jobs/${job.id}/notes`, { body: 'Test' }],
        ['GET', `/api/jobs/${job.id}/photos`],
        ['POST', `/api/jobs/${job.id}/photos`, photo],
        ['GET', `/api/jobs/${job.id}/invoicing`],
        ['POST', `/api/jobs/${job.id}/invoices`, { source: 'job' }],
        ['GET', `/api/jobs/${job.id}/costing`],
        ['PUT', `/api/jobs/${job.id}/credit`, { useCredit: true }],
      ];
      for (const [method, path, body] of probes) {
        const r = await sub.req(method, path, body);
        expect(r.status, `${method} ${path}: ${JSON.stringify(r.body)}`).toBe(404);
        expect(r.body.error.code).toBe('not_found');
      }
      const c = job.id === foreign.id ? f.other : owner;
      const after = await ok(c, 'GET', `/api/jobs/${job.id}`);
      expect(after.title).toBe(job.title);
      expect(after.lines).toEqual([]);
      expect(after.timesheets).toEqual([]);
      expect(after.timerRunning).toBe(false);
    }
    for (const [method, path, body] of [
      ['POST', '/api/jobs', { customerId: customer.id, title: 'Cannot self-create' }],
      ['POST', `/api/jobs/${mine.id}/assignees`, { userId: sub.userId }],
      ['DELETE', `/api/jobs/${mine.id}/assignees/${sub.userId}`],
    ] satisfies Probe[])
      expect((await sub.req(method, path, body)).status).toBe(403);
  });

  it('direct child IDs cannot read or mutate hidden notes, photos, time, materials or appointments', async () => {
    const { owner, sub, cross, unassigned, foreign, other } = f;
    await grant(owner, sub);
    for (const job of [cross, unassigned, foreign]) {
      const c = job.id === foreign.id ? other : owner;
      const notes = await ok(
        c,
        'POST',
        `/api/jobs/${job.id}/notes`,
        { body: 'Hidden synthetic note' },
        201,
      );
      const photos = await ok(c, 'POST', `/api/jobs/${job.id}/photos`, photo, 201);
      const time = await ok(
        c,
        'POST',
        `/api/jobs/${job.id}/timesheets`,
        {
          userId: sub.userId,
          startedAt: ago(500 + [cross, unassigned, foreign].indexOf(job) * 100),
          endedAt: ago(490 + [cross, unassigned, foreign].indexOf(job) * 100),
        },
        201,
      );
      const lines = await ok(
        c,
        'POST',
        `/api/jobs/${job.id}/lines`,
        { description: 'Hidden material', unitCostPence: 100, qtyMilli: 1000 },
        201,
      );
      const booked = await ok(
        c,
        'POST',
        `/api/jobs/${job.id}/appointments`,
        { startsAt: future(40), endsAt: future(41), userId: sub.userId },
        201,
      );
      const appt = booked.appointments[booked.appointments.length - 1];
      const probes: Probe[] = [
        ['DELETE', `/api/notes/${notes[0].id}`],
        ['GET', `/api/photos/${photos[0].id}`],
        ['DELETE', `/api/photos/${photos[0].id}`],
        ['PATCH', `/api/timesheets/${time.timesheets[0].id}`, { note: 'MUTATED' }],
        ['DELETE', `/api/timesheets/${time.timesheets[0].id}`],
        ['PATCH', `/api/job-lines/${lines.lines[0].id}`, { qtyMilli: 2000 }],
        ['DELETE', `/api/job-lines/${lines.lines[0].id}`],
        [
          'PATCH',
          `/api/appointments/${appt.id}`,
          { startsAt: future(42), endsAt: future(43), userId: sub.userId },
        ],
        ['DELETE', `/api/appointments/${appt.id}`],
      ];
      for (const [method, path, body] of probes) {
        const r = await sub.req(method, path, body);
        expect(r.status, `${method} ${path}: ${JSON.stringify(r.body)}`).toBe(404);
      }
      expect((await ok(c, 'GET', `/api/jobs/${job.id}/notes`))[0].body).toBe(
        'Hidden synthetic note',
      );
      expect((await c.session.request('GET', photos[0].url)).status).toBe(200);
      const after = await ok(c, 'GET', `/api/jobs/${job.id}`);
      expect(after.lines[0].qtyMilli).toBe(1000);
      expect(after.timesheets[0].note).toBeNull();
      expect(after.appointments.some((a: { id: string }) => a.id === appt.id)).toBe(true);
    }
  });

  it('invoice/credit and supplier-bill IDs, documents and indirect customer/report links obey scope', async () => {
    const { owner, sub, cross, unassigned, foreign, other, customer } = f;
    await grant(owner, sub);
    for (const job of [cross, unassigned, foreign]) {
      const c = job.id === foreign.id ? other : owner;
      await ok(c, 'PATCH', '/api/settings', {
        bankAccountName: 'Synthetic',
        bankSortCode: '400000',
        bankAccountNumber: '12345678',
      });
      await ok(
        c,
        'POST',
        `/api/jobs/${job.id}/lines`,
        { description: 'Synthetic invoice material', qtyMilli: 1000, unitCostPence: 100 },
        201,
      );
      const invoice = await ok(c, 'POST', `/api/jobs/${job.id}/invoices`, { source: 'job' }, 201);
      await ok(c, 'POST', `/api/invoices/${invoice.id}/approve`);
      await ok(c, 'POST', `/api/invoices/${invoice.id}/mark-sent`);
      await ok(
        c,
        'POST',
        `/api/invoices/${invoice.id}/payments`,
        {
          amountPence: 10,
          paidOn: new Date().toISOString().slice(0, 10),
          method: 'cash',
        },
        201,
      );
      const credit = await ok(
        c,
        'POST',
        `/api/invoices/${invoice.id}/credit-notes`,
        { amountPence: 10, reason: 'Synthetic' },
        201,
      );
      const bill = await ok(
        c,
        'POST',
        '/api/supplier-bills',
        {
          supplier: 'Synthetic Supplier',
          reference: `test-${job.id}`,
          billDate: new Date().toISOString().slice(0, 10),
          jobId: job.id,
          lines: [{ description: 'Hidden cable', qtyMilli: 1000, unitCostPence: 100 }],
        },
        201,
      );
      const probes: Probe[] = [
        ...['', '/document', '/pdf'].map((suffix): Probe => [
          'GET',
          `/api/invoices/${invoice.id}${suffix}`,
        ]),
        ['PATCH', `/api/invoices/${invoice.id}`, { notes: 'MUTATED' }],
        ['DELETE', `/api/invoices/${invoice.id}`],
        ...['approve', 'use-credit', 'mark-sent'].map((action): Probe => [
          'POST',
          `/api/invoices/${invoice.id}/${action}`,
        ]),
        [
          'POST',
          `/api/invoices/${invoice.id}/payments`,
          { amountPence: 10, paidOn: new Date().toISOString().slice(0, 10), method: 'cash' },
        ],
        [
          'POST',
          `/api/invoices/${invoice.id}/credit-notes`,
          { amountPence: 10, reason: 'MUTATED' },
        ],
        ...['', '/document', '/pdf'].map((suffix): Probe => [
          'GET',
          `/api/credit-notes/${credit.id}${suffix}`,
        ]),
        ['DELETE', `/api/credit-notes/${credit.id}`],
        ['POST', `/api/credit-notes/${credit.id}/approve`],
        ['GET', `/api/supplier-bills/${bill.id}`],
        ['PATCH', `/api/supplier-bills/${bill.id}`, { notes: 'MUTATED' }],
        ['DELETE', `/api/supplier-bills/${bill.id}`],
        ['POST', `/api/supplier-bills/${bill.id}/apply`, {}],
        ['POST', `/api/supplier-bills/${bill.id}/suggest-prices`],
        ['GET', `/api/supplier-bills/${bill.id}/payments`],
        [
          'POST',
          `/api/supplier-bills/${bill.id}/payments`,
          { amountPence: 10, paidOn: new Date().toISOString().slice(0, 10), method: 'cash' },
        ],
      ];
      for (const [method, path, body] of probes)
        expect((await sub.req(method, path, body)).status, `${method} ${path}`).toBe(404);
      expect(await ok(sub, 'GET', `/api/invoices?jobId=${job.id}`)).toEqual([]);
      expect(await ok(sub, 'GET', `/api/supplier-bills?jobId=${job.id}`)).toEqual([]);
      expect(await ok(c, 'GET', `/api/invoices/${invoice.id}`)).toMatchObject({
        paidPence: 10,
        creditedPence: 0,
      });
    }
    const linked = await ok(sub, 'GET', `/api/customers/${customer.id}`);
    expect(linked.jobs.map((j: { id: string }) => j.id)).toEqual([f.mine.id]);
    const today = new Date().toISOString().slice(0, 10);
    const report = await ok(sub, 'GET', `/api/reports?from=${today.slice(0, 8)}01&to=${today}`);
    for (const job of [cross, unassigned, foreign])
      expect(JSON.stringify(report)).not.toContain(job.id);
    expect(await ok(sub, 'GET', '/api/invoices')).toEqual([]);
    expect(await ok(sub, 'GET', '/api/supplier-bills')).toEqual([]);
    const business = await ok(sub, 'GET', '/api/business');
    expect(business.invoices).toEqual([]);
    expect(business.payments).toEqual([]);
    expect(business.credits).toEqual([]);
    expect(business.bills).toEqual([]);
    expect(business.billPayments).toEqual([]);
    expect(
      business.pipeline.reduce((sum: number, stage: { count: number }) => sum + stage.count, 0),
    ).toBe(1);
  });

  it('converted quote identifiers and PDF exports are scoped too, without blocking assigned quote reads', async () => {
    const { owner, sub, staff, customer } = await fixture();
    await grant(owner, sub);
    const quotes: { id: string; jobId: string }[] = [];
    for (const userId of [sub.userId, staff.userId]) {
      const quote = await ok(
        owner,
        'POST',
        '/api/quotes',
        {
          customerId: customer.id,
          title: 'Synthetic linked quote',
          lines: [{ kind: 'labour', description: 'Synthetic work', qtyMilli: 1000 }],
        },
        201,
      );
      await ok(owner, 'POST', `/api/quotes/${quote.id}/send`);
      await ok(owner, 'POST', `/api/quotes/${quote.id}/accept`, {});
      const job = await ok(owner, 'POST', `/api/quotes/${quote.id}/convert`, undefined, 201);
      await ok(owner, 'POST', `/api/jobs/${job.id}/assignees`, { userId });
      quotes.push({ id: quote.id, jobId: job.id });
    }
    const mine = quotes[0]!;
    const hidden = quotes[1]!;
    for (const [method, path, body] of [
      ['GET', `/api/quotes/${hidden.id}`],
      ['GET', `/api/quotes/${hidden.id}/document`],
      ['GET', `/api/quotes/${hidden.id}/pdf`],
      ['PATCH', `/api/quotes/${hidden.id}`, { title: 'MUTATED' }],
      ...['send', 'revise', 'accept', 'decline', 'convert'].map((action): Probe => [
        'POST',
        `/api/quotes/${hidden.id}/${action}`,
        {},
      ]),
      ['PUT', `/api/quotes/${hidden.id}/credit`, { useCredit: true }],
    ] satisfies Probe[])
      expect((await sub.req(method, path, body)).status, `${method} ${path}`).toBe(404);
    const list = await ok(sub, 'GET', '/api/quotes?limit=1');
    expect(list.total).toBe(1);
    expect(list.items[0].id).toBe(mine.id);
    const detail = await ok(sub, 'GET', `/api/customers/${customer.id}`);
    expect(detail.quotes.map((quote: { id: string }) => quote.id)).toEqual([mine.id]);
    expect(JSON.stringify(detail)).not.toContain(hidden.jobId);
    expect((await sub.session.request('GET', `/api/quotes/${mine.id}/pdf`)).status).toBe(200);
    const newQuote = await ok(
      sub,
      'POST',
      '/api/quotes',
      { customerId: customer.id, title: 'Not a self-assignment' },
      201,
    );
    expect((await sub.req('POST', `/api/quotes/${newQuote.id}/convert`)).status).toBe(403);
  });

  it('calendar list, iCal, sync, activity and Undo never disclose a cross-assigned or unassigned job', async () => {
    const { owner, sub, mine, cross, unassigned, foreign } = f;
    const booked = await ok(
      owner,
      'POST',
      `/api/jobs/${mine.id}/appointments`,
      { startsAt: future(50), endsAt: future(51), userId: sub.userId },
      201,
    );
    const appt = booked.appointments[0];
    const appointments = await ok(sub, 'GET', `/api/appointments?${range()}`);
    expect(appointments.map((a: { jobId: string }) => a.jobId)).toEqual([mine.id]);
    const feed = await ok(sub, 'POST', '/api/calendar-feeds/mine');
    const ics = await (await f.owner.session.request('GET', feed.path)).text();
    expect(ics).toContain(mine.title);
    for (const job of [cross, unassigned, foreign]) expect(ics).not.toContain(job.title);
    expect((await sub.req('POST', '/api/calendar-feeds/all')).status).toBe(403);
    await withTenant(appSql, sub, (tx) =>
      connect(
        tx,
        { ...sub, role: 'subcontractor' },
        {
          provider: 'google',
          accountEmail: 'synthetic@example.test',
          calendarId: `scope-${sub.userId}`,
          tokenEnc: 'fake-test-token',
        },
      ),
    );
    const sync = await ok(sub, 'POST', '/api/calendar-sync/run');
    expect(sync.created).toBe(1);
    const remote = fakeCalendar.live().find((event) => event.lseId === appt.id)!;
    expect(remote.title).toContain(mine.title);
    fakeCalendar.move(remote.remoteId, future(52), future(53));
    expect((await ok(sub, 'POST', '/api/calendar-sync/run')).applied).toBe(1);
    const activity = await ok(sub, 'GET', '/api/calendar-sync/activity');
    expect(activity).toHaveLength(1);
    await ok(owner, 'DELETE', `/api/jobs/${mine.id}/assignees/${sub.userId}`);
    expect(await ok(sub, 'GET', '/api/calendar-sync/activity')).toEqual([]);
    expect(
      (await sub.req('POST', `/api/calendar-sync/activity/${activity[0].id}/undo`)).status,
    ).toBe(404);
    expect((await ok(sub, 'GET', '/api/calendar-sync')).connections[0].linkedEvents).toBe(0);
    const revokedFeed = await (await sub.session.request('GET', feed.path)).text();
    expect(revokedFeed).not.toContain(mine.title);
    await ok(owner, 'POST', `/api/jobs/${mine.id}/assignees`, { userId: sub.userId });
  });

  it('assigned work remains usable; revocation invalidates timer replays and frees the hidden timer', async () => {
    const { owner, sub, mine, cross } = f;
    await grant(owner, sub, []);
    await ok(sub, 'PATCH', `/api/jobs/${mine.id}`, {
      description: 'Assigned work',
      stageKey: 'in_progress',
    });
    const notes = await ok(sub, 'POST', `/api/jobs/${mine.id}/notes`, { body: 'My work' }, 201);
    await ok(sub, 'DELETE', `/api/notes/${notes[0].id}`);
    const photos = await ok(sub, 'POST', `/api/jobs/${mine.id}/photos`, photo, 201);
    const image = await sub.session.request('GET', photos[0].url);
    expect(image.status).toBe(200);
    expect(image.headers.get('cache-control')).toContain('no-store');
    await ok(sub, 'DELETE', photos[0].url);
    const time = await ok(
      sub,
      'POST',
      `/api/jobs/${mine.id}/timesheets`,
      { startedAt: ago(80), endedAt: ago(70) },
      201,
    );
    const sheet = time.timesheets[0];
    await ok(sub, 'PATCH', `/api/timesheets/${sheet.id}`, { note: 'My time' });
    await ok(sub, 'DELETE', `/api/timesheets/${sheet.id}`);
    // Existing money restrictions are not loosened for assigned work.
    expect(
      (
        await sub.req('POST', `/api/jobs/${mine.id}/lines`, {
          description: 'Cable',
          unitCostPence: 100,
        })
      ).status,
    ).toBe(403);
    expect((await sub.req('GET', `/api/jobs/${mine.id}/invoicing`)).status).toBe(403);
    const headers = { 'Idempotency-Key': `scope-timer-${mine.id}` };
    const start = await sub.req('POST', `/api/jobs/${mine.id}/timer/start`, {}, headers);
    expect(start.status).toBe(200);
    expect((await ok(sub, 'GET', '/api/timer')).jobId).toBe(mine.id);
    expect(
      (await sub.req('POST', `/api/jobs/${mine.id}/timer/start`, {}, headers)).headers.get(
        'Idempotent-Replayed',
      ),
    ).toBe('true');
    await ok(owner, 'DELETE', `/api/jobs/${mine.id}/assignees/${sub.userId}`);
    expect((await sub.req('POST', `/api/jobs/${mine.id}/timer/start`, {}, headers)).status).toBe(
      404,
    );
    expect(await ok(sub, 'GET', '/api/timer')).toBeNull();
    await ok(owner, 'POST', `/api/jobs/${cross.id}/assignees`, { userId: sub.userId });
    await ok(sub, 'POST', `/api/jobs/${cross.id}/timer/start`, {});
    await ok(sub, 'POST', `/api/jobs/${cross.id}/timer/stop`, {});
    await ok(owner, 'DELETE', `/api/jobs/${cross.id}/assignees/${sub.userId}`);
    await ok(owner, 'POST', `/api/jobs/${mine.id}/assignees`, { userId: sub.userId });
    // Enabling pricing permits assigned materials, but still never widens the job scope.
    await grant(owner, sub, ['quotes']);
    const line = await ok(
      sub,
      'POST',
      `/api/jobs/${mine.id}/lines`,
      { description: 'My cable', qtyMilli: 1000, unitCostPence: 100 },
      201,
    );
    await ok(sub, 'PATCH', `/api/job-lines/${line.lines[0].id}`, { qtyMilli: 2000 });
    await ok(sub, 'DELETE', `/api/job-lines/${line.lines[0].id}`);
  });

  it('cached invoice bodies are person-bound and checked again after assignment revocation', async () => {
    const { owner, sub, mine, cross } = f;
    await grant(owner, sub, ['financials', 'quotes']);
    await ok(
      owner,
      'POST',
      `/api/jobs/${mine.id}/lines`,
      { description: 'Invoice test', qtyMilli: 1000, unitCostPence: 100 },
      201,
    );
    const key = { 'Idempotency-Key': `scoped-invoice-${mine.id}` };
    const invoice = await sub.req('POST', `/api/jobs/${mine.id}/invoices`, { source: 'job' }, key);
    expect(invoice.status).toBe(201);
    expect(
      (await sub.req('POST', `/api/jobs/${mine.id}/invoices`, { source: 'job' }, key)).headers.get(
        'Idempotent-Replayed',
      ),
    ).toBe('true');
    await ok(sub, 'PATCH', `/api/invoices/${invoice.body.id}`, { notes: 'Assigned invoice' });
    expect((await sub.req('POST', `/api/invoices/${invoice.body.id}/approve`)).status).toBe(403);
    expect((await sub.session.request('GET', `/api/invoices/${invoice.body.id}/pdf`)).status).toBe(
      200,
    );
    await ok(owner, 'DELETE', `/api/jobs/${mine.id}/assignees/${sub.userId}`);
    expect(
      (await sub.req('POST', `/api/jobs/${mine.id}/invoices`, { source: 'job' }, key)).status,
    ).toBe(404);
    expect((await sub.req('GET', `/api/invoices/${invoice.body.id}`)).status).toBe(404);
    // A staff/owner cache with a known key must not return their hidden job to this person.
    const sharedKey = { 'Idempotency-Key': `staff-invoice-${cross.id}` };
    await f.owner.req('POST', `/api/jobs/${cross.id}/invoices`, { source: 'job' }, sharedKey);
    expect(
      (await sub.req('POST', `/api/jobs/${cross.id}/invoices`, { source: 'job' }, sharedKey))
        .status,
    ).toBe(404);
    await ok(owner, 'POST', `/api/jobs/${mine.id}/assignees`, { userId: sub.userId });
    await ok(sub, 'DELETE', `/api/invoices/${invoice.body.id}`, undefined, 204);
  });

  it('indirect cached bill responses are reauthorized and keys cannot expose another person’s response', async () => {
    const { owner, sub, mine, cross, unassigned } = f;
    await grant(owner, sub, ['financials']);
    const input = {
      supplier: 'Synthetic cache supplier',
      reference: `cache-${mine.id}`,
      jobId: mine.id,
      billDate: new Date().toISOString().slice(0, 10),
      lines: [],
    };
    const headers = { 'Idempotency-Key': `bill-cache-${mine.id}` };
    const bill = await sub.req('POST', '/api/supplier-bills', input, headers);
    expect(bill.status).toBe(201);
    expect(
      (await sub.req('POST', '/api/supplier-bills', input, headers)).headers.get(
        'Idempotent-Replayed',
      ),
    ).toBe('true');
    await ok(owner, 'DELETE', `/api/jobs/${mine.id}/assignees/${sub.userId}`);
    expect((await sub.req('POST', '/api/supplier-bills', input, headers)).status).toBe(404);
    for (const job of [cross, unassigned, f.foreign])
      expect(
        (await sub.req('POST', '/api/supplier-bills', { ...input, jobId: job.id })).status,
      ).toBe(404);
    expect((await sub.req('POST', '/api/supplier-bills', { ...input, jobId: null })).status).toBe(
      403,
    );
    await ok(owner, 'POST', `/api/jobs/${mine.id}/assignees`, { userId: sub.userId });
    expect(
      (await sub.req('PATCH', `/api/supplier-bills/${bill.body.id}`, { jobId: cross.id })).status,
    ).toBe(404);
    expect(
      (await sub.req('PATCH', `/api/supplier-bills/${bill.body.id}`, { jobId: null })).status,
    ).toBe(403);
    // The cached jobId is still visible, but the current bill has been moved elsewhere.
    await ok(owner, 'PATCH', `/api/supplier-bills/${bill.body.id}`, { jobId: cross.id });
    expect((await sub.req('POST', '/api/supplier-bills', input, headers)).status).toBe(404);
    await ok(owner, 'PATCH', `/api/supplier-bills/${bill.body.id}`, { jobId: mine.id });
    await ok(sub, 'DELETE', `/api/supplier-bills/${bill.body.id}`, undefined, 204);
    // Same client key and request from another person creates their own response, not ours.
    const shared = { 'Idempotency-Key': `person-key-${mine.id}` };
    const customerInput = { name: 'Synthetic person-bound cache' };
    const ownerCustomer = await owner.req('POST', '/api/customers', customerInput, shared);
    const subCustomer = await sub.req('POST', '/api/customers', customerInput, shared);
    expect(ownerCustomer.status).toBe(201);
    expect(subCustomer.status).toBe(201);
    expect(subCustomer.body.id).not.toBe(ownerCustomer.body.id);
  });

  it('cached payments cannot replay a now-hidden credit invoice through a still-assigned job', async () => {
    const { owner, sub, mine, cross } = await fixture();
    await grant(owner, sub, ['financials']);
    await ok(owner, 'PATCH', '/api/settings', {
      bankAccountName: 'Synthetic',
      bankSortCode: '400000',
      bankAccountNumber: '12345678',
    });
    await ok(owner, 'POST', `/api/jobs/${cross.id}/assignees`, { userId: sub.userId });
    const invoices: { id: string }[] = [];
    for (const job of [cross, mine]) {
      await ok(
        owner,
        'POST',
        `/api/jobs/${job.id}/lines`,
        { description: 'Synthetic credit test', unitCostPence: 1000, qtyMilli: 1000 },
        201,
      );
      invoices.push(
        await ok(owner, 'POST', `/api/jobs/${job.id}/invoices`, { source: 'job' }, 201),
      );
    }
    const credit = invoices[0]!;
    const target = invoices[1]!;
    await ok(owner, 'PATCH', `/api/invoices/${credit.id}`, {
      lines: [
        { kind: 'material', description: 'Synthetic credit', qtyMilli: 1000, unitPricePence: -10 },
      ],
    });
    await ok(owner, 'POST', `/api/invoices/${credit.id}/approve`);
    await ok(owner, 'POST', `/api/invoices/${target.id}/approve`, { useCredit: true });
    await ok(owner, 'POST', `/api/invoices/${target.id}/mark-sent`);
    const body = { amountPence: 1, paidOn: new Date().toISOString().slice(0, 10), method: 'cash' };
    const headers = { 'Idempotency-Key': `credit-reference-${target.id}` };
    const payment = await sub.req('POST', `/api/invoices/${target.id}/payments`, body, headers);
    expect(payment.status).toBe(201);
    expect(payment.body.creditsApplied[0].creditId).toBe(credit.id);
    await ok(owner, 'DELETE', `/api/jobs/${cross.id}/assignees/${sub.userId}`);
    const current = await ok(sub, 'GET', `/api/invoices/${target.id}`);
    expect(current.creditsApplied).toEqual([]);
    expect(JSON.stringify(current)).not.toContain(credit.id);
    expect(
      (await sub.req('POST', `/api/invoices/${target.id}/payments`, body, headers)).status,
    ).toBe(404);
    expect((await ok(owner, 'GET', `/api/invoices/${target.id}`)).paidPence).toBe(1);
  });

  it('cached-response authorization uses live membership even if the previously loaded role says admin', async () => {
    const { owner, sub, mine, cross } = await fixture();
    const key = `stale-auth-${mine.id}`;
    const request = 'synthetic stale-auth request';
    await withTenant(appSql, owner, (tx) =>
      idempotent(tx, { ...owner, role: 'owner' }, key, request, async () => ({
        status: 200,
        body: { jobId: cross.id, title: cross.title },
      })),
    );
    const stale = { ...sub, role: 'owner' as const };
    const response = await withTenant(appSql, sub, (tx) =>
      idempotent(tx, stale, key, request, async () => ({
        status: 200,
        body: { jobId: mine.id, title: mine.title },
      })),
    );
    expect(response.replayed).toBe(false);
    expect(response.body.jobId).toBe(mine.id);
    await ok(owner, 'DELETE', `/api/jobs/${mine.id}/assignees/${sub.userId}`);
    await expect(
      withTenant(appSql, sub, (tx) =>
        idempotent(tx, stale, key, request, async () => ({
          status: 200,
          body: { jobId: mine.id, title: mine.title },
        })),
      ),
    ).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });

  it('Office/custom areas do not widen subcontractor scope; staff Field, accountant and admin behavior stays intact', async () => {
    const { owner, sub, staff, cross, unassigned, mine } = f;
    const accountant = await member(owner, 'accountant');
    await grant(owner, staff, []);
    for (const c of [staff, accountant, owner]) {
      expect((await ok(c, 'GET', '/api/jobs')).total).toBe(3);
      await ok(c, 'GET', `/api/jobs/${cross.id}`);
    }
    expect(
      (await accountant.req('POST', `/api/jobs/${cross.id}/notes`, { body: 'Read only' })).status,
    ).toBe(403);
    for (const areas of [[], ['financials', 'quotes', 'settings'], [...ACCESS_AREAS]]) {
      await grant(owner, sub, areas);
      expect((await ok(sub, 'GET', '/api/jobs')).total).toBe(1);
      expect((await sub.req('GET', `/api/jobs/${unassigned.id}`)).status).toBe(404);
    }
    for (const [method, path, body] of [
      ['GET', '/api/enquiries'],
      ['GET', '/api/proposals'],
      ['GET', '/api/bank/transactions'],
      [
        'POST',
        '/api/enquiries',
        { name: 'Synthetic', phone: '000000', message: 'Synthetic enquiry' },
      ],
      ['POST', '/api/job-stages', { name: 'Global', colour: 'grey' }],
    ] satisfies Probe[])
      expect((await sub.req(method, path, body)).status).toBe(403);
    await grant(owner, sub, [], true);
    expect((await ok(sub, 'GET', '/api/jobs')).total).toBe(3);
    await ok(sub, 'GET', `/api/jobs/${cross.id}`);
    await ok(sub, 'GET', '/api/proposals');
    await grant(owner, sub, []);
    expect((await ok(sub, 'GET', '/api/jobs')).items[0].id).toBe(mine.id);
    expect((await sub.req('GET', `/api/jobs/${cross.id}`)).status).toBe(404);
    await withTenant(
      appSql,
      { tenantId: owner.tenantId, userId: crypto.randomUUID() },
      async (tx) => {
        expect(await tx`SELECT id FROM jobs`).toEqual([]);
      },
    );
  });
});
