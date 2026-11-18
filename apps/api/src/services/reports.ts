import {
  chargeOutFor,
  profitFigures,
  quotedLabourCost,
  labourValue,
  personLabourCost,
  type LabourCostRow,
  type JobProfitDto,
  type ReportQuery,
  type ReportsDto,
  type TimeReportDto,
} from '@lse/shared';
import type { Tx } from '../db/client';
import { today } from './invoices';

const n = (v: unknown) => Number(v ?? 0);

/**
 * Owner reports, read-only: money in and owed, profit per job (price against actual time and
 * materials) and time by person and job. Everything is computed from the same rows the rest of
 * the app uses, so the numbers always agree with the invoice, bill and timesheet screens.
 */
export async function getReports(tx: Tx, q: ReportQuery): Promise<ReportsDto> {
  const t = await today(tx);
  const [tenant] = await tx<{ labourRatePence: string }[]>`
    SELECT labour_rate_pence FROM tenants WHERE id = app_current_tenant()`;
  const rate = n(tenant?.labourRatePence);

  const [pay] = await tx<{ total: string; count: string }[]>`
    SELECT COALESCE(SUM(amount_pence), 0) AS total, COUNT(*) AS count
      FROM payments WHERE paid_on BETWEEN ${q.from}::date AND ${q.to}::date`;
  const [inv] = await tx<{ total: string }[]>`
    SELECT COALESCE(SUM(total_pence), 0) AS total FROM invoices
     WHERE status <> 'draft' AND issue_date BETWEEN ${q.from}::date AND ${q.to}::date`;
  const [cn] = await tx<{ total: string }[]>`
    SELECT COALESCE(SUM(amount_pence), 0) AS total FROM credit_notes
     WHERE status = 'approved' AND issue_date BETWEEN ${q.from}::date AND ${q.to}::date`;
  const [bills] = await tx<{ total: string }[]>`
    SELECT COALESCE(SUM(CASE kind WHEN 'credit_note' THEN -total_pence ELSE total_pence END), 0) AS total
      FROM supplier_bills
     WHERE status = 'applied' AND bill_date BETWEEN ${q.from}::date AND ${q.to}::date`;
  const [owed] = await tx<
    { owed: string; owedCount: string; overdue: string; overdueCount: string }[]
  >`
    SELECT COALESCE(SUM(bal), 0) AS owed, COUNT(*) FILTER (WHERE bal > 0) AS owed_count,
           COALESCE(SUM(bal) FILTER (WHERE late), 0) AS overdue,
           COUNT(*) FILTER (WHERE late AND bal > 0) AS overdue_count
      FROM (SELECT total_pence - paid_pence - credited_pence AS bal,
                   status IN ('sent', 'part_paid') AND due_date < ${t}::date AS late
              FROM invoices WHERE status IN ('approved', 'sent', 'part_paid')) o
     WHERE bal > 0`;

  const { jobs } = await jobProfits(tx, rate);

  // Time in the period, by person and by job (a timesheet counts on the day it started).
  const timeRows = await tx<
    {
      userId: string;
      userName: string;
      jobId: string;
      jobNumber: string;
      jobTitle: string;
      minutes: string;
    }[]
  >`
    SELECT s.user_id, u.name AS user_name, s.job_id, j.number AS job_number, j.title AS job_title,
           SUM(EXTRACT(EPOCH FROM (s.ended_at - s.started_at)) / 60)::bigint AS minutes
      FROM timesheets s
      JOIN users u ON u.id = s.user_id
      JOIN jobs j ON j.id = s.job_id
      JOIN tenants tn ON tn.id = app_current_tenant()
     WHERE (s.started_at AT TIME ZONE tn.timezone)::date BETWEEN ${q.from}::date AND ${q.to}::date
     GROUP BY s.user_id, u.name, s.job_id, j.number, j.title`;
  const people = new Map<string, { id: string; name: string; minutes: number }>();
  const byJob = new Map<string, TimeReportDto['byJob'][number]>();
  for (const r of timeRows) {
    const m = n(r.minutes);
    const p = people.get(r.userId) ?? { id: r.userId, name: r.userName, minutes: 0 };
    p.minutes += m;
    people.set(r.userId, p);
    const j = byJob.get(r.jobId) ?? {
      id: r.jobId,
      name: r.jobTitle,
      number: r.jobNumber,
      minutes: 0,
      byPerson: [],
    };
    j.minutes += m;
    j.byPerson.push({ id: r.userId, name: r.userName, minutes: m });
    byJob.set(r.jobId, j);
  }
  const desc = <T extends { minutes: number }>(a: T, b: T) => b.minutes - a.minutes;
  const time: TimeReportDto = {
    totalMinutes: [...people.values()].reduce((s, p) => s + p.minutes, 0),
    byPerson: [...people.values()].sort(desc),
    byJob: [...byJob.values()].map((j) => ({ ...j, byPerson: j.byPerson.sort(desc) })).sort(desc),
  };

  return {
    from: q.from,
    to: q.to,
    labourRatePence: rate,
    costRates: await costRateCoverage(tx),
    money: {
      inPence: n(pay?.total),
      paymentCount: n(pay?.count),
      invoicedPence: n(inv?.total) - n(cn?.total),
      billsPence: n(bills?.total),
      owedPence: n(owed?.owed),
      overduePence: n(owed?.overdue),
      owedCount: n(owed?.owedCount),
      overdueCount: n(owed?.overdueCount),
    },
    jobs,
    time,
  };
}

