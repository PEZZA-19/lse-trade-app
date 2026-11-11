import { describe, expect, it } from 'vitest';
import { client, seedCustomer } from './api-helpers';

async function setup() {
  const c = await client();
  const cust = await seedCustomer(c);
  const job = await c.req('POST', '/api/jobs', { customerId: cust.id, siteId: cust.sites[0].id, title: 'Fuse board' });
  expect(job.status).toBe(201);
  return { c, cust, job: job.body };
}

describe('row versions and If-Match (offline sync)', () => {
  it('every change bumps the version', async () => {
    const { c, job } = await setup();
    expect(job.version).toBe(1);
    const r = await c.req('PATCH', `/api/jobs/${job.id}`, { status: 'scheduled' });
    expect(r.body.version).toBe(2);
  });

  it('accepts an edit made from the current version', async () => {
    const { c, job } = await setup();
    const r = await c.req('PATCH', `/api/jobs/${job.id}`, { status: 'in_progress' }, { 'if-match': '"1"' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('in_progress');
  });

  it('refuses a stale edit with 409 and returns the current record, changing nothing', async () => {
    const { c, job } = await setup();
    await c.req('PATCH', `/api/jobs/${job.id}`, { title: 'Changed on the laptop' });
    const stale = await c.req('PATCH', `/api/jobs/${job.id}`, { status: 'completed' }, { 'if-match': '1' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('version_conflict');
    expect(stale.body.error.details.current).toMatchObject({ title: 'Changed on the laptop', status: 'open', version: 2 });
    expect((await c.req('GET', `/api/jobs/${job.id}`)).body.status).toBe('open');
  });

  it('quotes: stale draft edits are refused too', async () => {
    const { c, cust } = await setup();
    const q = (
      await c.req('POST', '/api/quotes', { customerId: cust.id, title: 'Sockets', lines: [] })
    ).body;
    const v = q.version;
    expect((await c.req('PATCH', `/api/quotes/${q.id}`, { title: 'A' }, { 'if-match': String(v) })).status).toBe(200);
    const stale = await c.req('PATCH', `/api/quotes/${q.id}`, { title: 'B' }, { 'if-match': String(v) });
    expect(stale.status).toBe(409);
    expect(stale.body.error.details.current.current.title).toBe('A');
  });

  it('rejects a malformed If-Match', async () => {
    const { c, job } = await setup();
    expect((await c.req('PATCH', `/api/jobs/${job.id}`, { status: 'open' }, { 'if-match': 'abc' })).status).toBe(400);
  });
});
