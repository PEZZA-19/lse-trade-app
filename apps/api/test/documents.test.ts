import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { client, seedCustomer, type Client } from './api-helpers';

async function quoteAndJob(c: Client) {
  await c.req('PATCH', '/api/settings', {
    address: 'Unit 1, Demo Lane\nSark (fictional)',
    bankAccountName: 'Test Electrical',
    bankSortCode: '400000',
    bankAccountNumber: '12345678',
  });
  const cust = await seedCustomer(c, { billingAddress: 'La Seigneurie, Sark' });
  const q = (
    await c.req('POST', '/api/quotes', {
      customerId: cust.id,
      siteId: cust.sites[0].id,
      title: 'Barn rewire',
      lines: [
        { kind: 'labour', description: 'Install and test', qtyMilli: 8000 },
        {
          kind: 'material',
          description: 'Twin & earth 2.5mm (m)',
          qtyMilli: 50000,
          unitCostPence: 95,
        },
        { kind: 'carriage', description: 'Carriage', unitPricePence: 0 },
        {
          kind: 'material',
          description: 'Outside light',
          unitPricePence: 4000,
          optionLabel: 'Outside',
        },
      ],
    })
  ).body;
  return { cust, q };
}

async function pdf(c: Client, path: string) {
  const res = await c.session.request('GET', path);
  return { res, bytes: new Uint8Array(await res.arrayBuffer()) };
}

describe('documents', () => {
  it('lays out a quote with the business address from settings and options apart', async () => {
    const c = await client();
    const { q } = await quoteAndJob(c);
    const r = await c.req('GET', `/api/quotes/${q.id}/document`);
    expect(r.status).toBe(200);
    const d = r.body;
    expect(d.kind).toBe('quote');
    expect(d.number).toBe(q.number);
    expect(d.business.addressLines).toEqual(['Unit 1', 'Demo Lane', 'Sark (fictional)']);
    expect(d.billTo).toEqual({
      name: 'Seigneurie Farm',
      lines: ['La Seigneurie', 'Sark', 'farm@example.com'],
    });
    expect(d.siteLines).toEqual(['La Seigneurie', 'Sark']);
    expect(d.sections.map((s: { title: string }) => s.title)).toEqual([
      'Labour',
      'Materials',
      'Optional extra: Outside',
    ]);
    // Carriage is zero, so it isn't printed.
    expect(d.totals.map((t: { label: string }) => t.label)).toEqual([
      'Subtotal',
      'Total (without extras)',
    ]);
    expect(d.totals.at(-1).value).toBe('£422.00'); // £360 labour + 50 m × £1.24
  });

  it('serves PDFs without changing anything', async () => {
    const c = await client();
    const { q } = await quoteAndJob(c);
    const { res, bytes } = await pdf(c, `/api/quotes/${q.id}/pdf`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toContain(
      encodeURIComponent(`Quote ${q.number}.pdf`),
    );
    expect(res.headers.get('cache-control')).toContain('no-store');
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getTitle()).toBe(`Quote ${q.number}`);
    const after = await c.req('GET', `/api/quotes/${q.id}`);
    expect(after.body.status).toBe('draft');
    expect(after.body.version).toBe(q.version);
  });

  it('marks a draft invoice as a draft, then prints its number once approved', async () => {
    const c = await client();
    const { q } = await quoteAndJob(c);
    await c.req('POST', `/api/quotes/${q.id}/send`);
    await c.req('POST', `/api/quotes/${q.id}/accept`, { acceptedOptions: [] });
    const job = (await c.req('POST', `/api/quotes/${q.id}/convert`)).body;
    const inv = (
      await c.req('POST', `/api/jobs/${job.id}/invoices`, { source: 'quote', mode: 'whole' })
    ).body;
    const draft = (await c.req('GET', `/api/invoices/${inv.id}/document`)).body;
    expect(draft.number).toBe('Draft');
    expect(draft.draftLabel).toMatch(/Draft/);
    expect(draft.payment.reference).toBe('INV Draft');
    const approved = await c.req('POST', `/api/invoices/${inv.id}/approve`, undefined, {
      'If-Match': String(inv.version),
    });
    expect(approved.status).toBe(200);
    const d = (await c.req('GET', `/api/invoices/${inv.id}/document`)).body;
    expect(d.number).toBe(job.number);
    expect(d.draftLabel).toBeNull();
    expect(d.payment).toMatchObject({ sortCode: '40-00-00', reference: `INV ${job.number}` });
    expect(d.meta.map((m: { label: string }) => m.label)).toEqual([
      'Invoice date',
      'Due date',
      'Job',
      'Quote',
    ]);
    expect(d.terms).toMatch(/5% per month/);
    const { res, bytes } = await pdf(c, `/api/invoices/${inv.id}/pdf`);
    expect(res.status).toBe(200);
    expect((await PDFDocument.load(bytes)).getTitle()).toBe(`Invoice ${job.number}`);
  });

  it("can't read another business's documents", async () => {
    const a = await client();
    const b = await client();
    const { q } = await quoteAndJob(a);
    expect((await b.req('GET', `/api/quotes/${q.id}/document`)).status).toBe(404);
    expect((await pdf(b, `/api/quotes/${q.id}/pdf`)).res.status).toBe(404);
  });
});
