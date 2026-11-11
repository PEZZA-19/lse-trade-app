import type {
  AppointmentDto,
  JobDetailDto,
  JobLineDto,
  JobStageRef,
  JobSummaryDto,
  Page,
  appointmentCreate,
  jobCreate,
  timerAction,
  TimesheetDto,
  jobUpdate,
} from '@lse/shared';
import { minutesBetween, TIMER_MAX_AHEAD_MS, TIMER_MAX_BACKDATE_MS } from '@lse/shared';
import type { z } from 'zod';
import type { Tx } from '../db/client';
import { assertVersion, conflict, invalid, notFound } from '../lib/errors';
import { isoNN, type Auth } from '../lib/types';
import { audit } from './audit';
import { assertSiteOfCustomer, toSite } from './customers';
import { assertMember } from './schedule';
import { applyEvent, jobHistory, moveJob, recordCreated, stageByKey } from './stages';

interface JobRow {
  id: string;
  number: string;
  stageId: string;
  stageKey: JobStageRef['systemKey'];
  stageName: string;
  stageColour: JobStageRef['colour'];
  stageActive: boolean;
  customerId: string;
  customerName: string;
  siteId: string | null;
  siteAddress: string | null;
  title: string;
  sourceQuoteId: string | null;
  sourceQuoteNumber: string | null;
  quotedTotalPence: number;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

const SUMMARY_SELECT = `
  SELECT j.id, j.number, j.stage_id, st.system_key AS stage_key, st.name AS stage_name, st.colour AS stage_colour,
         st.is_active AS stage_active, j.customer_id, c.name AS customer_name, j.site_id, s.address AS site_address,
         j.title, j.source_quote_id, q.number AS source_quote_number,
         coalesce((SELECT sum(total_pence) FROM job_lines jl WHERE jl.job_id = j.id AND jl.source = 'quote'), 0)::bigint
           AS quoted_total_pence,
         j.created_at, j.updated_at, j.version
    FROM jobs j
    JOIN job_stages st ON st.id = j.stage_id
    JOIN customers c ON c.id = j.customer_id
    LEFT JOIN sites s ON s.id = j.site_id
    LEFT JOIN quotes q ON q.id = j.source_quote_id`;

const toSummary = (r: JobRow): JobSummaryDto => ({
  id: r.id,
  number: r.number,
  stage: {
    id: r.stageId,
    systemKey: r.stageKey,
    name: r.stageName,
    colour: r.stageColour,
    isActive: r.stageActive,
  },
  customerId: r.customerId,
  customerName: r.customerName,
  siteId: r.siteId,
  siteAddress: r.siteAddress,
  title: r.title,
  sourceQuoteId: r.sourceQuoteId,
  sourceQuoteNumber: r.sourceQuoteNumber,
  quotedTotalPence: r.quotedTotalPence,
  createdAt: isoNN(r.createdAt),
  updatedAt: isoNN(r.updatedAt),
  version: r.version,
});

export interface JobListQuery {
  q?: string | undefined;
  stageId?: string | undefined;
  /** "active" = jobs in an active stage (everything except Complete, Cancelled and inactive custom stages). */
  active?: boolean | undefined;
  customerId?: string | undefined;
  limit: number;
  offset: number;
}

export async function listJobs(tx: Tx, query: JobListQuery): Promise<Page<JobSummaryDto>> {
  const conds = [tx`TRUE`];
  if (query.stageId) conds.push(tx`j.stage_id = ${query.stageId}`);
  if (query.active) conds.push(tx`st.is_active`);
  if (query.customerId) conds.push(tx`j.customer_id = ${query.customerId}`);
  if (query.q) {
    const p = `%${query.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    conds.push(
      tx`(j.number ILIKE ${p} OR j.title ILIKE ${p} OR c.name ILIKE ${p} OR s.address ILIKE ${p})`,
    );
  }
  const where = conds.reduce((acc, c) => tx`${acc} AND ${c}`);
  const rows = await tx<JobRow[]>`
    ${tx.unsafe(SUMMARY_SELECT)} WHERE ${where}
    ORDER BY j.seq_value DESC NULLS LAST, j.created_at DESC
    LIMIT ${query.limit} OFFSET ${query.offset}`;
  const [{ count } = { count: 0 }] = await tx<{ count: number }[]>`
    SELECT count(*)::int AS count FROM jobs j
      JOIN job_stages st ON st.id = j.stage_id
      JOIN customers c ON c.id = j.customer_id LEFT JOIN sites s ON s.id = j.site_id
     WHERE ${where}`;
  return { items: rows.map(toSummary), total: count };
}

export async function getJob(tx: Tx, id: string): Promise<JobDetailDto> {
  const [row] = await tx<JobRow[]>`${tx.unsafe(SUMMARY_SELECT)} WHERE j.id = ${id}`;
  if (!row) throw notFound('Job');
  const [extra] = await tx<
    {
      description: string | null;
      placeOfWork: JobDetailDto['placeOfWork'];
      sourceQuoteRevision: number | null;
    }[]
  >`
    SELECT description, place_of_work, source_quote_revision FROM jobs WHERE id = ${id}`;
  const [site] = row.siteId
    ? await tx<
        {
          id: string;
          customerId: string;
          label: string | null;
          address: string;
          notes: string | null;
        }[]
      >`
        SELECT id, customer_id, label, address, notes FROM sites WHERE id = ${row.siteId}`
    : [];
  const lines = await tx<JobLineDto[]>`
    SELECT id, position, kind, description, qty_milli, unit_cost_pence, unit_sell_pence, total_pence, source,
           invoice_id IS NOT NULL AS invoiced
      FROM job_lines WHERE job_id = ${id} ORDER BY position`;
  const assignees = await tx<{ userId: string; name: string }[]>`
    SELECT a.user_id, u.name FROM job_assignees a JOIN users u ON u.id = a.user_id
     WHERE a.job_id = ${id} ORDER BY a.created_at`;
  const appointments = await tx<
    { id: string; startsAt: Date; endsAt: Date; userId: string | null }[]
  >`
    SELECT id, starts_at, ends_at, user_id FROM appointments WHERE job_id = ${id} ORDER BY starts_at`;
  const [timer] = await tx<{ startedAt: Date }[]>`
    SELECT started_at FROM job_timers
     WHERE job_id = ${id} AND user_id = app_current_user() AND stopped_at IS NULL LIMIT 1`;
  const timesheets = await tx<
    {
      id: string;
      userId: string;
      userName: string;
      startedAt: Date;
      endedAt: Date;
      source: TimesheetDto['source'];
      note: string | null;
      invoiced: boolean;
    }[]
  >`
    SELECT t.id, t.user_id, u.name AS user_name, t.started_at, t.ended_at, t.source, t.note,
           t.invoice_id IS NOT NULL AS invoiced
      FROM timesheets t JOIN users u ON u.id = t.user_id
     WHERE t.job_id = ${id} ORDER BY t.started_at DESC`;
  const sheets = timesheets.map((t): TimesheetDto => {
    const startedAt = isoNN(t.startedAt);
    const endedAt = isoNN(t.endedAt);
    return { ...t, startedAt, endedAt, minutes: minutesBetween(startedAt, endedAt) };
  });
  return {
    ...toSummary(row),
    description: extra!.description,
    placeOfWork: extra!.placeOfWork,
    sourceQuoteRevision: extra!.sourceQuoteRevision,
    site: site ? toSite(site) : null,
    lines: [...lines],
    history: await jobHistory(tx, id),
    assignees: [...assignees],
    appointments: appointments.map((a): AppointmentDto => ({
      id: a.id,
      startsAt: isoNN(a.startsAt),
      endsAt: isoNN(a.endsAt),
      userId: a.userId,
    })),
    timerRunning: !!timer,
    timerStartedAt: timer ? isoNN(timer.startedAt) : null,
    timesheets: sheets,
    totalMinutes: sheets.reduce((n, t) => n + t.minutes, 0),
  };
}

/** A job from scratch, for call-outs and small jobs without a quote. */
export async function createJob(
  tx: Tx,
  auth: Auth,
  input: z.output<typeof jobCreate>,
): Promise<JobDetailDto> {
  const [customer] = await tx`SELECT 1 FROM customers WHERE id = ${input.customerId}`;
  if (!customer)
    throw invalid('Pick a customer for this job', { fields: { customerId: 'Customer not found' } });
  await assertSiteOfCustomer(tx, input.siteId, input.customerId);
  const [num] = await tx<
    { value: number; formatted: string }[]
  >`SELECT * FROM allocate_number('job')`;
  // Every new job starts Unassigned.
  const unassigned = await stageByKey(tx, 'unassigned');
  const [job] = await tx<{ id: string }[]>`
    INSERT INTO jobs (tenant_id, number, seq_value, customer_id, site_id, title, description, place_of_work, created_by, stage_id)
    VALUES (${auth.tenantId}, ${num!.formatted}, ${num!.value}, ${input.customerId}, ${input.siteId}, ${input.title},
            ${input.description}, ${input.placeOfWork}, ${auth.userId}, ${unassigned.id})
    RETURNING id`;
  await recordCreated(tx, auth, job!.id, unassigned.id, 'created');
  await audit(tx, auth, 'create', 'job', job!.id, { number: num!.formatted });
  return getJob(tx, job!.id);
}

export async function updateJob(
  tx: Tx,
  auth: Auth,
  id: string,
  input: z.output<typeof jobUpdate>,
  expectedVersion?: number,
): Promise<JobDetailDto> {
  const [current] = await tx<
    { customerId: string; version: number }[]
  >`SELECT customer_id, version FROM jobs WHERE id = ${id} FOR UPDATE`;
  if (!current) throw notFound('Job');
  await assertVersion(expectedVersion, current.version, () => getJob(tx, id));
  const patch: Record<string, unknown> = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.description !== undefined) patch.description = input.description;
  if (input.placeOfWork !== undefined) patch.place_of_work = input.placeOfWork;
  if (input.siteId !== undefined) {
    await assertSiteOfCustomer(tx, input.siteId ?? null, current.customerId);
    patch.site_id = input.siteId ?? null;
  }
  if (Object.keys(patch).length) {
    await tx`UPDATE jobs SET ${tx(patch)} WHERE id = ${id}`;
    await audit(tx, auth, 'update', 'job', id, { fields: Object.keys(patch) });
  }
  // Manual stage change (from the job screen or the list). Any stage, including custom ones.
  const stageId =
    input.stageId ?? (input.stageKey ? (await stageByKey(tx, input.stageKey)).id : undefined);
  if (stageId) await moveJob(tx, auth, id, stageId, 'manual');
  return getJob(tx, id);
}

/* ----------- assignment, appointments, timer: minimal, but they drive the stages ----------- */

export const lockJob = async (tx: Tx, id: string) => {
  const [j] = await tx`SELECT 1 FROM jobs WHERE id = ${id} FOR UPDATE`;
  if (!j) throw notFound('Job');
};

/** Assign someone in this business. Unassigned → Assigned. */
export async function assign(tx: Tx, auth: Auth, jobId: string, userId: string) {
  await lockJob(tx, jobId);
  const [member] =
    await tx`SELECT 1 FROM memberships WHERE user_id = ${userId} AND tenant_id = ${auth.tenantId}`;
  if (!member)
    throw invalid('That person is not part of this business', {
      fields: { userId: 'Not a member' },
    });
  await tx`
    INSERT INTO job_assignees (tenant_id, job_id, user_id) VALUES (${auth.tenantId}, ${jobId}, ${userId})
    ON CONFLICT DO NOTHING`;
  await applyEvent(tx, auth, jobId, 'assigned');
  await audit(tx, auth, 'assign', 'job', jobId, { userId });
  return getJob(tx, jobId);
}

export async function unassign(tx: Tx, auth: Auth, jobId: string, userId: string) {
  await lockJob(tx, jobId);
  await tx`DELETE FROM job_assignees WHERE job_id = ${jobId} AND user_id = ${userId}`;
  await audit(tx, auth, 'unassign', 'job', jobId, { userId });
  return getJob(tx, jobId);
}

/** Book an appointment. Unassigned / Assigned → Booked in. */
export async function createAppointment(
  tx: Tx,
  auth: Auth,
  jobId: string,
  input: z.output<typeof appointmentCreate>,
) {
  await lockJob(tx, jobId);
  await assertMember(tx, auth, input.userId);
  const [a] = await tx<{ id: string }[]>`
    INSERT INTO appointments (tenant_id, job_id, user_id, starts_at, ends_at)
    VALUES (${auth.tenantId}, ${jobId}, ${input.userId ?? null}, ${input.startsAt}, ${input.endsAt}) RETURNING id`;
  await applyEvent(tx, auth, jobId, 'appointment_created');
  await audit(tx, auth, 'create', 'appointment', a!.id, { jobId });
  return getJob(tx, jobId);
}

/** Remove an appointment. If it was the last one, Booked in → Assigned / Unassigned. */
export async function deleteAppointment(tx: Tx, auth: Auth, appointmentId: string) {
  const [a] = await tx<
    { jobId: string }[]
  >`SELECT job_id FROM appointments WHERE id = ${appointmentId}`;
  if (!a) throw notFound('Appointment');
  await lockJob(tx, a.jobId);
  await tx`DELETE FROM appointments WHERE id = ${appointmentId}`;
  await applyEvent(tx, auth, a.jobId, 'appointment_deleted');
  await audit(tx, auth, 'delete', 'appointment', appointmentId, { jobId: a.jobId });
  return getJob(tx, a.jobId);
}

/** When the device says it happened, within reason; otherwise now. */
function deviceTime(at: string | undefined, now: Date): Date {
  if (!at) return now;
  const t = new Date(at);
  if (+t > +now + TIMER_MAX_AHEAD_MS)
    throw invalid('That time is in the future. Check the clock on this device.', {
      fields: { at: 'In the future' },
    });
  if (+t < +now - TIMER_MAX_BACKDATE_MS)
    throw invalid('That time is more than 7 days ago.', { fields: { at: 'Too long ago' } });
  return +t > +now ? now : t;
}

/** Stops a running timer and records its timesheet entry. */
async function finishTimer(
  tx: Tx,
  timer: { id: string; jobId: string; startedAt: Date },
  at: Date,
) {
  const end = +at < +timer.startedAt ? timer.startedAt : at;
  await tx`UPDATE job_timers SET stopped_at = ${end} WHERE id = ${timer.id}`;
  await tx`
    INSERT INTO timesheets (tenant_id, job_id, user_id, timer_id, started_at, ended_at, source)
    SELECT tenant_id, job_id, user_id, id, started_at, stopped_at, 'timer' FROM job_timers WHERE id = ${timer.id}`;
}

/**
 * Start my timer on this job. → In Progress. One running timer per person: if one is running on
 * another job, refuse (409 timer_running) unless `switch` is set, which stops it at the same moment.
 */
export async function startTimer(
  tx: Tx,
  auth: Auth,
  jobId: string,
  input: z.output<typeof timerAction> = {},
) {
  await lockJob(tx, jobId);
  const at = deviceTime(input.at, new Date());
  const [running] = await tx<{ id: string; jobId: string; jobNumber: string; startedAt: Date }[]>`
    SELECT t.id, t.job_id, j.number AS job_number, t.started_at
      FROM job_timers t JOIN jobs j ON j.id = t.job_id
     WHERE t.user_id = ${auth.userId} AND t.stopped_at IS NULL FOR UPDATE OF t`;
  if (running && running.jobId !== jobId) {
    if (!input.switch)
      throw conflict(
        'timer_running',
        `Your timer is running on job ${running.jobNumber}. Stop it first.`,
        { jobId: running.jobId, jobNumber: running.jobNumber },
      );
    await finishTimer(tx, running, at);
    await audit(tx, auth, 'timer_stop', 'job', running.jobId, { switchedTo: jobId });
  }
  if (!running || running.jobId !== jobId) {
    await tx`INSERT INTO job_timers (tenant_id, job_id, user_id, started_at)
             VALUES (${auth.tenantId}, ${jobId}, ${auth.userId}, ${at})`;
    await audit(tx, auth, 'timer_start', 'job', jobId, {});
  }
  await applyEvent(tx, auth, jobId, 'timer_started');
  return getJob(tx, jobId);
}

/** Stop my timer on this job and record the time as a timesheet entry. Stopping twice is harmless. */
export async function stopTimer(
  tx: Tx,
  auth: Auth,
  jobId: string,
  input: z.output<typeof timerAction> = {},
) {
  await lockJob(tx, jobId);
  const at = deviceTime(input.at, new Date());
  const [running] = await tx<{ id: string; jobId: string; startedAt: Date }[]>`
    SELECT id, job_id, started_at FROM job_timers
     WHERE job_id = ${jobId} AND user_id = ${auth.userId} AND stopped_at IS NULL FOR UPDATE`;
  if (running) {
    await finishTimer(tx, running, at);
    await audit(tx, auth, 'timer_stop', 'job', jobId, {});
  }
  return getJob(tx, jobId);
}

/**
 * Hook for the invoicing milestone: call when a job is fully invoiced and every invoice is paid.
 * → Complete. Not exposed over HTTP until invoices exist.
 */
export async function markFullyInvoicedAndPaid(tx: Tx, auth: Auth, jobId: string) {
  await lockJob(tx, jobId);
  await applyEvent(tx, auth, jobId, 'invoiced_and_paid');
  return getJob(tx, jobId);
}
