import { describe, expect, it } from 'vitest';
import { client, seedCustomer, type Client } from './api-helpers';

const lines = [
  { kind: 'labour', description: 'Install and test', qtyMilli: 8000 }, // defaults to £45/h -> £360
  { kind: 'material', description: 'Twin & earth 2.5mm (m)', qtyMilli: 50000, unitCostPence: 95 }, // 124p x 50 = £62
  { kind: 'carriage', description: 'Carriage', unitPricePence: 2500 },
  {
    kind: 'material',
    description: 'PIR floodlight',
    unitCostPence: 4000,
    optionLabel: 'Outside light',
  }, // £52
];

async function newQuote(c: Client, extra: Record<string, unknown> = {}) {
  const cust = await seedCustomer(c);
  const r = await c.req('POST', '/api/quotes', {
    customerId: cust.id,
    siteId: cust.sites[0].id,
    title: 'Barn rewire',
    notes: 'Please confirm any options you would like.',
    lines,
    ...extra,
  });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return { cust, quote: r.body };
}

async function acceptedQuote(c: Client, options: string[] = ['Outside light']) {
  const { cust, quote } = await newQuote(c);
  expect((await c.req('POST', `/api/quotes/${quote.id}/send`)).status).toBe(200);
  const acc = await c.req('POST', `/api/quotes/${quote.id}/accept`, { acceptedOptions: options });
  expect(acc.status).toBe(200);
  return { cust, quote: acc.body };
}

describe('quotes', () => {
  it('numbers quotes Q-0001, Q-0002 and prices lines server-side', async () => {
    const c = await client();
    const { quote } = await newQuote(c);
    expect(quote.number).toBe('Q-0001');
    expect(quote.status).toBe('draft');
    expect(quote.current.lines.map((l: { totalPence: number }) => l.totalPence)).toEqual([
      36000, 6200, 2500, 5200,
    ]);
    expect(quote.current.lines[0].unitPricePence).toBe(4500); // labour default filled in
    expect(quote.current.totals.corePence).toBe(44700);
    expect(quote.current.totals.options).toEqual({ 'Outside light': 5200 });
    expect(quote.totalPence).toBe(44700);
    expect((await newQuote(c)).quote.number).toBe('Q-0002');
  });

  it('uses the customer markup when set', async () => {
    const c = await client();
    const cust = await seedCustomer(c, { markupBp: 11000 });
    const r = await c.req('POST', '/api/quotes', {
      customerId: cust.id,
      title: 'Family job',
      lines: [{ kind: 'material', description: 'Socket', unitCostPence: 1000 }],
    });
    expect(r.body.current.lines[0].unitSellPence).toBe(1100);
  });

  it('rejects a site from another customer and unknown customers', async () => {
    const c = await client();
    const a = await seedCustomer(c);
    const b = await seedCustomer(c, { name: 'B' });
    const r = await c.req('POST', '/api/quotes', {
      customerId: b.id,
      siteId: a.sites[0].id,
      title: 'x',
    });
    expect(r.status).toBe(422);
    const r2 = await c.req('POST', '/api/quotes', {
      customerId: '00000000-0000-4000-8000-000000000000',
      title: 'x',
    });
    expect(r2.status).toBe(422);
  });

  it('edits a draft, then locks it once sent', async () => {
    const c = await client();
    const { quote } = await newQuote(c);
    const e = await c.req('PATCH', `/api/quotes/${quote.id}`, {
      title: 'Barn rewire (full)',
      lines: lines.slice(0, 1),
    });
    expect(e.status).toBe(200);
    expect(e.body.title).toBe('Barn rewire (full)');
    expect(e.body.totalPence).toBe(36000);
    await c.req('POST', `/api/quotes/${quote.id}/send`);
    const locked = await c.req('PATCH', `/api/quotes/${quote.id}`, { title: 'nope' });
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe('quote_locked');
  });

  it('will not record an empty or £0 quote as sent', async () => {
    const c = await client();
    const { quote } = await newQuote(c, { lines: [] });
    expect((await c.req('POST', `/api/quotes/${quote.id}/send`)).status).toBe(422);
    await c.req('PATCH', `/api/quotes/${quote.id}`, {
      lines: [{ kind: 'material', description: 'Free survey' }],
    });
    const r = await c.req('POST', `/api/quotes/${quote.id}/send`);
    expect(r.status).toBe(422);
    expect(r.body.error.message).toMatch(/£0/);
  });

  it('revises a sent quote as rev B with the same number', async () => {
    const c = await client();
    const { quote } = await newQuote(c);
    await c.req('POST', `/api/quotes/${quote.id}/send`);
    const rev = await c.req('POST', `/api/quotes/${quote.id}/revise`);
    expect(rev.status).toBe(201);
    expect(rev.body.number).toBe(quote.number);
    expect(rev.body.displayNumber).toBe(`${quote.number} rev B`);
    expect(rev.body.status).toBe('draft');
    expect(rev.body.current.lines).toHaveLength(lines.length);
    expect(rev.body.revisions).toHaveLength(2);
    expect(rev.body.revisions[0].supersededAt).not.toBeNull();
    // Editing rev B leaves rev A untouched.
    const e = await c.req('PATCH', `/api/quotes/${quote.id}`, { lines: lines.slice(0, 2) });
    expect(e.body.totalPence).toBe(42200);
    // A draft cannot be revised (edit it instead).
    expect((await c.req('POST', `/api/quotes/${quote.id}/revise`)).status).toBe(409);
  });

  it('enforces the status flow', async () => {
    const c = await client();
    const { quote } = await newQuote(c);
    expect((await c.req('POST', `/api/quotes/${quote.id}/accept`)).status).toBe(409); // not sent
    expect((await c.req('POST', `/api/quotes/${quote.id}/convert`)).body.error.code).toBe(
      'not_accepted',
    );
    await c.req('POST', `/api/quotes/${quote.id}/send`);
    expect(
      (await c.req('POST', `/api/quotes/${quote.id}/accept`, { acceptedOptions: ['Nope'] })).status,
    ).toBe(422);
    const d = await c.req('POST', `/api/quotes/${quote.id}/decline`);
    expect(d.body.status).toBe('declined');
  });

  it('lists with filters and search', async () => {
    const c = await client();
    await newQuote(c);
    const { quote } = await newQuote(c, { title: 'Garden lights' });
    await c.req('POST', `/api/quotes/${quote.id}/send`);
    expect((await c.req('GET', '/api/quotes')).body.total).toBe(2);
    expect((await c.req('GET', '/api/quotes?status=sent')).body.items[0].title).toBe(
      'Garden lights',
    );
    expect((await c.req('GET', '/api/quotes?q=garden')).body.total).toBe(1);
    expect((await c.req('GET', '/api/quotes?status=bogus')).status).toBe(422);
  });
});

