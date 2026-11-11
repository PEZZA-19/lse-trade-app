import { describe, expect, it } from 'vitest';
import { client, seedCustomer } from './api-helpers';
import { adminSql } from './helpers';

const count = async (table: 'customers' | 'quotes' | 'jobs', tenantId: string) =>
  Number(
    (
      await adminSql<
        { n: string }[]
      >`SELECT count(*) AS n FROM ${adminSql(table)} WHERE tenant_id = ${tenantId}`
    )[0]!.n,
  );

describe('creates are replay-safe with an Idempotency-Key (offline queue, double taps)', () => {
  it('customer, quote and job: a replay returns the first record and makes nothing new', async () => {
    const c = await client();
    const key = (s: string) => ({ 'Idempotency-Key': `create-${s}-${c.tenantId}` });

    const body = {
      name: 'Harbour View Cottage',
      sites: [{ label: 'Home', address: '1 Example Lane' }],
    };
    const a = await c.req('POST', '/api/customers', body, key('cust'));
    const b = await c.req('POST', '/api/customers', body, key('cust'));
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
    expect(b.headers.get('Idempotent-Replayed')).toBe('true');
    expect(await count('customers', c.tenantId)).toBe(1);

    const q = { customerId: a.body.id, siteId: a.body.sites[0].id, title: 'New consumer unit' };
    const q1 = await c.req('POST', '/api/quotes', q, key('quote'));
    const q2 = await c.req('POST', '/api/quotes', q, key('quote'));
    expect(q1.status, JSON.stringify(q1.body)).toBe(201);
    expect(q2.body.id).toBe(q1.body.id);
    expect(q2.body.number).toBe(q1.body.number); // no number used up by the replay
    expect(await count('quotes', c.tenantId)).toBe(1);

    const j = { customerId: a.body.id, title: 'Outside light' };
    const j1 = await c.req('POST', '/api/jobs', j, key('job'));
    const j2 = await c.req('POST', '/api/jobs', j, key('job'));
    expect(j2.body.id).toBe(j1.body.id);
    expect(await count('jobs', c.tenantId)).toBe(1);
  });

  it('the same key with a different body is refused; no key keeps the old behaviour', async () => {
    const c = await client();
    const h = { 'Idempotency-Key': `create-diff-${c.tenantId}` };
    expect((await c.req('POST', '/api/customers', { name: 'One' }, h)).status).toBe(201);
    expect((await c.req('POST', '/api/customers', { name: 'Two' }, h)).status).toBe(422);
    await seedCustomer(c);
    await seedCustomer(c);
    expect(await count('customers', c.tenantId)).toBe(3);
  });
});
