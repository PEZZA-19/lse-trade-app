import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { app, client, clientFor, seedCustomer, type Client } from './api-helpers';
import { addMember, adminSql, appSql } from './helpers';

const h = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
const fetchFeed = async (path: string, a = app) => {
  const res = await a.request(path);
  return { status: res.status, type: res.headers.get('content-type'), text: await res.text() };
};
const unfold = (s: string) => s.replace(/\r\n /g, '');

async function staffOf(c: Client) {
  const email = await addMember(c.tenantId, 'staff');
  const [u] = await adminSql<{ id: string }[]>`SELECT id FROM users WHERE email = ${email}`;
  return { s: await clientFor(email, { tenantId: c.tenantId, userId: u!.id }), id: u!.id };
}

async function seed(c: Client, staffId: string) {
  const cust = await seedCustomer(c, { name: 'Brown, Mrs; Sark', phone: '01481 000111' });
  const job = (
    await c.req('POST', '/api/jobs', { customerId: cust.id, title: 'Rewire, kitchen; hall' })
  ).body;
  const after = (
    await c.req('POST', `/api/jobs/${job.id}/appointments`, {
      startsAt: h(24),
      endsAt: h(26),
      userId: staffId,
    })
  ).body;
  const staffAppt = after.appointments.find((a: { userId: string }) => a.userId === staffId);
  const after2 = (
    await c.req('POST', `/api/jobs/${job.id}/appointments`, {
      startsAt: h(48),
      endsAt: h(49),
      userId: c.userId,
    })
  ).body;
  const ownerAppt = after2.appointments.find((a: { userId: string }) => a.userId === c.userId);
  return { job, staffAppt, ownerAppt };
}