describe('convert to job', () => {
  it('creates job 122 linked both ways, copying core and accepted option lines', async () => {
    const c = await client({ nextJobNumber: 122 });
    const { cust, quote } = await acceptedQuote(c);
    expect(quote.totalPence).toBe(44700 + 5200);
    const r = await c.req('POST', `/api/quotes/${quote.id}/convert`);
    expect(r.status).toBe(201);
    expect(r.body.number).toBe('122');
    expect(r.body.customerId).toBe(cust.id);
    expect(r.body.siteId).toBe(cust.sites[0].id);
    expect(r.body.sourceQuoteId).toBe(quote.id);
    expect(r.body.sourceQuoteNumber).toBe('Q-0001');
    expect(r.body.sourceQuoteRevision).toBe(1);
    expect(r.body.lines).toHaveLength(4);
    expect(r.body.lines[3].description).toBe('PIR floodlight (Outside light)');
    expect(r.body.quotedTotalPence).toBe(49900);
    const q = await c.req('GET', `/api/quotes/${quote.id}`);
    expect(q.body.status).toBe('converted');
    expect(q.body.convertedJobId).toBe(r.body.id);
    expect(q.body.convertedJobNumber).toBe('122');
  });

  it('leaves out options the customer did not accept', async () => {
    const c = await client();
    const { quote } = await acceptedQuote(c, []);
    const r = await c.req('POST', `/api/quotes/${quote.id}/convert`);
    expect(r.body.lines).toHaveLength(3);
    expect(r.body.quotedTotalPence).toBe(44700);
  });

  it('converts only once: a second attempt is a clear 409', async () => {
    const c = await client();
    const { quote } = await acceptedQuote(c);
    const first = await c.req('POST', `/api/quotes/${quote.id}/convert`);
    const second = await c.req('POST', `/api/quotes/${quote.id}/convert`);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('already_converted');
    expect(second.body.error.details.jobId).toBe(first.body.id);
    expect((await c.req('GET', '/api/jobs')).body.total).toBe(1);
  });

  it('survives a burst of concurrent double taps: exactly one job', async () => {
    const c = await client();
    const { quote } = await acceptedQuote(c);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => c.req('POST', `/api/quotes/${quote.id}/convert`)),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(9);
    expect((await c.req('GET', '/api/jobs')).body.total).toBe(1);
  });

  it('replays the original response for a retried Idempotency-Key, even concurrently', async () => {
    const c = await client();
    const { quote } = await acceptedQuote(c);
    const h = { 'idempotency-key': 'offline-retry-0001' };
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        c.req('POST', `/api/quotes/${quote.id}/convert`, undefined, h),
      ),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(results.filter((r) => r.headers.get('idempotent-replayed') === 'true')).toHaveLength(4);
    // Same key for a different request is refused.
    const other = await acceptedQuote(c);
    expect(
      (await c.req('POST', `/api/quotes/${other.quote.id}/convert`, undefined, h)).status,
    ).toBe(422);
  });

  it('locks a converted quote against edits and revisions', async () => {
    const c = await client();
    const { quote } = await acceptedQuote(c);
    await c.req('POST', `/api/quotes/${quote.id}/convert`);
    expect((await c.req('PATCH', `/api/quotes/${quote.id}`, { title: 'x' })).status).toBe(409);
    expect((await c.req('POST', `/api/quotes/${quote.id}/revise`)).status).toBe(409);
  });
});

