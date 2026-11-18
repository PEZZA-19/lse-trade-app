import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { signIn, DEFAULT_ORIGIN } from '../src/dev/session-client';
import { FakeGoogle } from '../src/dev/fakeGoogle';
import { sealingKey, seal, unseal, SealError, pkceChallenge } from '../src/lib/sealed';
import { syncDue } from '../src/services/calendarSync';
import { googleFromEnv, type GoogleCalendar } from '../src/services/googleCalendar';
import { mailer, toResult } from './api-helpers';
import { addMember, adminSql, appSql, newTenant } from './helpers';

/*
 * Google Calendar two-way sync against a faked Google (dev/fakeGoogle.ts): OAuth sign-in with
 * PKCE, the dedicated "LSE jobs" calendar, sealed refresh tokens, incremental sync with sync
 * tokens, and "needs setting up" until a real OAuth client is configured.
 */
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const generous = { max: 10_000, windowSeconds: 60 };
const BASE = Math.ceil(Date.now() / 3_600_000) * 3_600_000;
const h = (hours: number) => new Date(BASE + hours * 3_600_000).toISOString();

async function setup(opts: { configured?: boolean } = {}) {
  const fake = new FakeGoogle();
  const { google } = await googleFromEnv(
    opts.configured === false
      ? {}
      : {
          GOOGLE_CLIENT_ID: fake.clientId,
          GOOGLE_CLIENT_SECRET: fake.clientSecret,
          CALENDAR_TOKEN_KEY: KEY,
        },
    DEFAULT_ORIGIN,
    fake.fetch,
  );
  const app = createApp({
    getSql: () => appSql,
    auth: {
      mailer,
      appOrigin: DEFAULT_ORIGIN,
      rateLimits: { linkPerIp: generous, verifyPerIp: generous },
    },
    calendarLimits: { perIp: generous, perFeed: generous },
    google,
  });
  const t = await newTenant();
  const session = await signIn(app, mailer, t.ownerEmail);
  const req = async (method: string, path: string, body?: unknown) =>
    toResult(await session.request(method, path, body));
  const raw = (method: string, path: string) => session.request(method, path);
  return { fake, google: google as GoogleCalendar, app, t, req, raw };
}

/** Connect → Google's page → back to the callback. Returns where the app sent the browser. */
async function connect(s: Awaited<ReturnType<typeof setup>>, email = 'joe@example.com') {
  const start = await s.req('POST', '/api/calendar-sync/connect/google');
  expect(start.status, JSON.stringify(start.body)).toBe(200);
  const g = s.fake.authorize(start.body.url, { email });
  const cb = new URL(g.redirectUri);
  const res = await s.raw(
    'GET',
    `${cb.pathname}?code=${g.code}&state=${encodeURIComponent(g.state)}`,
  );
  expect(res.status).toBe(302);
  return new URL(res.headers.get('location')!);
}

async function book(s: Awaited<ReturnType<typeof setup>>, at = 24) {
  const cust = (await s.req('POST', '/api/customers', { name: 'Seigneurie Farm' })).body;
  const job = (await s.req('POST', '/api/jobs', { customerId: cust.id, title: 'Barn rewire' }))
    .body;
  const r = await s.req('POST', `/api/jobs/${job.id}/appointments`, {
    startsAt: h(at),
    endsAt: h(at + 2),
    userId: s.t.userId,
  });
  return { job, appt: r.body.appointments[0] };
}

