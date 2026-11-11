import { reportsCsv } from '@lse/shared';
import { describe, expect, it } from 'vitest';
import { client, seedCustomer } from './api-helpers';
import { adminSql } from './helpers';

describe('cost rates: tax and on-costs as % or £', () => {
  it('saves a percentage as its £/h, switches modes both ways, and keeps them consistent', async () => {
    const c = await client();
    const put = (body: object) => c.req('PUT', `/api/team/${c.userId}/cost`, body);

    const pct = await put({ baseCostPence: 2000, onCostMode: 'percent', onCostBp: 2250 });
    expect(pct.status, JSON.stringify(pct.body)).toBe(200);
    expect(pct.body).toMatchObject({
      onCostMode: 'percent',
      onCostBp: 2250,
      onCostPence: 450,
      costRatePence: 2450, // £20 + 22.5% = £24.50
    });

    const fixed = await put({ baseCostPence: 2000, onCostMode: 'fixed', onCostPence: 300 });
    expect(fixed.body).toMatchObject({ onCostMode: 'fixed', onCostBp: null, costRatePence: 2300 });

    const back = await put({ baseCostPence: 1850, onCostMode: 'percent', onCostBp: 1380 });
    expect(back.body).toMatchObject({ onCostPence: 255, costRatePence: 2105 });

    // The database refuses a percentage row whose £/h doesn't match.
    await expect(
      adminSql`UPDATE member_costs SET on_cost_pence = 999 WHERE user_id = ${c.userId} AND tenant_id = ${c.tenantId}`,
    ).rejects.toThrow(/member_costs_on_cost_consistent/);
    expect((await put({ baseCostPence: 2000, onCostMode: 'percent' })).status).toBe(422);
  });

  it('rows from before the change read as fixed amounts (the migration default)', async () => {
    const c = await client();
    await adminSql`
      INSERT INTO member_costs (tenant_id, user_id, base_cost_pence, on_cost_pence)
      VALUES (${c.tenantId}, ${c.userId}, 2000, 455)
      ON CONFLICT (tenant_id, user_id) DO UPDATE SET base_cost_pence = 2000, on_cost_pence = 455,
        on_cost_mode = DEFAULT, on_cost_bp = NULL`;
    const me = (await c.req('GET', '/api/team')).body.find(
      (m: { userId: string }) => m.userId === c.userId,
    );
    expect(me).toMatchObject({
      onCostMode: 'fixed',
      onCostBp: null,
      onCostPence: 455,
      costRatePence: 2455,
    });
  });

  it('quote vs actual, reports and the CSV all use the rate the percentage comes to', async () => {
    const c = await client();
    await c.req('PUT', `/api/team/${c.userId}/cost`, {
      baseCostPence: 2000,
      onCostMode: 'percent',
      onCostBp: 2250,
    });
    const cust = await seedCustomer(c);
    const job = (await c.req('POST', '/api/jobs', { customerId: cust.id, title: 'Two hours' }))
      .body;
    await adminSql`
      INSERT INTO timesheets (tenant_id, job_id, user_id, started_at, ended_at, source)
      VALUES (${c.tenantId}, ${job.id}, ${c.userId}, now() - interval '150 minutes', now() - interval '30 minutes', 'manual')`;

    const costing = (await c.req('GET', `/api/jobs/${job.id}/costing`)).body;
    expect(costing.labour[0]).toMatchObject({
      ratePence: 2450,
      rateIsDefault: false,
      costPence: 4900,
    });
    expect(costing.profit.labourPence).toBe(4900);

    const today = new Date().toISOString().slice(0, 10);
    const reports = (await c.req('GET', `/api/reports?from=${today.slice(0, 8)}01&to=${today}`))
      .body;
    const row = reports.jobs.find(
      (j: { jobId?: string; id?: string }) => (j.jobId ?? j.id) === job.id,
    );
    expect(row.labourPence).toBe(4900);
    const csv = reportsCsv(reports);
    const line = csv.split('\n').find((l) => l.includes('Two hours'))!;
    expect(line).toContain('49.00');
  });
});