describe('jobs', () => {
  it('creates call-out jobs without a quote, continuing the number sequence', async () => {
    const c = await client({ nextJobNumber: 122 });
    const cust = await seedCustomer(c);
    const a = await c.req('POST', '/api/jobs', {
      customerId: cust.id,
      title: 'Call-out: no power',
    });
    expect(a.status).toBe(201);
    expect(a.body.number).toBe('122');
    expect(a.body.stage).toMatchObject({
      systemKey: 'unassigned',
      name: 'Unassigned',
      colour: 'grey',
    });
    expect(a.body.placeOfWork).toBe('sark');
    expect(a.body.sourceQuoteId).toBeNull();
    const { quote } = await acceptedQuote(c);
    const b = await c.req('POST', `/api/quotes/${quote.id}/convert`);
    expect(b.body.number).toBe('123'); // quotes and jobs have separate sequences
  });

  it('changes stage by hand and lists active jobs newest first', async () => {
    const c = await client();
    const cust = await seedCustomer(c);
    const one = (await c.req('POST', '/api/jobs', { customerId: cust.id, title: 'One' })).body;
    await c.req('POST', '/api/jobs', { customerId: cust.id, title: 'Two' });
    const u = await c.req('PATCH', `/api/jobs/${one.id}`, { stageKey: 'complete' });
    expect(u.body.stage.systemKey).toBe('complete');
    const active = await c.req('GET', '/api/jobs?active=true');
    expect(active.body.items.map((j: { title: string }) => j.title)).toEqual(['Two']);
    const all = await c.req('GET', '/api/jobs');
    expect(all.body.items.map((j: { title: string }) => j.title)).toEqual(['Two', 'One']);
    expect((await c.req('PATCH', `/api/jobs/${one.id}`, { stageKey: 'bogus' })).status).toBe(422);
  });

  it('shows jobs and quotes on the customer', async () => {
    const c = await client();
    const { cust, quote } = await acceptedQuote(c);
    await c.req('POST', `/api/quotes/${quote.id}/convert`);
    const r = await c.req('GET', `/api/customers/${cust.id}`);
    expect(r.body.quotes).toHaveLength(1);
    expect(r.body.jobs).toHaveLength(1);
  });
});

describe('a quote never totals less than £0 (Joe, 18 Nov 2026)', () => {
  const work = { kind: 'labour', description: 'Rewire', qtyMilli: 1000, unitPricePence: 20000 };
  const minus = (pence: number, optionLabel?: string) => ({
    kind: 'material',
    description: 'Rent payments',
    qtyMilli: 1000,
    unitPricePence: -pence,
    ...(optionLabel ? { optionLabel } : {}),
  });

  it('minus lines are fine while the total stays at or above £0', async () => {
    const c = await client();
    const cust = await seedCustomer(c);
    const r = await c.req('POST', '/api/quotes', {
      customerId: cust.id,
      title: 'Flat',
      lines: [work, minus(15000)],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.totalPence).toBe(5000);
    expect((await c.req('POST', `/api/quotes/${r.body.id}/send`)).status).toBe(200);
  });

  it('creating, editing or sending below £0 is refused with a clear reason', async () => {
    const c = await client();
    const cust = await seedCustomer(c);
    const bad = await c.req('POST', '/api/quotes', {
      customerId: cust.id,
      title: 'Flat',
      lines: [work, minus(25000)],
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('quote_below_zero');
    expect(bad.body.error.message).toMatch(
      /can’t come to less than £0\. This one comes to -£50\.00/,
    );
    // Nothing was created (no number used up either).
    expect((await c.req('GET', '/api/quotes')).body.items ?? []).toHaveLength(0);

    const ok = (
      await c.req('POST', '/api/quotes', { customerId: cust.id, title: 'Flat', lines: [work] })
    ).body;
    const edit = await c.req('PATCH', `/api/quotes/${ok.id}`, { lines: [work, minus(20001)] });
    expect(edit.status).toBe(422);
    expect((await c.req('GET', `/api/quotes/${ok.id}`)).body.totalPence).toBe(20000);
    // Exactly £0 saves (it just can't be sent, as before).
    expect(
      (await c.req('PATCH', `/api/quotes/${ok.id}`, { lines: [work, minus(20000)] })).status,
    ).toBe(200);
    expect((await c.req('POST', `/api/quotes/${ok.id}/send`)).status).toBe(422);
  });

  it('a minus optional extra that could take it below £0 is refused too', async () => {
    const c = await client();
    const cust = await seedCustomer(c);
    const r = await c.req('POST', '/api/quotes', {
      customerId: cust.id,
      title: 'Flat',
      lines: [work, minus(30000, 'Rent offset')],
    });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toMatch(
      /With the option “Rent offset” it would come to -£100\.00/,
    );
  });
});
