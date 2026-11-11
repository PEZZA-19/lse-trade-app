import type { jobStageCreate, jobStageUpdate } from '@lse/shared';
import {
  autoStage,
  canRenameStage,
  EDITABLE_SYSTEM_STAGES,
  type JobHistoryDto,
  type JobStageDto,
  type JobStageRef,
  type StageCause,
  type StageEvent,
  type SystemStageKey,
} from '@lse/shared';
import type { z } from 'zod';
import type { Tx } from '../db/client';
import { AppError, conflict, invalid, notFound } from '../lib/errors';
import { isoNN, type Auth } from '../lib/types';
import { audit } from './audit';

interface StageRow extends JobStageRef {
  sortOrder: number;
  jobCount: number;
}

const toDto = (r: StageRow): JobStageDto => ({
  id: r.id,
  systemKey: r.systemKey,
  name: r.name,
  colour: r.colour,
  isActive: r.isActive,
  sortOrder: r.sortOrder,
  isSystem: r.systemKey !== null,
  canRename: canRenameStage(r.systemKey),
  canDelete: r.systemKey === null || EDITABLE_SYSTEM_STAGES.includes(r.systemKey),
  jobCount: r.jobCount,
});

export async function listStages(tx: Tx): Promise<JobStageDto[]> {
  const rows = await tx<StageRow[]>`
    SELECT s.id, s.system_key, s.name, s.colour, s.is_active, s.sort_order,
           (SELECT count(*)::int FROM jobs j WHERE j.stage_id = s.id) AS job_count
      FROM job_stages s ORDER BY s.sort_order, s.name`;
  return rows.map(toDto);
}

async function getStage(tx: Tx, id: string): Promise<JobStageDto> {
  const s = (await listStages(tx)).find((x) => x.id === id);
  if (!s) throw notFound('Stage');
  return s;
}

export async function stageByKey(tx: Tx, key: SystemStageKey): Promise<JobStageRef> {
  const [s] = await tx<JobStageRef[]>`
    SELECT id, system_key, name, colour, is_active FROM job_stages WHERE system_key = ${key}`;
  // Deleting To Invoice / On Hold is allowed, so those can be missing.
  if (!s) throw invalid(`This business has no "${key.replace('_', ' ')}" stage`);
  return s;
}

const ownerOnly = (auth: Auth) => {
  if (auth.role !== 'owner')
    throw new AppError(403, 'forbidden', 'Only the business owner can change job stages');
};

const uniqueName = (e: unknown) => {
  if ((e as { code?: string }).code === '23505')
    throw invalid('There is already a stage with that name', { fields: { name: 'Already used' } });
  throw e;
};

export async function createStage(tx: Tx, auth: Auth, input: z.output<typeof jobStageCreate>) {
  ownerOnly(auth);
  const [max] = await tx<
    { m: number }[]
  >`SELECT coalesce(max(sort_order), 0)::int AS m FROM job_stages`;
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO job_stages (tenant_id, name, colour, is_active, sort_order)
    VALUES (${auth.tenantId}, ${input.name}, ${input.colour}, ${input.isActive}, ${input.sortOrder ?? max!.m + 10})
    RETURNING id`.catch(uniqueName);
  await audit(tx, auth, 'create', 'job_stage', row!.id, { name: input.name });
  return getStage(tx, row!.id);
}

/** System stages keep their name and Active flag (except To Invoice / On Hold names); colour and order are free. */
export async function updateStage(
  tx: Tx,
  auth: Auth,
  id: string,
  input: z.output<typeof jobStageUpdate>,
) {
  ownerOnly(auth);
  const s = await getStage(tx, id);
  if (input.name !== undefined && input.name !== s.name && !s.canRename)
    throw conflict('stage_locked', `"${s.name}" is a system stage and can't be renamed.`);
  if (input.isActive !== undefined && input.isActive !== s.isActive && s.isSystem)
    throw conflict(
      'stage_locked',
      `"${s.name}" is a system stage; whether it counts as active is fixed.`,
    );
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.colour !== undefined) patch.colour = input.colour;
  if (input.isActive !== undefined) patch.is_active = input.isActive;
  if (input.sortOrder !== undefined) patch.sort_order = input.sortOrder;
  if (Object.keys(patch).length) {
    await tx`UPDATE job_stages SET ${tx(patch)} WHERE id = ${id}`.catch(uniqueName);
    await audit(tx, auth, 'update', 'job_stage', id, { fields: Object.keys(patch) });
  }
  return getStage(tx, id);
}

