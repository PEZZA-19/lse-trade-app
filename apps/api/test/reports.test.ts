import { describe, expect, it } from 'vitest';
import { client, clientFor, seedCustomer } from './api-helpers';
import { addMember, adminSql } from './helpers';

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const todayIso = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Guernsey' }).format(new Date());

describe('reports', () => {
  it('money in and owed, profit per job against actual time and materials, time by person', async () => {
    const c = await client();
    await c.req('PATCH', '/api/settings', {
      bankAccountName: 'Test Electrical',
      bankSortCode: '400000',
      bankAccountNumber: '12345678',
    });
    const cust = await seedCustomer(c);
    const q = (
      await c.req('POST', '/api/quotes', {
        customerId: cust.id,
        title: 'Garage sockets',
        lines: [
          { kind: 'labour', description: 'Fit sockets', qtyMilli: 2000 },
          { kind: 'material', description: 'Sockets', qtyMilli: 2000, unitPricePence: 1500 },
        ],
      })
    ).body;
    await c.req('POST', `/api/quotes/${q.id}/send`);
    await c.req('POST', `/api/quotes/${q.id}/accept`, { acceptedOptions: [] });
    const job = (await c.req('POST', `/api/quotes/${q.id}/convert`)).body;
    // Quoted: 2h at £45 + 2 × £15 = £120 net.
    // Actual: 2h 30m on the timer (£112.50 at £45/h) and £20 of sockets bought for the job.
    await c.req('POST', `/api/jobs/${job.id}/timer/start`, { at: ago(160) });
    await c.req('POST', `/api/jobs/${job.id}/timer/stop`, { at: ago(10) });
    await adminSql`
      INSERT INTO job_lines (tenant_id, job_id, position, kind, description, qty_milli,
                             unit_cost_pence, unit_sell_pence, total_pence, source)
      VALUES (${c.tenantId}, ${job.id}, 50, 'material', 'Sockets (bought)', 2000, 1000, 1200, 2400, 'manual')`;

    const inv = (
      await c.req('POST', `/api/jobs/${job.id}/invoices`, { source: 'quote', mode: 'whole' })
    ).body;
    expect((await c.req('POST', `/api/invoices/${inv.id}/approve`)).status).toBe(200);
    expect((await c.req('POST', `/api/invoices/${inv.id}/mark-sent`)).status).toBe(200);
    await c.req('POST', `/api/invoices/${inv.id}/payments`, {
      amountPence: 5000,
      paidOn: todayIso(),
      method: 'bank_transfer',
    });

    const t = todayIso();
    const r = await c.req('GET', `/api/reports?from=${t.slice(0, 8)}01&to=${t}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.labourRatePence).toBe(4500);
    expect(r.body.money).toMatchObject({
      inPence: 5000,
      paymentCount: 1,
      invoicedPence: inv.totalPence,
      owedPence: inv.totalPence - 5000,
      owedCount: 1,
      overduePence: 0,
    });
    const row = r.body.jobs.find((j: { jobId: string }) => j.jobId === job.id);
    expect(row).toMatchObject({
      quotedPence: 12000,
      lineValuePence: 14400,
      minutes: 150,
      labourPence: 11250,
      materialsCostPence: 2000,
      invoicedPence: inv.subtotalPence,
      profitPence: 12000 - 11250 - 2000,
    });
    expect(r.body.time.totalMinutes).toBe(150);
    expect(r.body.time.byPerson).toHaveLength(1);
    expect(r.body.time.byJob[0]).toMatchObject({ id: job.id, minutes: 150 });

    // A period with nothing in it.
    const empty = await c.req('GET', '/api/reports?from=2001-01-01&to=2001-01-31');
    expect(empty.body.money.inPence).toBe(0);
    expect(empty.body.money.owedPence).toBe(inv.totalPence - 5000); // owed is "right now"
    expect(empty.body.time.totalMinutes).toBe(0);

    expect((await c.req('GET', '/api/reports?from=2026-02-01&to=2026-01-01')).status).toBe(422);
    const staff = await clientFor(await addMember(c.tenantId, 'staff'), c);
    expect((await staff.req('GET', `/api/reports?from=${t}&to=${t}`)).status).toBe(403);
  });
});
