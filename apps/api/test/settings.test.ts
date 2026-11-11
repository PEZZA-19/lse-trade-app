import { describe, expect, it } from 'vitest';
import { client, seedCustomer } from './api-helpers';
import { adminSql } from './helpers';

async function draftQuote(c: Awaited<ReturnType<typeof client>>) {
  const cust = await seedCustomer(c);
  const q = await c.req('POST', '/api/quotes', {
    customerId: cust.id,
    siteId: cust.sites[0].id,
    title: 'Rewire',
    lines: [{ kind: 'labour', description: 'Labour', qtyMilli: 2000 }],
  });
  expect(q.status).toBe(201);
  return q.body;
}

describe('business settings', () => {
  it('returns defaults suitable for Sark: 0% tax, 14-day terms, Q- numbering', async () => {
    const c = await client();
    const s = await c.req('GET', '/api/settings');
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({
      taxRateBp: 0,
      paymentTermsDays: 14,
      labourRatePence: 4500,
      currency: 'GBP',
    });
    expect(s.body.sequences.map((x: { kind: string }) => x.kind)).toEqual([
      'quote',
      'job',
      'invoice',
      'credit_note',
    ]);
    expect(s.body.sequences[0]).toMatchObject({
      prefix: 'Q-',
      padding: 4,
      nextValue: 1,
      lastUsed: null,
    });
    expect(s.body.sequences[1]).toMatchObject({ prefix: '', nextValue: 122 });
  });

  it('owner can update details, rates, terms and tax, and it is audited', async () => {
    const c = await client();
    const r = await c.req('PATCH', '/api/settings', {
      name: 'Demo Electric',
      phone: '',
      labourRatePence: 5000,
      defaultMarkupBp: 12500,
      taxRateBp: 0,
      paymentTermsDays: 30,
      quoteTerms: 'Valid for 30 days.',
      bankSortCode: '12 34 56',
      bankAccountNumber: '12345678',
      bankAccountName: 'Demo Electric',
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      name: 'Demo Electric',
      phone: null,
      labourRatePence: 5000,
      bankSortCode: '12-34-56',
    });
    const [a] =
      await adminSql`SELECT data FROM audit_log WHERE tenant_id = ${c.tenantId} AND action = 'settings.update'`;
    expect(Object.keys(a!.data.changed)).toEqual(
      expect.arrayContaining(['name', 'labourRatePence', 'paymentTermsDays', 'bankSortCode']),
    );
  });

  it('validates input with field messages', async () => {
    const c = await client();
    const r = await c.req('PATCH', '/api/settings', { name: '', bankAccountNumber: '123' });
    expect(r.status).toBe(422);
    expect(r.body.error.details.fields).toMatchObject({ name: 'Business name is required' });
  });

  it('new labour lines use the updated rate', async () => {
    const c = await client();
    await c.req('PATCH', '/api/settings', { labourRatePence: 6000 });
    const q = await draftQuote(c);
    expect(q.current.lines[0].unitSellPence).toBe(6000);
  });

  it('numbering: change prefix/padding and start point, but never reuse a number', async () => {
    const c = await client();
    await draftQuote(c); // uses Q-0001
    const low = await c.req('PATCH', '/api/settings', {
      sequences: [{ kind: 'quote', prefix: 'Q-', padding: 4, nextValue: 1 }],
    });
    expect(low.status).toBe(422);
    expect(low.body.error.message).toMatch(/above 1/);

    const ok = await c.req('PATCH', '/api/settings', {
      sequences: [{ kind: 'quote', prefix: 'EST-', padding: 3, nextValue: 50 }],
    });
    expect(ok.status).toBe(200);
    expect(ok.body.sequences[0]).toMatchObject({
      prefix: 'EST-',
      padding: 3,
      nextValue: 50,
      lastUsed: 1,
    });
    const q = await draftQuote(c);
    expect(q.number).toBe('EST-050');
  });
});

describe('pre-send completeness check', () => {
  it('reports what is missing in plain English', async () => {
    const c = await client({ incomplete: true });
    const r = await c.req('GET', '/api/settings/readiness');
    expect(r.body.quote.ready).toBe(false);
    expect(r.body.quote.missing.map((m: { label: string }) => m.label)).toEqual([
      'Business address',
      'Phone or email',
    ]);
    expect(r.body.invoice.ready).toBe(false);
  });

  it('blocks marking a quote as sent until details are complete, then allows it', async () => {
    const c = await client({ incomplete: true });
    const q = await draftQuote(c);
    const blocked = await c.req('POST', `/api/quotes/${q.id}/send`);
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('business_details_missing');
    expect(blocked.body.error.message).toBe(
      'Add your business address, phone or email in Settings before sending.',
    );
    // Nothing changed: the quote is still a draft (never show "sent" unless it really was).
    expect((await c.req('GET', `/api/quotes/${q.id}`)).body.status).toBe('draft');

    await c.req('PATCH', '/api/settings', {
      address: '1 Demo Lane, Sark',
      email: 'demo@example.test',
    });
    const sent = await c.req('POST', `/api/quotes/${q.id}/send`);
    expect(sent.status).toBe(200);
    expect(sent.body.status).toBe('sent');
  });

  it('a £0 labour rate blocks sending', async () => {
    const c = await client();
    await c.req('PATCH', '/api/settings', { labourRatePence: 0 });
    const r = await c.req('GET', '/api/settings/readiness');
    expect(r.body.quote.missing.map((m: { field: string }) => m.field)).toEqual([
      'labourRatePence',
    ]);
  });
});
