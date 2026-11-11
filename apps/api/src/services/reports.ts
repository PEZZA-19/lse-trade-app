import {
  jobProfit,
  labourValue,
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

  // Profit per job: every job that is not cancelled and has a price, time or costs.
  const jobRows = await tx<
    {
      jobId: string;
      number: string;
      title: string;
      customerName: string;
      stage: string;
      quoted: string | null;
      lineValue: string;
      minutes: string;
      materials: string;
      invoiced: string;
    }[]
  >`
    SELECT j.id AS job_id, j.number, j.title, c.name AS customer_name, st.name AS stage,
           (SELECT SUM(total_pence) FROM job_lines l WHERE l.job_id = j.id AND l.source = 'quote')
             AS quoted,
           (SELECT COALESCE(SUM(total_pence), 0) FROM job_lines l WHERE l.job_id = j.id) AS line_value,
           (SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (ended_at - started_at)) / 60), 0)::bigint
              FROM timesheets s WHERE s.job_id = j.id) AS minutes,
           (SELECT COALESCE(SUM(ROUND(COALESCE(l.unit_cost_pence, 0) * l.qty_milli / 1000.0)), 0)
              FROM job_lines l
             WHERE l.job_id = j.id AND l.kind = 'material' AND l.source <> 'quote') AS materials,
           (SELECT COALESCE(SUM(v.subtotal_pence), 0) FROM invoices v
             WHERE v.job_id = j.id AND v.status <> 'draft') AS invoiced
      FROM jobs j
      JOIN customers c ON c.id = j.customer_id
      JOIN job_stages st ON st.id = j.stage_id
     WHERE st.system_key IS DISTINCT FROM 'cancelled'
     ORDER BY j.created_at DESC
     LIMIT 300`;
  const jobs: JobProfitDto[] = jobRows
    .map((r) => {
      const minutes = n(r.minutes);
      const parts = {
        quotedPence: r.quoted === null ? null : n(r.quoted),
        lineValuePence: n(r.lineValue),
        labourPence: labourValue(minutes, rate),
        materialsCostPence: n(r.materials),
      };
      return {
        jobId: r.jobId,
        number: r.number,
        title: r.title,
        customerName: r.customerName,
        stage: r.stage,
        ...parts,
        minutes,
        invoicedPence: n(r.invoiced),
        profitPence: jobProfit(parts),
      };
    })
    .filter((j) => j.quotedPence !== null || j.minutes > 0 || j.materialsCostPence > 0);

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