describe('Google Calendar: not set up yet', () => {
  it('says plainly it needs setting up, and the callback goes back with that message', async () => {
    const s = await setup({ configured: false });
    expect((await s.req('GET', '/api/calendar-sync')).body).toEqual({
      available: { google: false },
      connections: [],
    });
    const r = await s.req('POST', '/api/calendar-sync/connect/google');
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('not_configured');
    expect(r.body.error.message).toMatch(/needs setting up/);
    const cb = await s.raw('GET', '/api/calendar-sync/google/callback?code=x&state=y');
    expect(cb.status).toBe(302);
    expect(new URL(cb.headers.get('location')!).searchParams.get('calendar_error')).toMatch(
      /needs setting up/,
    );
    // Outlook is gone: only Google can be asked for.
    expect((await s.req('POST', '/api/calendar-sync/connect/microsoft')).status).toBe(422);
  });

  it('needs all three settings; a malformed token key fails loudly', async () => {
    expect((await googleFromEnv({ GOOGLE_CLIENT_ID: 'x' }, DEFAULT_ORIGIN)).missing).toEqual([
      'GOOGLE_CLIENT_SECRET',
      'CALENDAR_TOKEN_KEY',
    ]);
    await expect(
      googleFromEnv(
        { GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'y', CALENDAR_TOKEN_KEY: 'c2hvcnQ=' },
        DEFAULT_ORIGIN,
      ),
    ).rejects.toThrow(/32 random bytes/);
  });
});

describe('sealed tokens', () => {
  it('round-trips, is bound to the person, and refuses tampering or the wrong key', async () => {
    const key = await sealingKey(KEY);
    const sealed = await seal(key, 'refresh-123', 'calendar:u1');
    expect(sealed).toMatch(/^v1\.[\w-]+\.[\w-]+$/);
    expect(sealed).not.toContain('refresh-123');
    expect(await unseal(key, sealed, 'calendar:u1')).toBe('refresh-123');
    await expect(unseal(key, sealed, 'calendar:u2')).rejects.toBeInstanceOf(SealError);
    const other = await sealingKey(btoa('x'.repeat(32)));
    await expect(unseal(other, sealed, 'calendar:u1')).rejects.toBeInstanceOf(SealError);
    const bad = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'B' : 'A') + sealed.slice(-1);
    await expect(unseal(key, bad, 'calendar:u1')).rejects.toBeInstanceOf(SealError);
    // PKCE S256 = base64url(SHA-256(verifier)), checked against Node's own crypto.
    const v = 'dBjftJeZ4CVP-mJ92K9qr4yJdK2dCcU7Q4R0PsZpYKk';
    expect(await pkceChallenge(v)).toBe(createHash('sha256').update(v).digest('base64url'));
  });
});