export async function deleteStage(tx: Tx, auth: Auth, id: string) {
  ownerOnly(auth);
  const s = await getStage(tx, id);
  if (!s.canDelete)
    throw conflict('stage_locked', `"${s.name}" is a system stage and can't be deleted.`);
  if (s.jobCount > 0)
    throw conflict(
      'stage_in_use',
      `${s.jobCount} job${s.jobCount === 1 ? ' is' : 's are'} in "${s.name}". Move them first.`,
    );
  // History keeps the stage's name (snapshotted), so deleting is safe.
  await tx`DELETE FROM job_stages WHERE id = ${id}`;
  await audit(tx, auth, 'delete', 'job_stage', id, { name: s.name });
}

/* ------------------------------ transitions ------------------------------ */

/** Moves a job to a stage and writes the history entry. No-op if it's already there. */
export async function moveJob(
  tx: Tx,
  auth: Auth,
  jobId: string,
  toStageId: string,
  cause: StageCause,
) {
  const [cur] = await tx<{ stageId: string; name: string }[]>`
    SELECT j.stage_id, s.name FROM jobs j JOIN job_stages s ON s.id = j.stage_id WHERE j.id = ${jobId} FOR UPDATE OF j`;
  if (!cur) throw notFound('Job');
  if (cur.stageId === toStageId) return false;
  const [to] = await tx<{ name: string }[]>`SELECT name FROM job_stages WHERE id = ${toStageId}`;
  if (!to) throw invalid('That stage does not exist', { fields: { stageId: 'Unknown stage' } });
  await tx`UPDATE jobs SET stage_id = ${toStageId} WHERE id = ${jobId}`;
  await tx`
    INSERT INTO job_history (tenant_id, job_id, from_stage_id, to_stage_id, from_name, to_name, cause, user_id)
    VALUES (${auth.tenantId}, ${jobId}, ${cur.stageId}, ${toStageId}, ${cur.name}, ${to.name}, ${cause}, ${auth.userId})`;
  return true;
}

/** Records the first history entry for a new job. */
export async function recordCreated(
  tx: Tx,
  auth: Auth,
  jobId: string,
  stageId: string,
  cause: StageCause,
) {
  await tx`
    INSERT INTO job_history (tenant_id, job_id, to_stage_id, to_name, cause, user_id)
    SELECT ${auth.tenantId}, ${jobId}, id, name, ${cause}, ${auth.userId} FROM job_stages WHERE id = ${stageId}`;
}

/** Applies the automatic transition for an event (assigning, appointments, timer, invoices). */
export async function applyEvent(tx: Tx, auth: Auth, jobId: string, event: StageEvent) {
  const [job] = await tx<
    { systemKey: SystemStageKey | null; assignees: number; appointments: number }[]
  >`
    SELECT s.system_key,
           (SELECT count(*)::int FROM job_assignees a WHERE a.job_id = j.id) AS assignees,
           (SELECT count(*)::int FROM appointments p WHERE p.job_id = j.id) AS appointments
      FROM jobs j JOIN job_stages s ON s.id = j.stage_id WHERE j.id = ${jobId}`;
  if (!job) throw notFound('Job');
  const next = autoStage(event, job.systemKey, {
    hasAssignees: job.assignees > 0,
    appointmentsLeft: job.appointments,
  });
  if (!next) return false;
  const target = await stageByKey(tx, next);
  return moveJob(tx, auth, jobId, target.id, event);
}

export async function jobHistory(tx: Tx, jobId: string): Promise<JobHistoryDto[]> {
  const rows = await tx<
    {
      id: string;
      fromName: string | null;
      toName: string;
      toColour: JobHistoryDto['toColour'];
      cause: StageCause;
      userName: string | null;
      createdAt: Date;
    }[]
  >`
    SELECT h.id, h.from_name, h.to_name, s.colour AS to_colour, h.cause, u.name AS user_name, h.created_at
      FROM job_history h
      LEFT JOIN job_stages s ON s.id = h.to_stage_id
      LEFT JOIN users u ON u.id = h.user_id
     WHERE h.job_id = ${jobId}
     ORDER BY h.created_at, h.id`;
  return rows.map((r) => ({ ...r, createdAt: isoNN(r.createdAt) }));
}
