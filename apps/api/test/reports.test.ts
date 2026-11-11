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

describe('cost rates and true profit', () => {
  it('team costs are owner only; profit uses each person’s base + on-cost rate, labour rate when unset', async () => {
    const c = await client();
    const staffEmail = await addMember(c.tenantId, 'staff');
    const staff = await clientFor(staffEmail, c);
    expect((await staff.req('GET', '/api/team')).status).toBe(403);
    expect(
      (await staff.req('PUT', `/api/team/${c.userId}/cost`, { baseCostPence: 1, onCostPence: 0 }))
        .status,
    ).toBe(403);

    const set = await c.req('PUT', `/api/team/${c.userId}/cost`, {
      baseCostPence: 2000,
      onCostPence: 455,
    });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body).toMatchObject({
      chargeOutPence: 4500,
      baseCostPence: 2000,
      onCostPence: 455,
      costRatePence: 2455,
      isPlaceholder: false,
    });
    const team = (await c.req('GET', '/api/team')).body;
    expect(team).toHaveLength(2);
    expect(team[1]).toMatchObject({ role: 'staff', costRatePence: null });
    expect(
      (await c.req('PUT', `/api/team/${c.userId}/cost`, { baseCostPence: -1, onCostPence: 0 }))
        .status,
    ).toBe(422);

    // A quoted job: 2h labour at £45 + 2 × £15 sockets = £120 revenue.
    const cust = await seedCustomer(c);
    const q = (
      await c.req('POST', '/api/quotes', {
        customerId: cust.id,
        title: 'Shed supply',
        lines: [
          { kind: 'labour', description: 'Fit', qtyMilli: 2000 },
          { kind: 'material', description: 'Sockets', qtyMilli: 2000, unitPricePence: 1500 },
        ],
      })
    ).body;
    await c.req('POST', `/api/quotes/${q.id}/send`);
    await c.req('POST', `/api/quotes/${q.id}/accept`, { acceptedOptions: [] });
    const job = (await c.req('POST', `/api/quotes/${q.id}/convert`)).body;
    const staffId = team[1].userId as string;
    // Joe 90 min (cost £24.55/h), Sam 30 min (no cost rate → £45/h).
    await adminSql`
      INSERT INTO timesheets (tenant_id, job_id, user_id, started_at, ended_at, source)
      VALUES (${c.tenantId}, ${job.id}, ${c.userId}, now() - interval '200 minutes', now() - interval '110 minutes', 'manual'),
             (${c.tenantId}, ${job.id}, ${staffId}, now() - interval '100 minutes', now() - interval '70 minutes', 'manual')`;

    const costing = await c.req('GET', `/api/jobs/${job.id}/costing`);
    expect(costing.status, JSON.stringify(costing.body)).toBe(200);
    expect(costing.body.profit).toMatchObject({
      revenuePence: 12000,
      minutes: 120,
      chargeOutPence: 9000,
      labourPence: 3683 + 2250, // 90 × 24.55/60 = 36.825 → 36.83; 30 × 45/60 = 22.50
      materialsCostPence: 0,
      missingCostRates: 1,
      invoicedPence: 0,
      // Nothing invoiced yet: so far it has only cost money (not "£120 − costs").
      profitPence: -5933,
      // Expected: quoted 2 h at this job's own cost/h (£59.33 for 2 h) and the £30 of quoted
      // sockets at cost (no cost on the line, so £30 ÷ the 130% markup = £23.08).
      expectedCostPence: 5933 + 2308,
      expectedProfitPence: 12000 - 5933 - 2308,
    });
    expect(costing.body.quoted).toMatchObject({
      labourMinutes: 120,
      labourPence: 9000,
      materialsPence: 3000,
    });
    expect(costing.body.allRatesSet).toBe(false);
    expect(
      costing.body.labour.map((l: { ratePence: number; rateIsDefault: boolean }) => [
        l.ratePence,
        l.rateIsDefault,
      ]),
    ).toEqual([
      [2455, false],
      [4500, true],
    ]);
    expect((await staff.req('GET', `/api/jobs/${job.id}/costing`)).status).toBe(403);

    const t = todayIso();
    const r = (await c.req('GET', `/api/reports?from=${t}&to=${t}`)).body;
    expect(r.costRates).toEqual({ set: 1, people: 2 });
    expect(r.jobs.find((j: { jobId: string }) => j.jobId === job.id)).toMatchObject({
      profitPence: -5933,
      expectedProfitPence: 3759,
    });

    // Invoiced in full: profit so far = £120 − £59.33. A £20 credit note comes off the revenue.
    await c.req('PATCH', '/api/settings', {
      bankAccountName: 'Test Electrical',
      bankSortCode: '400000',
      bankAccountNumber: '12345678',
    });
    const inv = (
      await c.req('POST', `/api/jobs/${job.id}/invoices`, { source: 'quote', mode: 'whole' })
    ).body;
    expect((await c.req('POST', `/api/invoices/${inv.id}/approve`)).status).toBe(200);
    expect((await c.req('POST', `/api/invoices/${inv.id}/mark-sent`)).status).toBe(200);
    let p = (await c.req('GET', `/api/jobs/${job.id}/costing`)).body.profit;
    expect(p).toMatchObject({ invoicedPence: 12000, profitPence: 6067 });
    const cn = await c.req('POST', `/api/invoices/${inv.id}/credit-notes`, {
      amountPence: 2000,
      reason: 'Goodwill',
    });
    expect(cn.status, JSON.stringify(cn.body)).toBe(201);
    expect((await c.req('POST', `/api/credit-notes/${cn.body.id}/approve`)).status).toBe(200);
    p = (await c.req('GET', `/api/jobs/${job.id}/costing`)).body.profit;
    expect(p).toMatchObject({ invoicedPence: 10000, profitPence: 4067 });

    // Clearing the rate falls back to the labour rate.
    expect((await c.req('PUT', `/api/team/${c.userId}/cost`, null)).body.costRatePence).toBeNull();
    const after = (await c.req('GET', `/api/jobs/${job.id}/costing`)).body;
    expect(after.profit.labourPence).toBe(9000);
  });
});

