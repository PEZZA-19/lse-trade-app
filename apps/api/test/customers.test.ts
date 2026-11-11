import { describe, expect, it } from 'vitest';
import { client, rawRequest, seedCustomer } from './api-helpers';

describe('auth and tenancy', () => {
  it('rejects requests without a user', async () => {
    const res = await rawRequest('/api/customers', {});
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('unauthenticated');
  });

  it('rejects a business the user is not a member of', async () => {
    const [a, b] = await Promise.all([client(), client()]);
    const r = await a.req('GET', '/api/customers', undefined, { 'x-tenant-id': b.tenantId });
    expect(r.status).toBe(403);
  });

  it('returns the signed-in user and business defaults', async () => {
    const c = await client();
    const r = await c.req('GET', '/api/me');
    expect(r.status).toBe(200);
    expect(r.body.tenant.defaultMarkupBp).toBe(13000);
    expect(r.body.tenant.labourRatePence).toBe(4500);
    expect(r.body.role).toBe('owner');
  });
});

describe('customers', () => {
  it('creates a customer with sites and role-based contacts, normalising input', async () => {
    const c = await client();
    const r = await c.req('POST', '/api/customers', {
      name: '  Old Hall  ',
      email: 'Owner@Example.COM',
      phone: '',
      sites: [
        { address: 'Old Hall, Little Sark' },
        { label: 'Cottage', address: 'Old Hall Cottage' },
      ],
      contacts: [
        { name: 'Pat Landlord', role: 'landlord', email: 'pat@example.com' },
        { name: 'Sam Tenant', role: 'tenant', phone: '01481 000000', siteIndex: 1 },
        { name: 'Accounts', role: 'bill_payer', email: 'Accounts@Example.com' },
      ],
    });
    expect(r.status).toBe(201);
    expect(r.body.name).toBe('Old Hall');
    expect(r.body.email).toBe('owner@example.com');
    expect(r.body.phone).toBeNull();
    expect(r.body.sites).toHaveLength(2);
    expect(r.body.contacts.map((x: { role: string }) => x.role)).toEqual([
      'landlord',
      'tenant',
      'bill_payer',
    ]);
    expect(r.body.contacts[1].siteId).toBe(r.body.sites[1].id);
    expect(r.body.contacts[2].email).toBe('accounts@example.com');
  });

  it('validates with plain-English messages per field', async () => {
    const c = await client();
    const r = await c.req('POST', '/api/customers', { name: '', email: 'not-an-email' });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('validation_failed');
    expect(r.body.error.details.fields).toMatchObject({
      name: 'Name is required',
      email: 'Enter a valid email',
    });
  });

  it('rejects malformed JSON', async () => {
    const c = await client();
    const res = await rawRequest('/api/customers', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': c.userId },
      body: '{nope',
    });
    expect(res.status).toBe(422);
  });

  it('lists, searches and pages', async () => {
    const c = await client();
    for (const name of ['Charlie', 'alpha', 'Bravo 100%'])
      await c.req('POST', '/api/customers', { name });
    const all = await c.req('GET', '/api/customers');
    expect(all.body.items.map((x: { name: string }) => x.name)).toEqual([
      'alpha',
      'Bravo 100%',
      'Charlie',
    ]);
    expect(all.body.total).toBe(3);
    const search = await c.req('GET', '/api/customers?q=100%25');
    expect(search.body.items).toHaveLength(1);
    const page = await c.req('GET', '/api/customers?limit=1&offset=1');
    expect(page.body.items[0].name).toBe('Bravo 100%');
    expect(page.body.total).toBe(3);
    expect((await c.req('GET', '/api/customers?limit=0')).status).toBe(422);
  });

  it('updates fields and returns 404 for unknown or foreign ids', async () => {
    const [a, b] = await Promise.all([client(), client()]);
    const cust = await seedCustomer(a);
    const r = await a.req('PATCH', `/api/customers/${cust.id}`, {
      phone: '07781 123456',
      markupBp: 11000,
    });
    expect(r.status).toBe(200);
    expect(r.body.phone).toBe('07781 123456');
    expect(r.body.markupBp).toBe(11000);
    expect((await b.req('GET', `/api/customers/${cust.id}`)).status).toBe(404);
    expect((await b.req('PATCH', `/api/customers/${cust.id}`, { name: 'x' })).status).toBe(404);
    expect((await a.req('GET', '/api/customers/not-a-uuid')).status).toBe(404);
  });

  it('adds sites and contacts, and keeps a contact on its own customer’s sites', async () => {
    const c = await client();
    const one = await seedCustomer(c);
    const two = await seedCustomer(c, { name: 'Other' });
    const site = await c.req('POST', `/api/customers/${one.id}/sites`, { address: 'La Coupée' });
    expect(site.status).toBe(201);
    const ok = await c.req('POST', `/api/customers/${one.id}/contacts`, {
      name: 'Jo',
      role: 'site_contact',
      siteId: site.body.id,
    });
    expect(ok.status).toBe(201);
    const bad = await c.req('POST', `/api/customers/${two.id}/contacts`, {
      name: 'Jo',
      siteId: site.body.id,
    });
    expect(bad.status).toBe(422);
    const upd = await c.req('PATCH', `/api/contacts/${ok.body.id}`, { role: 'agent' });
    expect(upd.body.role).toBe('agent');
    expect((await c.req('DELETE', `/api/contacts/${ok.body.id}`)).status).toBe(204);
    expect((await c.req('DELETE', `/api/contacts/${ok.body.id}`)).status).toBe(404);
  });
});
