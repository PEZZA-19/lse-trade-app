import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { AiGateway } from '../src/ai/gateway';
import { FakeProvider } from '../src/ai/fake';
import { DEFAULT_ORIGIN, signIn } from '../src/dev/session-client';
import { RecordingSender } from '../src/lib/messages';
import { client, clientFor, mailer, seedCustomer, type Client } from './api-helpers';
import { addMember, adminSql, appSql } from './helpers';

async function enquiry(c: Client, over: Record<string, unknown> = {}) {
  const r = await c.req('POST', '/api/enquiries', {
    name: 'Robin Example',
    email: 'robin@example.test',
    message: 'The outside light by the gate has stopped working.',
    source: 'email',
    ...over,
  });
  expect(r.status).toBe(201);
  return r.body;
}

const expire = (id: string) =>
  adminSql`UPDATE proposals SET hold_until = now() - interval '1 second' WHERE id = ${id}`;

describe('reply drafts', () => {
  it('draft → edit → approve (held 2 min) → stop → approve → not sent without an email account; all logged', async () => {
    const c = await client();
    const e = await enquiry(c);
    const d = await c.req('POST', `/api/enquiries/${e.id}/draft-reply`);
    expect(d.status).toBe(201);
    expect(d.body).toMatchObject({
      kind: 'reply_email',
      status: 'pending',
      drafter: 'fake',
      agent: 'reply-helper',
    });
    expect(d.body.summary).toMatch(/Email Robin Example <robin@example.test>/);
    expect(d.body.payload.body).toMatch(/^Hi Robin,/);
    expect(d.body.payload.body).not.toMatch(/Thanks,\n/); // no typed sign-off
    // One open draft per enquiry.
    expect((await c.req('POST', `/api/enquiries/${e.id}/draft-reply`)).status).toBe(409);

    const staff = await clientFor(await addMember(c.tenantId, 'staff'), c);
    expect((await staff.req('POST', `/api/proposals/${d.body.id}/approve`)).status).toBe(403);
    expect((await staff.req('POST', `/api/proposals/${d.body.id}/discard`)).status).toBe(403);

    const edited = await c.req('PATCH', `/api/proposals/${d.body.id}`, {
      subject: 'Your gate light',
      body: 'Hi Robin,\n\nI can come Tuesday.',
    });
    expect(edited.body.payload).toMatchObject({
      subject: 'Your gate light',
      to: 'robin@example.test',
    });
    const held = await c.req('POST', `/api/proposals/${d.body.id}/approve`);
    expect(held.body.status).toBe('held');
    const wait = new Date(held.body.holdUntil).getTime() - Date.now();
    expect(wait).toBeGreaterThan(110_000);
    expect(wait).toBeLessThanOrEqual(120_000);
    expect((await c.req('GET', '/api/proposals/counts')).body).toEqual({ pending: 0, held: 1 });
    const stopped = await c.req('POST', `/api/proposals/${d.body.id}/stop`);
    expect(stopped.body).toMatchObject({ status: 'pending', holdUntil: null });
    await c.req('POST', `/api/proposals/${d.body.id}/approve`);
    await expire(d.body.id);
    expect((await c.req('POST', `/api/proposals/${d.body.id}/stop`)).status).toBe(409);
    const after = await c.req('GET', `/api/proposals/${d.body.id}`);
    expect(after.body.status).toBe('send_blocked');
    expect(after.body.result).toEqual({
      sent: false,
      reason: 'No email account is connected, so nothing was sent.',
    });
    expect(after.body.events.map((x: { event: string }) => x.event)).toEqual([
      'created',
      'edited',
      'approved',
      'stopped',
      'approved',
      'send_blocked',
    ]);
    const [call] =
      await adminSql`SELECT purpose, status FROM ai_calls WHERE tenant_id = ${c.tenantId}`;
    expect(call).toMatchObject({ purpose: 'reply_email', status: 'ok' });
    expect((await c.req('GET', '/api/proposals?status=done')).body).toHaveLength(1);
  });

  it('a connected sender sends after the hold; a discarded draft never goes', async () => {
    const sender = new RecordingSender();
    const app = createApp({
      getSql: () => appSql,
      auth: { mailer, appOrigin: DEFAULT_ORIGIN },
      ai: new AiGateway(new FakeProvider()),
      sender,
    });
    const c = await client();
    const s = await signIn(app, mailer, c.email);
    const call = async (m: string, p: string, b?: unknown) =>
      (await s.request(m, p, b)).json() as Promise<any>;
    const a = await enquiry(c);
    const b = await enquiry(c, { name: 'Sam Other', email: 'sam@example.test' });
    const pa = await call('POST', `/api/enquiries/${a.id}/draft-reply`);
    const pb = await call('POST', `/api/enquiries/${b.id}/draft-reply`);
    await call('POST', `/api/proposals/${pa.id}/approve`);
    expect(sender.sent).toHaveLength(0); // nothing goes during the hold
    await call('POST', `/api/proposals/${pb.id}/discard`);
    await expire(pa.id);
    expect((await call('GET', `/api/proposals/${pa.id}`)).status).toBe('sent');
    expect(sender.sent).toEqual([expect.objectContaining({ to: 'robin@example.test' })]);
    expect((await call('GET', `/api/proposals/${pb.id}`)).status).toBe('discarded');
  });
});