describe('calendar feed (one-way iCal subscription)', () => {
  it('each person gets their own private feed; valid iCal with no money', async () => {
    const c = await client();
    const staff = await staffOf(c);
    const { staffAppt, ownerAppt } = await seed(c, staff.id);

    const mine = await staff.s.req('POST', '/api/calendar-feeds/mine');
    expect(mine.status).toBe(200);
    expect(mine.body.path).toMatch(/^\/api\/public\/calendar\/[A-Za-z0-9_-]{43}\.ics$/);
    // Staff only ever see their own link, and no 'all jobs' link.
    const list = (await staff.s.req('GET', '/api/calendar-feeds')).body;
    expect(list.map((f: { scope: string }) => f.scope)).toEqual(['mine']);
    const all = await staff.s.req('POST', '/api/calendar-feeds/all');
    expect(all.status).toBe(403);
    expect(all.body.error.code).toBe('admin_only');

    const feed = await fetchFeed(mine.body.path);
    expect(feed.status).toBe(200);
    expect(feed.type).toBe('text/calendar; charset=utf-8');
    const u = unfold(feed.text);
    expect(u.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(u).toContain(`UID:${staffAppt.id}@lse-trade`);
    expect(u).not.toContain(ownerAppt.id);
    expect(u).toMatch(/DTSTAMP:\d{8}T\d{6}Z/);
    const start = new Date(staffAppt.startsAt);
    const utc = start
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, '');
    expect(u).toContain(`DTSTART:${utc}`);
    expect(u).toContain('Rewire\\, kitchen\\; hall');
    expect(u).toContain('Brown\\, Mrs\\; Sark\\nPhone: 01481 000111');
    expect(feed.text).not.toMatch(/£|price|total|invoice/i);
    for (const line of feed.text.split('\r\n'))
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
  });

  it('owner and admins can have an all-jobs feed; it stops when admin is taken away', async () => {
    const c = await client();
    const staff = await staffOf(c);
    const { staffAppt, ownerAppt } = await seed(c, staff.id);
    const all = (await c.req('POST', '/api/calendar-feeds/all')).body;
    const u = (await fetchFeed(all.path)).text;
    expect(u).toContain(staffAppt.id);
    expect(u).toContain(ownerAppt.id);
    // The owner's own feed has only the owner's booking.
    const mine = (await c.req('POST', '/api/calendar-feeds/mine')).body;
    expect((await fetchFeed(mine.path)).text).not.toContain(staffAppt.id);

    await c.req('PUT', `/api/team/${staff.id}/access`, { isAdmin: true, areas: [] });
    const samAll = (await staff.s.req('POST', '/api/calendar-feeds/all')).body;
    expect((await fetchFeed(samAll.path)).status).toBe(200);
    await c.req('PUT', `/api/team/${staff.id}/access`, { isAdmin: false, areas: [] });
    expect((await fetchFeed(samAll.path)).status).toBe(404);
  });

  it('regenerating or switching off a link makes the old one 404; unknown links 404', async () => {
    const c = await client();
    const first = (await c.req('POST', '/api/calendar-feeds/mine')).body.path;
    expect((await fetchFeed(first)).status).toBe(200);
    const second = (await c.req('POST', '/api/calendar-feeds/mine')).body.path;
    expect(second).not.toBe(first);
    expect((await fetchFeed(first)).status).toBe(404);
    expect((await fetchFeed(second)).status).toBe(200);
    const off = await c.req('DELETE', '/api/calendar-feeds/mine');
    expect(off.body[0].path).toBeNull();
    expect((await fetchFeed(second)).status).toBe(404);
    expect((await fetchFeed('/api/public/calendar/not-a-token.ics')).status).toBe(404);
    expect((await fetchFeed(`/api/public/calendar/${'x'.repeat(43)}.ics`)).status).toBe(404);
  });

  it('cancelled jobs and removed bookings drop out of the feed', async () => {
    const c = await client();
    const staff = await staffOf(c);
    const { job, staffAppt, ownerAppt } = await seed(c, staff.id);
    const path = (await c.req('POST', '/api/calendar-feeds/all')).body.path;
    await c.req('DELETE', `/api/appointments/${ownerAppt.id}`);
    let u = (await fetchFeed(path)).text;
    expect(u).not.toContain(ownerAppt.id);
    expect(u).toContain(staffAppt.id);
    await c.req('PATCH', `/api/jobs/${job.id}`, { stageKey: 'cancelled' });
    u = (await fetchFeed(path)).text;
    expect(u).not.toContain(staffAppt.id);
    expect(u).not.toContain('BEGIN:VEVENT');
  });

  it('a feed never shows another business’s jobs, and links are per person', async () => {
    const a = await client();
    const b = await client();
    const bStaff = await staffOf(b);
    const { staffAppt: bAppt } = await seed(b, bStaff.id);
    const aAll = (await a.req('POST', '/api/calendar-feeds/all')).body.path;
    expect((await fetchFeed(aAll)).text).not.toContain(bAppt.id);
    // B can't see or switch off A's link.
    expect((await b.req('GET', '/api/calendar-feeds')).body[1].path).toBeNull();
    await b.req('DELETE', '/api/calendar-feeds/all');
    expect((await fetchFeed(aAll)).status).toBe(200);
    // Nobody can read the table directly across businesses.
    const rows = await appSql.begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${b.tenantId}, true), set_config('app.user_id', ${b.userId}, true)`;
      return tx`SELECT token FROM calendar_feeds`;
    });
    expect(rows).toHaveLength(0);
  });

  it('works for a field worker with no areas; stops when the person leaves the business', async () => {
    const c = await client();
    const staff = await staffOf(c);
    const { staffAppt } = await seed(c, staff.id);
    await c.req('PUT', `/api/team/${staff.id}/access`, { isAdmin: false, areas: [] });
    expect((await staff.s.req('GET', '/api/calendar-feeds')).status).toBe(200);
    const path = (await staff.s.req('POST', '/api/calendar-feeds/mine')).body.path;
    expect((await fetchFeed(path)).text).toContain(staffAppt.id);
    await adminSql`DELETE FROM memberships WHERE tenant_id = ${c.tenantId} AND user_id = ${staff.id}`;
    expect((await fetchFeed(path)).status).toBe(404);
  });

  it('is rate-limited per link', async () => {
    const c = await client();
    const limited = createApp({
      getSql: () => appSql,
      auth: {
        mailer: { send: async () => {} } as never,
        appOrigin: 'http://x',
        rateLimits: {} as never,
      },
      calendarLimits: {
        perIp: { max: 1000, windowSeconds: 60 },
        perFeed: { max: 2, windowSeconds: 60 },
      },
    });
    const path = (await c.req('POST', '/api/calendar-feeds/mine')).body.path;
    expect((await fetchFeed(path, limited)).status).toBe(200);
    expect((await fetchFeed(path, limited)).status).toBe(200);
    expect((await fetchFeed(path, limited)).status).toBe(429);
  });
});
