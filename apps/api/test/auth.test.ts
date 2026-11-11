import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { DEFAULT_ORIGIN, signIn } from '../src/dev/session-client';
import { sha256Hex } from '../src/lib/crypto';
import { ConsoleMailer } from '../src/lib/mailer';
import { app, client, clientFor, mailer, rawRequest, seedCustomer, toResult } from './api-helpers';
import { addMember, adminSql, appSql, newTenant } from './helpers';

const json = {
  'content-type': 'application/json',
  origin: DEFAULT_ORIGIN,
  'cf-connecting-ip': '198.51.100.7',
};
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  rawRequest(path, {
    method: 'POST',
    headers: { ...json, ...headers },
    body: JSON.stringify(body),
  });

async function issueLink(email: string) {
  const before = mailer.sent.length;
  const r = await post('/api/auth/request-link', { email });
  expect(r.status).toBe(202);
  const mail = mailer.sent.slice(before).find((m) => m.to === email);
  return mail ? new URL(mail.link).hash.replace('#token=', '') : null;
}

describe('magic-link sign-in', () => {
  it('signs in, sets a hardened cookie, and returns the session', async () => {
    const t = await newTenant();
    const token = await issueLink(t.ownerEmail);
    expect(token).toBeTruthy();
    const mail = mailer.sent.at(-1)!;
    expect(mail.link.startsWith(`${DEFAULT_ORIGIN}/sign-in/verify#token=`)).toBe(true);
    expect(mail.expiresInMinutes).toBe(15);

    const r = await post('/api/auth/verify', { token });
    expect(r.status).toBe(200);
    const cookie = r.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^lse_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Max-Age=2592000/);

    const s = await toResult(
      await rawRequest('/api/auth/session', { headers: { cookie: cookie.split(';')[0]! } }),
    );
    expect(s.status).toBe(200);
    expect(s.body.user.email).toBe(t.ownerEmail);
    expect(s.body.tenantId).toBe(t.tenantId);
    expect(s.body.role).toBe('owner');
    expect(s.body.memberships).toHaveLength(1);
    expect(s.body.memberships[0].tenantName).toMatch(/^Test Electrical/);
    expect(typeof s.body.csrfToken).toBe('string');
  });

  it('uses the __Host- secure cookie over HTTPS', async () => {
    const t = await newTenant();
    const token = await issueLink(t.ownerEmail);
    const r = await app.request('https://api.test/api/auth/verify', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ token }),
    });
    expect(r.headers.get('set-cookie')).toMatch(/^__Host-lse_session=.*Secure/i);
  });

  it('gives the same answer for unknown emails and sends nothing', async () => {
    const before = mailer.sent.length;
    const r = await post('/api/auth/request-link', { email: 'nobody@example.test' });
    expect(r.status).toBe(202);
    expect(mailer.sent.length).toBe(before);
  });

  it('only stores hashes of links and sessions', async () => {
    const t = await newTenant();
    const token = (await issueLink(t.ownerEmail))!;
    const rows = await adminSql`SELECT token_hash FROM login_tokens WHERE user_id = ${t.userId}`;
    expect(rows.map((r) => r.tokenHash)).toEqual([await sha256Hex(token)]);
  });

  it('links are single use', async () => {
    const t = await newTenant();
    const token = await issueLink(t.ownerEmail);
    expect((await post('/api/auth/verify', { token })).status).toBe(200);
    const again = await toResult(await post('/api/auth/verify', { token }));
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('link_invalid');
  });

  it('links expire', async () => {
    const t = await newTenant();
    const token = await issueLink(t.ownerEmail);
    await adminSql`UPDATE login_tokens SET expires_at = now() - interval '1 second' WHERE user_id = ${t.userId}`;
    expect((await post('/api/auth/verify', { token })).status).toBe(400);
  });

  it('rejects made-up tokens', async () => {
    expect((await post('/api/auth/verify', { token: 'x'.repeat(43) })).status).toBe(400);
  });

  it('expired sessions are rejected', async () => {
    const c = await client();
    await adminSql`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE user_id = ${c.userId}`;
    expect((await c.req('GET', '/api/customers')).status).toBe(401);
  });

  it('logout ends the session on the server', async () => {
    const c = await client();
    expect((await c.req('GET', '/api/customers')).status).toBe(200);
    expect((await c.req('POST', '/api/auth/logout')).status).toBe(204);
    expect((await c.req('GET', '/api/customers')).status).toBe(401);
  });

  it('the app role cannot read auth tables directly', async () => {
    await expect(appSql`SELECT * FROM sessions`).rejects.toThrow(/permission denied/);
    await expect(appSql`SELECT * FROM login_tokens`).rejects.toThrow(/permission denied/);
  });
});

