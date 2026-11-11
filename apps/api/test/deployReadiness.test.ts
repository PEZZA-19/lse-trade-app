import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { releaseHeldEmails } from '../src/cron';
import { DEFAULT_ORIGIN } from '../src/dev/session-client';
import { MemoryBlobs, type R2Like } from '../src/lib/blobs';
import { RecordingSender } from '../src/lib/messages';
import { UnconfiguredTurnstile } from '../src/lib/turnstile';
import { describeServices, servicesFor } from '../src/services-for-env';
import { client, mailer, type Client } from './api-helpers';
import { adminSql, appSql } from './helpers';

const fakeBucket = (): R2Like => {
  const m = new MemoryBlobs();
  return {
    put: (k, v, o) => m.put(k, v, o?.httpMetadata?.contentType ?? 'application/octet-stream'),
    get: async (k) => {
      const b = await m.get(k);
      return b
        ? {
            arrayBuffer: async () => b.bytes.buffer as ArrayBuffer,
            httpMetadata: { contentType: b.contentType },
          }
        : null;
    },
    delete: (k) => m.delete(k),
  } as R2Like;
};

const expireHold = (id: string) =>
  adminSql`UPDATE proposals SET hold_until = now() - interval '1 second' WHERE id = ${id}`;

/** An approved reply whose two-minute hold is already over. */
async function heldReply(c: Client, email: string, expire = true) {
  const e = await c.req('POST', '/api/enquiries', {
    name: 'Robin Example',
    email,
    message: 'The outside light by the gate has stopped working.',
    source: 'email',
  });
  const d = await c.req('POST', `/api/enquiries/${e.body.id}/draft-reply`);
  const held = await c.req('POST', `/api/proposals/${d.body.id}/approve`);
  expect(held.body.status).toBe('held');
  if (expire) await expireHold(d.body.id);
  return d.body.id as string;
}
const statusOf = async (id: string) =>
  (await adminSql<{ status: string }[]>`SELECT status FROM proposals WHERE id = ${id}`)[0]!.status;

describe('deploy readiness: service slots', () => {
  it('nothing configured: every slot is off and says so', () => {
    expect(describeServices(servicesFor({}))).toEqual({
      signInEmail: 'not connected',
      approvedEmail: 'not connected',
      websiteForm: 'off (no Turnstile secret)',
      photos: 'not set up',
    });
  });

  it('a Turnstile secret and an R2 binding switch those slots on; email stays off', () => {
    const d = describeServices(servicesFor({ TURNSTILE_SECRET: 'x', PHOTOS: fakeBucket() }));
    expect(d).toMatchObject({
      websiteForm: 'Turnstile on',
      photos: 'R2',
      approvedEmail: 'not connected',
    });
    expect(JSON.stringify(d)).not.toContain('"x"'); // never echoes the secret
  });

  it('without Turnstile the website form is refused with a clear 503, not left open', async () => {
    const app = createApp({
      getSql: () => appSql,
      auth: { mailer, appOrigin: DEFAULT_ORIGIN },
      turnstile: new UnconfiguredTurnstile(),
    });
    const c = await client();
    const key = (await c.req('POST', '/api/settings/enquiry-form', { on: true })).body.formKey;
    const res = await app.request(`/api/public/enquiries/${key}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://site.example',
        'cf-connecting-ip': '10.9.9.9',
      },
      body: JSON.stringify({
        name: 'Robin Example',
        email: 'robin@example.test',
        message: 'Outside light by the gate has stopped working.',
        startedAt: Date.now() - 20_000,
        turnstileToken: 'anything',
      }),
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'form_not_configured',
    );
    const [n] = await adminSql<
      { n: string }[]
    >`SELECT count(*) AS n FROM enquiries WHERE tenant_id = ${c.tenantId}`;
    expect(Number(n!.n)).toBe(0);
  });
});

describe('deploy readiness: cron releases held emails', () => {
  it('releases due emails for every business, each in its own scope; held-but-not-due stay held', async () => {
    const a = await client();
    const b = await client();
    // Approve everything first (any request also releases that business's due emails on view).
    const pa = await heldReply(a, 'robin@example.test', false);
    const pb = await heldReply(b, 'sam@example.test', false);
    const pk = await heldReply(a, 'kim@example.test', false); // stays inside its two minutes
    await expireHold(pa);
    await expireHold(pb);

    const sender = new RecordingSender();
    const r = await releaseHeldEmails(appSql, sender);
    expect(r.failed).toEqual([]);
    expect(r.released).toBeGreaterThanOrEqual(2);
    expect(await statusOf(pa)).toBe('sent');
    expect(await statusOf(pb)).toBe('sent');
    expect(await statusOf(pk)).toBe('held');
    expect(sender.sent.map((m) => m.to)).toEqual(
      expect.arrayContaining(['robin@example.test', 'sam@example.test']),
    );
    expect(sender.sent.map((m) => m.to)).not.toContain('kim@example.test');
    // Logged with no person as the actor.
    const [ev] = await adminSql<
      { event: string; byUser: string | null }[]
    >`SELECT event, by_user FROM proposal_events WHERE proposal_id = ${pa} ORDER BY created_at DESC LIMIT 1`;
    expect(ev).toEqual({ event: 'sent', byUser: null });
    // Running again sends nothing twice.
    const again = await releaseHeldEmails(appSql, sender);
    expect(sender.sent.filter((m) => m.to === 'robin@example.test')).toHaveLength(1);
    expect(again.failed).toEqual([]);
  });

  it('with no email provider (production today) they end "not sent", never silently dropped', async () => {
    const c = await client();
    const p = await heldReply(c, 'lee@example.test');
    await releaseHeldEmails(appSql, null);
    expect(await statusOf(p)).toBe('send_blocked');
  });

  it('the app role cannot read held emails across businesses without the narrow function', async () => {
    const c = await client();
    await heldReply(c, 'ali@example.test');
    const rows = await appSql`SELECT id FROM proposals`;
    expect(rows).toHaveLength(0);
    const due = await appSql<{ tenantId: string }[]>`SELECT tenant_id FROM held_due_tenants()`;
    expect(due.map((r) => r.tenantId)).toContain(c.tenantId);
    expect(Object.keys(due[0]!)).toEqual(['tenantId']);
  });
});
