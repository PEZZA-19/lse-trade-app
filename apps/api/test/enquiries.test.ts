import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { DEFAULT_ORIGIN } from '../src/dev/session-client';
import {
  app as defaultApp,
  client,
  clientFor,
  mailer,
  seedCustomer,
  type Client,
} from './api-helpers';
import { addMember, adminSql, appSql } from './helpers';

const good = (over: Record<string, unknown> = {}) => ({
  name: 'Robin Example',
  email: 'robin@example.test',
  phone: '07700 900111',
  message: 'Outside light by the gate has stopped working. Could you have a look?',
  startedAt: Date.now() - 20_000,
  turnstileToken: 'stub-ok',
  ...over,
});

async function formKey(c: Client) {
  const r = await c.req('POST', '/api/settings/enquiry-form', { on: true });
  expect(r.status).toBe(200);
  return r.body.formKey as string;
}

/** The public form: no cookie, a foreign Origin, like a post from Joe's website. */
function post(
  key: string,
  body: unknown,
  ip = `10.0.0.${Math.floor(Math.random() * 250)}`,
  app = defaultApp,
) {
  return app.request(`/api/public/enquiries/${key}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://joes-website.example',
      'cf-connecting-ip': ip,
    },
    body: JSON.stringify(body),
  });
}

describe('public enquiry form', () => {
  it('creates a To Do enquiry for the business that owns the key', async () => {
    const c = await client();
    const key = await formKey(c);
    const res = await post(key, good());
    expect(res.status).toBe(202);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const list = await c.req('GET', '/api/enquiries');
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({
      source: 'web_form',
      status: 'todo',
      name: 'Robin Example',
      email: 'robin@example.test',
    });
    // Another business sees nothing.
    const other = await client();
    expect((await other.req('GET', '/api/enquiries')).body).toHaveLength(0);
  });

  it('drops spam quietly: honeypot, too fast, too many links', async () => {
    const c = await client();
    const key = await formKey(c);
    for (const spam of [
      good({ website: 'http://spam.example' }),
      good({ startedAt: Date.now() - 500 }),
      good({ message: 'Buy now http://a.example http://b.example www.c.example' }),
    ]) {
      const res = await post(key, spam);
      expect(res.status).toBe(202);
    }
    expect((await c.req('GET', '/api/enquiries')).body).toHaveLength(0);
  });

  it('refuses a failed Turnstile check, an unknown or old key, and bad input', async () => {
    const c = await client();
    const key = await formKey(c);
    expect((await post(key, good({ turnstileToken: 'stub-fail' }))).status).toBe(400);
    expect((await post(key, good({ turnstileToken: undefined }))).status).toBe(400);
    expect((await post('x'.repeat(24), good())).status).toBe(404);
    expect((await post('short', good())).status).toBe(404);
    expect((await post(key, good({ name: '' }))).status).toBe(422);
    // A new key retires the old one.
    const fresh = await formKey(c);
    expect(fresh).not.toBe(key);
    expect((await post(key, good())).status).toBe(404);
    // Switched off.
    await c.req('POST', '/api/settings/enquiry-form', { on: false });
    expect((await post(fresh, good())).status).toBe(404);
  });

  it('is rate-limited per address and per form', async () => {
    const strict = createApp({
      getSql: () => appSql,
      auth: { mailer, appOrigin: DEFAULT_ORIGIN },
      enquiryLimits: {
        perIp: { max: 2, windowSeconds: 60 },
        perForm: { max: 3, windowSeconds: 60 },
      },
    });
    const c = await client();
    const key = await formKey(c);
    const ip = `10.9.${Math.floor(Math.random() * 250)}.1`;
    expect((await post(key, good(), ip, strict)).status).toBe(202);
    expect((await post(key, good(), ip, strict)).status).toBe(202);
    expect((await post(key, good(), ip, strict)).status).toBe(429);
    // The refused hit never reached the form counter: two so far, the limit is three.
    expect((await post(key, good(), `${ip}0`, strict)).status).toBe(202);
    expect((await post(key, good(), `${ip}1`, strict)).status).toBe(429);
  });

  it('only the owner can turn the form on', async () => {
    const c = await client();
    const s = await clientFor(await addMember(c.tenantId, 'staff'), c);
    expect((await s.req('POST', '/api/settings/enquiry-form', { on: true })).status).toBe(403);
  });
});

describe('enquiry actions', () => {
  it('typed-in enquiries need a way to reply', async () => {
    const c = await client();
    const r = await c.req('POST', '/api/enquiries', { name: 'Sam', message: 'Socket sparking' });
    expect(r.status).toBe(422);
    expect(r.body.error.details.fields.phone).toMatch(/phone number or email/);
  });

  it('converts to a quote for the existing customer matched by email', async () => {
    const c = await client();
    const cust = await seedCustomer(c);
    const e = (
      await c.req('POST', '/api/enquiries', {
        name: 'Farm office',
        email: 'farm@example.com',
        message: 'New sockets in the barn. Three doubles.',
        source: 'email',
      })
    ).body;
    const r = await c.req('POST', `/api/enquiries/${e.id}/convert`, { to: 'quote' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      status: 'converted',
      convertedTo: 'quote',
      customerId: cust.id,
    });
    const q = await c.req('GET', `/api/quotes/${r.body.quoteId}`);
    expect(q.body).toMatchObject({
      customerId: cust.id,
      title: 'New sockets in the barn',
      status: 'draft',
    });
    // Dealt with: no second conversion.
    expect((await c.req('POST', `/api/enquiries/${e.id}/convert`, { to: 'job' })).status).toBe(409);
    expect(
      (await c.req('GET', '/api/enquiries?status=done')).body.map((x: { id: string }) => x.id),
    ).toContain(e.id);
  });

  it('converts to a job with an appointment, adding a new customer', async () => {
    const c = await client();
    const e = (
      await c.req('POST', '/api/enquiries', {
        name: 'Jo New',
        phone: '07700 900222',
        message: 'Fuse keeps tripping',
        address: 'Rue Demo, Sark',
      })
    ).body;
    const r = await c.req('POST', `/api/enquiries/${e.id}/convert`, {
      to: 'appointment',
      startsAt: '2026-11-20T09:00:00Z',
      endsAt: '2026-11-20T10:00:00Z',
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ convertedTo: 'appointment', customerName: 'Jo New' });
    const job = await c.req('GET', `/api/jobs/${r.body.jobId}`);
    expect(job.body.title).toBe('Fuse keeps tripping');
    expect(job.body.stage.systemKey).toBe('scheduled');
    expect(r.body.appointmentId).toBeTruthy();
  });

  it('marks actioned or rejects with a reason, logged in the audit', async () => {
    const c = await client();
    const a = (
      await c.req('POST', '/api/enquiries', { name: 'A', phone: '1', message: 'Just a question' })
    ).body;
    const b = (
      await c.req('POST', '/api/enquiries', { name: 'B', phone: '2', message: 'Can you do gas?' })
    ).body;
    expect((await c.req('POST', `/api/enquiries/${a.id}/actioned`)).body).toMatchObject({
      status: 'actioned',
    });
    const r = await c.req('POST', `/api/enquiries/${b.id}/reject`, { reason: 'Not electrical' });
    expect(r.body).toMatchObject({ status: 'rejected', rejectReason: 'Not electrical' });
    expect(r.body.decidedByName).toBeTruthy();
    const log = await adminSql`SELECT action FROM audit_log WHERE entity_id = ${b.id} ORDER BY id`;
    expect(log.map((l) => l.action)).toEqual(['create', 'rejected']);
    expect((await c.req('GET', '/api/enquiries/counts')).body).toEqual({ todo: 0 });
  });
});