describe('reporting year setting', () => {
  it('defaults to calendar years from 1 Jan 2027, can be changed by the owner, and periods spanning the switch add up', async () => {
    const c = await client();
    const s = (await c.req('GET', '/api/settings')).body;
    expect(s).toMatchObject({ yearStart: '01-01', yearEffectiveFrom: '2027-01-01' });
    expect((await c.req('PATCH', '/api/settings', { yearStart: '02-30' })).status).toBe(422);
    const u = await c.req('PATCH', '/api/settings', {
      yearStart: '04-06',
      yearEffectiveFrom: '2028-01-01',
    });
    expect(u.body).toMatchObject({ yearStart: '04-06', yearEffectiveFrom: '2028-01-01' });

    // Time either side of midnight on 31 Dec 2026 (Guernsey time = UTC in winter).
    const cust = await seedCustomer(c);
    const job = (
      await c.req('POST', '/api/jobs', { customerId: cust.id, title: 'New Year call-out' })
    ).body;
    await adminSql`
      INSERT INTO timesheets (tenant_id, job_id, user_id, started_at, ended_at, source)
      VALUES (${c.tenantId}, ${job.id}, ${c.userId}, '2026-12-31T22:00:00Z', '2026-12-31T23:30:00Z', 'manual'),
             (${c.tenantId}, ${job.id}, ${c.userId}, '2027-01-01T00:30:00Z', '2027-01-01T01:15:00Z', 'manual')`;
    const mins = async (from: string, to: string) =>
      (await c.req('GET', `/api/reports?from=${from}&to=${to}`)).body.time.totalMinutes;
    expect(await mins('2026-12-31', '2026-12-31')).toBe(90);
    expect(await mins('2027-01-01', '2027-01-01')).toBe(45);
    expect(await mins('2026-12-01', '2027-01-31')).toBe(135);
  });
});