describe('Google Calendar: sign-in and sync (faked Google)', () => {
  it('connects with PKCE, makes the "LSE jobs" calendar, stores only a sealed refresh token', async () => {
    const s = await setup();
    const start = await s.req('POST', '/api/calendar-sync/connect/google');
    const u = new URL(start.body.url);
    expect(u.searchParams.get('scope')).toBe(
      'openid email https://www.googleapis.com/auth/calendar.app.created',
    );
    expect(u.searchParams.get('redirect_uri')).toBe(
      `${DEFAULT_ORIGIN}/api/calendar-sync/google/callback`,
    );
    expect(u.searchParams.get('prompt')).toBe('consent');
    const g = s.fake.authorize(start.body.url, { email: 'joe@example.com' });
    const res = await s.raw(
      'GET',
      `/api/calendar-sync/google/callback?code=${g.code}&state=${encodeURIComponent(g.state)}`,
    );
    const back = new URL(res.headers.get('location')!);
    expect(back.pathname).toBe('/calendar');
    expect(back.searchParams.get('connected')).toBe('google');
    expect(back.searchParams.get('account')).toBe('joe@example.com');

    const cals = [...s.fake.calendars.values()];
    expect(cals.map((c) => [c.summary, c.timeZone])).toEqual([['LSE jobs', 'Europe/Guernsey']]);
    const [row] = await adminSql<{ tokenEnc: string; calendarId: string }[]>`
      SELECT token_enc, calendar_id FROM calendar_connections WHERE user_id = ${s.t.userId}`;
    expect(row!.calendarId).toBe(cals[0]!.id);
    expect(row!.tokenEnc).toMatch(/^v1\./);
    expect(row!.tokenEnc).not.toMatch(/refresh-/);
    // The one-off state is used up: replaying the same redirect does nothing.
    const again = await s.raw(
      'GET',
      `/api/calendar-sync/google/callback?code=${g.code}&state=${encodeURIComponent(g.state)}`,
    );
    expect(new URL(again.headers.get('location')!).searchParams.get('calendar_error')).toMatch(
      /expired or wasn’t started here/,
    );
    const st = (await s.req('GET', '/api/calendar-sync')).body;
    expect(st.available).toEqual({ google: true });
    expect(st.connections).toMatchObject([
      {
        provider: 'google',
        accountEmail: 'joe@example.com',
        calendarName: 'LSE jobs',
        status: 'connected',
      },
    ]);
  });

  it('refuses a state started by someone else, a denied consent, and a missing calendar scope', async () => {
    const s = await setup();
    const start = await s.req('POST', '/api/calendar-sync/connect/google');
    const g = s.fake.authorize(start.body.url);
    // Another person in the same business can't finish Joe's sign-in.
    const staffEmail = `staff-${Date.now()}@example.test`;
    await addMember(s.t.tenantId, 'staff', staffEmail);
    const staff = await signIn(s.app, mailer, staffEmail);
    const r = await staff.request(
      'GET',
      `/api/calendar-sync/google/callback?code=${g.code}&state=${encodeURIComponent(g.state)}`,
    );
    expect(new URL(r.headers.get('location')!).searchParams.get('calendar_error')).toMatch(
      /expired/,
    );
    const denied = await s.raw('GET', '/api/calendar-sync/google/callback?error=access_denied');
    expect(new URL(denied.headers.get('location')!).searchParams.get('calendar_error')).toMatch(
      /didn’t allow access/,
    );
    const start2 = await s.req('POST', '/api/calendar-sync/connect/google');
    const g2 = s.fake.authorize(start2.body.url, { scope: 'openid email' });
    const r2 = await s.raw(
      'GET',
      `/api/calendar-sync/google/callback?code=${g2.code}&state=${encodeURIComponent(g2.state)}`,
    );
    expect(new URL(r2.headers.get('location')!).searchParams.get('calendar_error')).toMatch(
      /Tick the calendar box/,
    );
    expect((await s.req('GET', '/api/calendar-sync')).body.connections).toEqual([]);
  });

  it('pushes bookings, reads changes incrementally (paged), turns a Google move into a proposal', async () => {
    const s = await setup();
    await connect(s);
    const a = await book(s, 24);
    const b = await book(s, 48);
    const c = await book(s, 72);
    const run1 = (await s.req('POST', '/api/calendar-sync/run')).body;
    expect(run1).toMatchObject({ created: 3, proposals: 0, problems: [] });
    const calId = [...s.fake.calendars.keys()][0]!;
    const live = s.fake.live(calId);
    expect(live).toHaveLength(3);
    const evA = live.find((e) => e.extendedProperties?.private?.lseId === a.appt.id)!;
    expect(evA.summary).toMatch(/^Job \d+: Barn rewire$/);
    expect(evA.start.dateTime).toBe(h(24));
    expect(JSON.stringify(live)).not.toMatch(/£/);

    // Our own writes echo back (3 events over 2 pages): nothing to approve.
    const run2 = (await s.req('POST', '/api/calendar-sync/run')).body;
    expect(run2).toMatchObject({ created: 0, updated: 0, proposals: 0 });
    const lists = s.fake.requests.filter((r) => r.startsWith('GET') && r.endsWith('/events'));
    expect(lists.length).toBeGreaterThanOrEqual(3);

    // Someone moves A and deletes B in Google, and adds an all-day event of their own.
    s.fake.move(calId, evA.id, h(30), h(32));
    const evB = live.find((e) => e.extendedProperties?.private?.lseId === b.appt.id)!;
    s.fake.remove(calId, evB.id);
    s.fake.addAllDay(calId, h(100).slice(0, 10));
    const run3 = (await s.req('POST', '/api/calendar-sync/run')).body;
    expect(run3.proposals).toBe(2);
    const props = (await s.req('GET', '/api/proposals')).body;
    const cal = (props.items ?? props).filter(
      (p: { kind: string }) => p.kind === 'calendar_change',
    );
    expect(cal.map((p: { title: string }) => p.title).sort()).toEqual(
      [
        `Job ${a.job.number}: moved in Google Calendar`,
        `Job ${b.job.number}: deleted in Google Calendar`,
      ].sort(),
    );
    // Moving C in the app goes out as an update.
    const moved = await s.req('PATCH', `/api/appointments/${c.appt.id}`, {
      startsAt: h(80),
      endsAt: h(81),
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    const run4 = (await s.req('POST', '/api/calendar-sync/run')).body;
    expect(run4.updated).toBe(1);
    const evC = s.fake.live(calId).find((e) => e.extendedProperties?.private?.lseId === c.appt.id)!;
    expect(evC.start.dateTime).toBe(h(80));
  });

  it('an expired sync token means a full read; access removed in Google means "connect again"', async () => {
    const s = await setup();
    await connect(s);
    await book(s, 24);
    await s.req('POST', '/api/calendar-sync/run');
    s.fake.expireTokensBefore = 10_000;
    s.fake.expireAccessTokens();
    const r = (await s.req('POST', '/api/calendar-sync/run')).body;
    expect(r).toMatchObject({ created: 0, proposals: 0, problems: [] });

    s.fake.revokeAll();
    const r2 = (await s.req('POST', '/api/calendar-sync/run')).body;
    expect(r2.problems).toEqual([
      'Google no longer allows access (it was removed in the Google account, or it expired). Connect again.',
    ]);
    const st = (await s.req('GET', '/api/calendar-sync')).body;
    expect(st.connections[0]).toMatchObject({ status: 'needs_reconnect' });
    expect(st.connections[0].lastError).toMatch(/Connect again/);
    // Connecting again reuses the same LSE jobs calendar and clears the problem.
    await connect(s);
    expect(s.fake.calendars.size).toBe(1);
    const st2 = (await s.req('GET', '/api/calendar-sync')).body;
    expect(st2.connections[0]).toMatchObject({ status: 'connected', lastError: null });
  });

  it('if the LSE jobs calendar is deleted in Google, reconnecting makes a new one and refills it', async () => {
    const s = await setup();
    await connect(s);
    await book(s, 24);
    await s.req('POST', '/api/calendar-sync/run');
    const first = [...s.fake.calendars.keys()][0]!;
    s.fake.deleteCalendar(first);
    const r = (await s.req('POST', '/api/calendar-sync/run')).body;
    expect(r.problems[0]).toMatch(/calendar was deleted in Google/);
    await connect(s);
    const second = [...s.fake.calendars.keys()].find((k) => k !== first)!;
    expect(second).toBeTruthy();
    const r2 = (await s.req('POST', '/api/calendar-sync/run')).body;
    expect(r2.created).toBe(1);
    expect(s.fake.live(second)).toHaveLength(1);
  });

  it('the schedule syncs connected calendars that are due, on its own', async () => {
    const s = await setup();
    await connect(s);
    await book(s, 24);
    const r = await syncDue(appSql, { google: s.google }, DEFAULT_ORIGIN, '0 seconds');
    expect(r.failed).toBe(0);
    expect(r.synced).toBeGreaterThanOrEqual(1);
    expect(s.fake.live([...s.fake.calendars.keys()][0]!)).toHaveLength(1);
    // Just synced: not due again within the interval.
    const [before] = await adminSql<{ at: Date }[]>`
      SELECT last_synced_at AS at FROM calendar_connections WHERE user_id = ${s.t.userId}`;
    await syncDue(appSql, { google: s.google }, DEFAULT_ORIGIN, '15 minutes');
    const [after] = await adminSql<{ at: Date }[]>`
      SELECT last_synced_at AS at FROM calendar_connections WHERE user_id = ${s.t.userId}`;
    expect(after!.at.getTime()).toBe(before!.at.getTime());
  });
});
