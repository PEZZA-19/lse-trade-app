import type {
  AppointmentListItemDto,
  JobStageRef,
  MemberDto,
  RunningTimerDto,
  appointmentRange,
  appointmentUpdate,
} from '@lse/shared';
import type { z } from 'zod';
import type { Tx } from '../db/client';
import { invalid, notFound } from '../lib/errors';
import { isoNN, type Auth } from '../lib/types';
import { audit } from './audit';

/** People in this business (for assigning jobs and appointments). */
export async function listMembers(tx: Tx): Promise<MemberDto[]> {
  const rows = await tx<MemberDto[]>`
    SELECT m.user_id, u.name, m.role FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.tenant_id = app_current_tenant() ORDER BY (m.role = 'owner') DESC, u.name`;
  return [...rows];
}

export async function assertMember(tx: Tx, auth: Auth, userId: string | null | undefined) {
  if (!userId) return;
  const [m] =
    await tx`SELECT 1 FROM memberships WHERE user_id = ${userId} AND tenant_id = ${auth.tenantId}`;
  if (!m)
    throw invalid('That person is not part of this business', {
      fields: { userId: 'Not a member' },
    });
}

interface ApptRow {
  id: string;
  jobId: string;
  jobNumber: string;
  jobTitle: string;
  customerName: string;
  siteAddress: string | null;
  stageId: string;
  stageKey: JobStageRef['systemKey'];
  stageName: string;
  stageColour: JobStageRef['colour'];
  stageActive: boolean;
  startsAt: Date;
  endsAt: Date;
  userId: string | null;
  userName: string | null;
}
const APPT_SELECT = `
  SELECT a.id, a.job_id, j.number AS job_number, j.title AS job_title, c.name AS customer_name,
         s.address AS site_address, st.id AS stage_id, st.system_key AS stage_key, st.name AS stage_name,
         st.colour AS stage_colour, st.is_active AS stage_active, a.starts_at, a.ends_at, a.user_id,
         u.name AS user_name
    FROM appointments a
    JOIN jobs j ON j.id = a.job_id
    JOIN job_stages st ON st.id = j.stage_id
    JOIN customers c ON c.id = j.customer_id
    LEFT JOIN sites s ON s.id = j.site_id
    LEFT JOIN users u ON u.id = a.user_id`;
const toItem = (r: ApptRow): AppointmentListItemDto => ({
  id: r.id,
  jobId: r.jobId,
  jobNumber: r.jobNumber,
  jobTitle: r.jobTitle,
  customerName: r.customerName,
  siteAddress: r.siteAddress,
  stage: {
    id: r.stageId,
    systemKey: r.stageKey,
    name: r.stageName,
    colour: r.stageColour,
    isActive: r.stageActive,
  },
  startsAt: isoNN(r.startsAt),
  endsAt: isoNN(r.endsAt),
  userId: r.userId,
  userName: r.userName,
});

/** Appointments overlapping [from, to). */
export async function listAppointments(
  tx: Tx,
  range: z.output<typeof appointmentRange>,
): Promise<AppointmentListItemDto[]> {
  const rows = await tx<ApptRow[]>`${tx.unsafe(APPT_SELECT)}
    WHERE a.starts_at < ${range.to} AND a.ends_at > ${range.from}
    ORDER BY a.starts_at, j.number`;
  return rows.map(toItem);
}

export async function getAppointment(tx: Tx, id: string) {
  const [r] = await tx<ApptRow[]>`${tx.unsafe(APPT_SELECT)} WHERE a.id = ${id}`;
  if (!r) throw notFound('Appointment');
  return toItem(r);
}

/** Move or resize an appointment (drag on the calendar, or the edit sheet). Stage is unaffected. */
export async function updateAppointment(
  tx: Tx,
  auth: Auth,
  id: string,
  input: z.output<typeof appointmentUpdate>,
) {
  const before = await getAppointment(tx, id);
  if (input.userId !== undefined) await assertMember(tx, auth, input.userId);
  await tx`
    UPDATE appointments
       SET starts_at = ${input.startsAt}, ends_at = ${input.endsAt},
           user_id = ${input.userId === undefined ? before.userId : input.userId}, updated_at = now()
     WHERE id = ${id}`;
  await audit(tx, auth, 'update', 'appointment', id, {
    from: { startsAt: before.startsAt, endsAt: before.endsAt },
    to: { startsAt: input.startsAt, endsAt: input.endsAt },
  });
  return getAppointment(tx, id);
}

/** My running timer, if any. */
export async function runningTimer(tx: Tx): Promise<RunningTimerDto | null> {
  const [r] = await tx<{ jobId: string; jobNumber: string; jobTitle: string; startedAt: Date }[]>`
    SELECT t.job_id, j.number AS job_number, j.title AS job_title, t.started_at
      FROM job_timers t JOIN jobs j ON j.id = t.job_id
     WHERE t.user_id = app_current_user() AND t.stopped_at IS NULL`;
  return r ? { ...r, startedAt: isoNN(r.startedAt) } : null;
}