describe('quote drafts from enquiries', () => {
  it('uses price-list items, and approving creates the draft quote and converts the enquiry', async () => {
    const c = await client();
    const item = (
      await c.req('POST', '/api/price-list', {
        description: 'Outside wall light',
        unitCostPence: 2000,
      })
    ).body;
    await c.req('POST', '/api/price-list', { description: 'Fused spur', unitCostPence: 500 });
    const e = await enquiry(c);
    const d = await c.req('POST', `/api/enquiries/${e.id}/draft-quote`);
    expect(d.status).toBe(201);
    expect(d.body.payload.lines).toEqual([
      {
        itemId: item.id,
        kind: 'material',
        description: 'Outside wall light',
        qtyMilli: 1000,
        unitPricePence: null,
      },
      {
        itemId: null,
        kind: 'labour',
        description: 'Labour (estimate: check on site)',
        qtyMilli: 2000,
        unitPricePence: null,
      },
    ]);
    const done = await c.req('POST', `/api/proposals/${d.body.id}/approve`);
    expect(done.body.status).toBe('applied');
    const q = await c.req('GET', `/api/quotes/${done.body.result.quoteId}`);
    expect(q.body.status).toBe('draft');
    expect(q.body.current.lines).toHaveLength(2);
    expect((await c.req('GET', `/api/enquiries/${e.id}`)).body).toMatchObject({
      status: 'converted',
      convertedTo: 'quote',
    });
  });
});

describe('overdue reminders', () => {
  it('drafts one per overdue invoice with an email, never twice', async () => {
    const c = await client();
    await c.req('PATCH', '/api/settings', {
      bankAccountName: 'Test',
      bankSortCode: '400000',
      bankAccountNumber: '12345678',
      paymentTermsDays: 0,
    });
    const cust = await seedCustomer(c);
    const job = (await c.req('POST', '/api/jobs', { customerId: cust.id, title: 'Repair' })).body;
    const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
    await c.req('POST', `/api/jobs/${job.id}/timer/start`, { at: ago(120) });
    await c.req('POST', `/api/jobs/${job.id}/timer/stop`, { at: ago(60) });
    const inv = await c.req('POST', `/api/jobs/${job.id}/invoices`, { source: 'job' });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    await c.req('POST', `/api/invoices/${inv.body.id}/approve`);
    await c.req('POST', `/api/invoices/${inv.body.id}/mark-sent`);
    expect((await c.req('POST', '/api/proposals/overdue-reminders')).body.created).toHaveLength(0);
    await adminSql`UPDATE invoices SET due_date = due_date - 3 WHERE id = ${inv.body.id}`;
    const r = await c.req('POST', '/api/proposals/overdue-reminders');
    expect(r.body.created).toHaveLength(1);
    expect(r.body.created[0]).toMatchObject({ kind: 'overdue_reminder', drafter: 'fake' });
    expect(r.body.created[0].payload.subject).toMatch(/friendly reminder/);
    expect(r.body.created[0].summary).toMatch(/overdue 3 days/);
    expect((await c.req('POST', '/api/proposals/overdue-reminders')).body.created).toHaveLength(0);
  });
});

describe('price updates from bills', () => {
  it('suggests from the bill preview; approving applies the bill', async () => {
    const c = await client();
    const item = (
      await c.req('POST', '/api/price-list', {
        code: 'DL1',
        description: 'Downlight',
        supplier: 'CEF',
        unitCostPence: 400,
      })
    ).body;
    const bill = (
      await c.req('POST', '/api/supplier-bills', {
        supplier: 'CEF',
        reference: 'GUR/1',
        billDate: '2026-11-07',
        lines: [{ code: 'DL1', description: 'Downlight', qtyMilli: 2000, unitCostPence: 450 }],
      })
    ).body;
    const d = await c.req('POST', `/api/supplier-bills/${bill.id}/suggest-prices`);
    expect(d.status, JSON.stringify(d.body)).toBe(201);
    expect(d.body).toMatchObject({ kind: 'price_update', agent: 'price-watcher', drafter: null });
    expect(d.body.payload.changes).toEqual([
      { description: 'Downlight', oldCostPence: 400, newCostPence: 450 },
    ]);
    const ok = await c.req('POST', `/api/proposals/${d.body.id}/approve`);
    expect(ok.body).toMatchObject({ status: 'applied', result: { priceChanges: 1 } });
    const after = (await c.req('GET', '/api/price-list?q=Downlight')).body;
    expect((after.items ?? after)[0].unitCostPence).toBe(450);
    expect(item.id).toBeTruthy();
  });
});