describe('CSRF', () => {
  it('rejects a mutation without the CSRF token', async () => {
    const c = await client();
    const r = await toResult(
      await c.session.request('POST', '/api/customers', { name: 'X' }, { 'x-csrf-token': '' }),
    );
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('csrf');
  });

  it('rejects a token from a different session', async () => {
    const [a, b] = await Promise.all([client(), client()]);
    const r = await a.session.request(
      'POST',
      '/api/customers',
      { name: 'X' },
      { 'x-csrf-token': b.session.csrfToken },
    );
    expect(r.status).toBe(403);
  });

  it('rejects a foreign Origin even with a valid token', async () => {
    const c = await client();
    const r = await toResult(
      await c.session.request(
        'POST',
        '/api/customers',
        { name: 'X' },
        { origin: 'https://evil.example' },
      ),
    );
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('bad_origin');
  });

  it('reads do not need the token', async () => {
    const c = await client();
    const r = await c.session.request('GET', '/api/customers', undefined, { 'x-csrf-token': '' });
    expect(r.status).toBe(200);
  });
});

describe('rate limiting', () => {
  it('limits sign-in links per email', async () => {
    const t = await newTenant();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await post('/api/auth/request-link', { email: t.ownerEmail })).status);
    }
    expect(statuses).toEqual([202, 202, 202, 202, 202, 429]);
  });

  it('limits per IP, including unknown emails', async () => {
    const m = new ConsoleMailer(() => {});
    const strict = createApp({
      getSql: () => appSql,
      auth: {
        mailer: m,
        appOrigin: DEFAULT_ORIGIN,
        rateLimits: { linkPerIp: { max: 2, windowSeconds: 900 } },
      },
    });
    const ip = `192.0.2.${Math.floor(Math.random() * 250)}-${Date.now()}`;
    const send = (email: string) =>
      strict.request('/api/auth/request-link', {
        method: 'POST',
        headers: { ...json, 'cf-connecting-ip': ip },
        body: JSON.stringify({ email }),
      });
    expect((await send('a@example.test')).status).toBe(202);
    expect((await send('b@example.test')).status).toBe(202);
    const third = await toResult(await send('c@example.test'));
    expect(third.status).toBe(429);
    expect(third.body.error.message).toMatch(/wait a few minutes/);
  });
});

describe('tenant-scoped authorisation', () => {
  it('a session only ever sees its own business', async () => {
    const [a, b] = await Promise.all([client(), client()]);
    const cb = await seedCustomer(b);
    expect((await a.req('GET', `/api/customers/${cb.id}`)).status).toBe(404);
    expect((await a.req('PATCH', `/api/customers/${cb.id}`, { name: 'Hijack' })).status).toBe(404);
    const list = await a.req('GET', '/api/customers');
    expect(list.body.items).toHaveLength(0);
  });

  it('switching business requires membership', async () => {
    const [a, b] = await Promise.all([client(), client()]);
    const r = await a.req('POST', '/api/auth/switch-tenant', { tenantId: b.tenantId });
    expect(r.status).toBe(403);
  });

  it('a member of two businesses can switch, and data follows the active one', async () => {
    const [a, b] = await Promise.all([client(), client()]);
    await seedCustomer(b, { name: 'Only In B' });
    await addMember(b.tenantId, 'staff', a.email);
    const s = await a.req('GET', '/api/auth/session');
    expect(s.body.memberships).toHaveLength(2);
    expect((await a.req('GET', '/api/customers')).body.items).toHaveLength(0);
    expect((await a.req('POST', '/api/auth/switch-tenant', { tenantId: b.tenantId })).status).toBe(
      200,
    );
    const list = await a.req('GET', '/api/customers');
    expect(list.body.items.map((x: { name: string }) => x.name)).toEqual(['Only In B']);
    expect((await a.req('GET', '/api/auth/session')).body.role).toBe('staff');
  });

  it('removing a membership revokes access immediately', async () => {
    const t = await newTenant();
    const email = await addMember(t.tenantId, 'staff');
    const staff = await signIn(app, mailer, email);
    expect((await staff.request('GET', '/api/customers')).status).toBe(200);
    await adminSql`DELETE FROM memberships WHERE tenant_id = ${t.tenantId} AND role = 'staff'`;
    expect((await staff.request('GET', '/api/customers')).status).toBe(403);
  });

  it('staff can read settings but not change them', async () => {
    const t = await newTenant();
    const email = await addMember(t.tenantId, 'staff');
    const [u] = await adminSql<{ id: string }[]>`SELECT id FROM users WHERE email = ${email}`;
    const staff = await clientFor(email, { tenantId: t.tenantId, userId: u!.id });
    expect((await staff.req('GET', '/api/settings')).status).toBe(200);
    const r = await staff.req('PATCH', '/api/settings', { name: 'Taken over' });
    expect(r.status).toBe(403);
  });
});
