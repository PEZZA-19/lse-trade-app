import { reportsCsv } from '@lse/shared';
import { describe, expect, it } from 'vitest';
import { client, clientFor, seedCustomer } from './api-helpers';
import { addMember, adminSql } from './helpers';

type Member = { userId: string; name: string; chargeOutPence: number; chargeOutIsDefault: boolean };

async function setup() {
  const c = await client();
  const staffEmail = await addMember(c.tenantId, 'staff');
  const staff = await clientFor(staffEmail, c);
  const team: Member[] = (await c.req('GET', '/api/team')).body;
  const sam = team.find((m) => m.userId !== c.userId)!;
  return { c, staff, sam };
}

describe('per-person charge-out rates', () => {
  it('everyone starts on the business rate (£45); the owner sets and clears their own; staff cannot', async () => {
    const { c, staff, sam } = await setup();
    expect(sam).toMatchObject({ chargeOutPence: 4500, chargeOutIsDefault: true });
    const set = await c.req('PUT', `/api/team/${sam.userId}/charge-out`, { chargeOutPence: 6000 });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body).toMatchObject({ chargeOutPence: 6000, chargeOutIsDefault: false });
    expect(
      (await staff.req('PUT', `/api/team/${sam.userId}/charge-out`, { chargeOutPence: 9900 }))
        .status,
    ).toBe(403);
    expect(
      (await c.req('PUT', `/api/team/${sam.userId}/charge-out`, { chargeOutPence: -1 })).status,
    ).toBe(422);
    const cleared = await c.req('PUT', `/api/team/${sam.userId}/charge-out`, {
      chargeOutPence: null,
    });
    expect(cleared.body).toMatchObject({ chargeOutPence: 4500, chargeOutIsDefault: true });
  });

  it('costing, reports, the CSV and time-and-materials invoices use each person’s own rate', async () => {
    const { c, sam } = await setup();
    await c.req('PUT', `/api/team/${sam.userId}/charge-out`, { chargeOutPence: 6000 });
    const cust = await seedCustomer(c);
    const job = (await c.req('POST', '/api/jobs', { customerId: cust.id, title: 'Rates job' }))
      .body;
    // Joe 60 min (business £45), Sam 30 min (own £60). No cost rates: costed at charge-out.
    await adminSql`
      INSERT INTO timesheets (tenant_id, job_id, user_id, started_at, ended_at, source)
      VALUES (${c.tenantId}, ${job.id}, ${c.userId}, now() - interval '200 minutes', now() - interval '140 minutes', 'manual'),
             (${c.tenantId}, ${job.id}, ${sam.userId}, now() - interval '100 minutes', now() - interval '70 minutes', 'manual')`;

    const costing = (await c.req('GET', `/api/jobs/${job.id}/costing`)).body;
    const rows = Object.fromEntries(
      costing.labour.map((l: { userId: string }) => [l.userId, l]),
    ) as Record<string, { chargeOutRatePence: number; chargeOutPence: number; costPence: number }>;
    expect(rows[c.userId]).toMatchObject({
      chargeOutRatePence: 4500,
      chargeOutPence: 4500,
      costPence: 4500,
    });
    expect(rows[sam.userId]).toMatchObject({
      chargeOutRatePence: 6000,
      chargeOutPence: 3000,
      costPence: 3000,
    });
    expect(costing.profit.chargeOutPence).toBe(7500);

    const today = new Date().toISOString().slice(0, 10);
    const reports = (await c.req('GET', `/api/reports?from=${today.slice(0, 8)}01&to=${today}`))
      .body;
    expect(reports.jobs.find((j: { jobId: string }) => j.jobId === job.id).chargeOutPence).toBe(
      7500,
    );
    expect(
      reportsCsv(reports)
        .split('\n')
        .find((l) => l.includes('Rates job')),
    ).toContain('75.00');

    const summary = (await c.req('GET', `/api/jobs/${job.id}/invoicing`)).body;
    expect(summary.unbilledLabourPence).toBe(7500);
    const inv = await c.req('POST', `/api/jobs/${job.id}/invoices`, { source: 'job' });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    const labour = inv.body.lines.filter((l: { kind: string }) => l.kind === 'labour');
    expect(labour.map((l: { unitPricePence: number }) => l.unitPricePence).sort()).toEqual([
      4500, 6000,
    ]);
  });
});