/** Of the people who have logged time, how many have their own cost rate. */
async function costRateCoverage(tx: Tx) {
  const [r] = await tx<{ people: string; set: string }[]>`
    SELECT COUNT(DISTINCT s.user_id) AS people, COUNT(DISTINCT mc.user_id) AS set
      FROM timesheets s LEFT JOIN member_costs mc ON mc.user_id = s.user_id`;
  return { people: n(r?.people), set: n(r?.set) };
}

/**
 * Profit for whole jobs (every job not cancelled with a price, time or costs, or just one job):
 * profit so far (invoiced − labour at each person's cost rate − materials at cost) and expected
 * profit (expected revenue − the higher of quoted and actual cost, for labour and materials).
 * A person with no cost rate is costed at the labour rate and counted in missingCostRates.
 */
export async function jobProfits(
  tx: Tx,
  rate: number,
  jobId?: string,
): Promise<{ jobs: JobProfitDto[]; labour: Map<string, LabourCostRow[]> }> {
  const one = jobId ?? null;
  const jobRows = await tx<
    {
      jobId: string;
      number: string;
      title: string;
      customerName: string;
      stage: string;
      quoted: string | null;
      lineValue: string;
      materials: string;
      invoiced: string;
      creditUsed: string;
      quotedLabourMilli: string;
      quotedMaterialsCost: string;
    }[]
  >`
    SELECT j.id AS job_id, j.number, j.title, c.name AS customer_name, st.name AS stage,
           (SELECT SUM(total_pence) FROM job_lines l WHERE l.job_id = j.id AND l.source = 'quote')
             AS quoted,
           (SELECT COALESCE(SUM(total_pence), 0) FROM job_lines l WHERE l.job_id = j.id) AS line_value,
           (SELECT COALESCE(SUM(ROUND(COALESCE(l.unit_cost_pence, 0) * l.qty_milli / 1000.0)), 0)
              FROM job_lines l
             WHERE l.job_id = j.id AND l.kind = 'material' AND l.source <> 'quote') AS materials,
           (SELECT COALESCE(SUM(v.subtotal_pence), 0) FROM invoices v
             WHERE v.job_id = j.id AND v.status <> 'draft')
           - (SELECT COALESCE(SUM(ROUND(cn.amount_pence * v.subtotal_pence::numeric
                                        / NULLIF(v.total_pence, 0))), 0)
                FROM credit_notes cn JOIN invoices v ON v.id = cn.invoice_id
               WHERE v.job_id = j.id AND cn.status = 'approved') AS invoiced,
           (SELECT COALESCE(SUM(u.amount_pence), 0) FROM credit_uses u
              JOIN invoices v ON v.id = u.invoice_id
             WHERE v.job_id = j.id AND u.after_issue) AS credit_used,
           (SELECT COALESCE(SUM(qty_milli), 0) FROM job_lines l
             WHERE l.job_id = j.id AND l.source = 'quote' AND l.kind = 'labour') AS quoted_labour_milli,
           -- Quoted materials and extras at cost: the line's cost where known, else price ÷ markup.
           (SELECT COALESCE(SUM(CASE WHEN l.unit_cost_pence IS NOT NULL
                                     THEN ROUND(l.unit_cost_pence * l.qty_milli / 1000.0)
                                     ELSE ROUND(l.total_pence * 10000.0 / t.default_markup_bp) END), 0)
              FROM job_lines l
             WHERE l.job_id = j.id AND l.source = 'quote' AND l.kind <> 'labour') AS quoted_materials_cost
      FROM jobs j
      JOIN tenants t ON t.id = j.tenant_id
      JOIN customers c ON c.id = j.customer_id
      JOIN job_stages st ON st.id = j.stage_id
     WHERE (${one}::uuid IS NULL OR j.id = ${one}::uuid)
       AND (${one}::uuid IS NOT NULL OR st.system_key IS DISTINCT FROM 'cancelled')
     ORDER BY j.created_at DESC
     LIMIT 300`;
  const people = await tx<
    {
      jobId: string;
      userId: string;
      name: string;
      minutes: string;
      costRate: string | null;
      chargeOut: string | null;
    }[]
  >`
    SELECT s.job_id, s.user_id, u.name,
           SUM(EXTRACT(EPOCH FROM (s.ended_at - s.started_at)) / 60)::bigint AS minutes,
           mc.base_cost_pence + mc.on_cost_pence AS cost_rate, co.charge_out_pence AS charge_out
      FROM timesheets s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN member_costs mc ON mc.user_id = s.user_id
      LEFT JOIN member_charge_out co ON co.user_id = s.user_id
     WHERE (${one}::uuid IS NULL OR s.job_id = ${one}::uuid)
     GROUP BY s.job_id, s.user_id, u.name, mc.base_cost_pence, mc.on_cost_pence, co.charge_out_pence
     ORDER BY u.name`;
  // Before anyone logs time, quoted labour is costed at the team's average cost rate.
  const [avg] = await tx<{ avg: string | null }[]>`
    SELECT ROUND(AVG(base_cost_pence + on_cost_pence)) AS avg FROM member_costs`;
  const fallbackRatePence = avg?.avg == null ? rate : n(avg.avg);
  const labour = new Map<string, LabourCostRow[]>();
  for (const p of people) {
    const minutes = n(p.minutes);
    const costRate = p.costRate === null ? null : n(p.costRate);
    // Each person's own charge-out rate (else the business rate); with no cost rate set, their time
    // is costed at it, as before.
    const chargeOutRatePence = chargeOutFor(p.chargeOut === null ? null : n(p.chargeOut), rate);
    const row: LabourCostRow = {
      userId: p.userId,
      name: p.name,
      minutes,
      ratePence: costRate ?? chargeOutRatePence,
      rateIsDefault: costRate === null,
      costPence: personLabourCost(minutes, costRate, chargeOutRatePence),
      chargeOutRatePence,
      chargeOutPence: labourValue(minutes, chargeOutRatePence),
    };
    labour.set(p.jobId, [...(labour.get(p.jobId) ?? []), row]);
  }
  const jobs = jobRows
    .map((r): JobProfitDto => {
      const rows = labour.get(r.jobId) ?? [];
      const minutes = rows.reduce((t, x) => t + x.minutes, 0);
      const labourPence = rows.reduce((t, x) => t + x.costPence, 0);
      const parts = {
        quotedPence: r.quoted === null ? null : n(r.quoted),
        lineValuePence: n(r.lineValue),
        labourPence,
        materialsCostPence: n(r.materials),
      };
      const chargeOutPence = rows.reduce((t, x) => t + x.chargeOutPence, 0);
      const invoicedPence = n(r.invoiced);
      const creditUsedPence = n(r.creditUsed);
      return {
        jobId: r.jobId,
        number: r.number,
        title: r.title,
        customerName: r.customerName,
        stage: r.stage,
        ...parts,
        minutes,
        chargeOutPence,
        missingCostRates: rows.filter((x) => x.rateIsDefault).length,
        invoicedPence,
        creditUsedPence,
        ...profitFigures({
          ...parts,
          chargeOutPence,
          invoicedPence,
          creditUsedPence,
          quotedLabourCostPence: quotedLabourCost({
            quotedMinutes: Math.round((n(r.quotedLabourMilli) * 60) / 1000),
            minutes,
            labourPence,
            fallbackRatePence,
          }),
          quotedMaterialsCostPence: n(r.quotedMaterialsCost),
        }),
      };
    })
    .filter(
      (j) => one !== null || j.quotedPence !== null || j.minutes > 0 || j.materialsCostPence > 0,
    );
  return { jobs, labour };
}
