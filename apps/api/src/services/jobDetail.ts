import {
  dataUrlBytes,
  sellFromCost,
  signedLineTotal,
  type JobNoteDto,
  type JobPhotoDto,
  type jobLineCreate,
  type jobLineUpdate,
  type jobNoteCreate,
  type photoUpload,
  type timesheetCreate,
  type timesheetUpdate,
} from '@lse/shared';
import type { z } from 'zod';
import type { Tx } from '../db/client';
import { BlobsNotConfigured, sniffImage, type BlobStore } from '../lib/blobs';
import { AppError, conflict, invalid, notFound } from '../lib/errors';
import { isoNN, type Auth } from '../lib/types';
import { audit } from './audit';
import { getJob, lockJob } from './jobs';
import { defaultMarkup } from './pricelist';
import { assertMember } from './schedule';

const isOwner = (auth: Auth) => auth.role === 'owner';

/** The accountant reads; everyone else on the team can record work on a job. */
function assertCanRecord(auth: Auth) {
  if (auth.role === 'accountant')
    throw new AppError(403, 'read_only', 'Accountant access is read-only.');
}

/* ------------------------------ timesheets ------------------------------ */

interface SheetRow {
  id: string;
  jobId: string;
  userId: string;
  startedAt: Date;
  endedAt: Date;
  invoiced: boolean;
}

async function sheetForChange(tx: Tx, auth: Auth, id: string): Promise<SheetRow> {
  const [s] = await tx<SheetRow[]>`
    SELECT id, job_id, user_id, started_at, ended_at, invoice_id IS NOT NULL AS invoiced
      FROM timesheets WHERE id = ${id} FOR UPDATE`;
  if (!s) throw notFound('Time entry');
  if (!isOwner(auth) && s.userId !== auth.userId)
    throw new AppError(403, 'not_yours', 'You can only change your own time.');
  if (s.invoiced)
    throw conflict('invoiced', 'This time is on an invoice. Credit the invoice to change it.');
  return s;
}

/** Nobody can be in two places at once: refuse time that overlaps the same person's other entries. */
async function assertNoOverlap(
  tx: Tx,
  userId: string,
  start: string,
  end: string,
  exceptId?: string,
) {
  const [clash] = await tx<{ number: string }[]>`
    SELECT j.number FROM timesheets t JOIN jobs j ON j.id = t.job_id
     WHERE t.user_id = ${userId} AND t.started_at < ${end} AND t.ended_at > ${start}
       AND (${exceptId ?? null}::uuid IS NULL OR t.id <> ${exceptId ?? null})
     LIMIT 1`;
  if (clash)
    throw invalid(`That overlaps time already logged on job ${clash.number}.`, {
      fields: { startedAt: 'Overlaps other time' },
    });
  // A running timer becomes a timesheet when it stops, so it counts from its start onwards.
  const [timer] = await tx<{ number: string }[]>`
    SELECT j.number FROM job_timers t JOIN jobs j ON j.id = t.job_id
     WHERE t.user_id = ${userId} AND t.stopped_at IS NULL AND t.started_at < ${end}
     LIMIT 1`;
  if (timer)
    throw invalid(
      `That overlaps a timer still running on job ${timer.number}. Stop it first, or log time before it started.`,
      { fields: { endedAt: 'Overlaps a running timer' } },
    );
}

function assertNotFuture(end: string) {
  if (Date.parse(end) > Date.now() + 5 * 60_000)
    throw invalid('Time can only be logged once it has happened.', {
      fields: { endedAt: 'In the future' },
    });
}

/** Time typed in by hand. Owner for anyone; everyone else for themselves. */
export async function addTimesheet(
  tx: Tx,
  auth: Auth,
  jobId: string,
  input: z.output<typeof timesheetCreate>,
) {
  assertCanRecord(auth);
  await lockJob(tx, jobId);
  const userId = input.userId ?? auth.userId;
  if (userId !== auth.userId && !isOwner(auth))
    throw new AppError(403, 'not_yours', 'You can only log your own time.');
  await assertMember(tx, auth, userId);
  assertNotFuture(input.endedAt);
  await assertNoOverlap(tx, userId, input.startedAt, input.endedAt);
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO timesheets (tenant_id, job_id, user_id, started_at, ended_at, source, note)
    VALUES (${auth.tenantId}, ${jobId}, ${userId}, ${input.startedAt}, ${input.endedAt}, 'manual',
            ${input.note ?? null})
    RETURNING id`;
  await audit(tx, auth, 'timesheet_add', 'job', jobId, { timesheetId: row!.id, userId });
  return getJob(tx, jobId, auth);
}

export async function updateTimesheet(
  tx: Tx,
  auth: Auth,
  id: string,
  input: z.output<typeof timesheetUpdate>,
) {
  assertCanRecord(auth);
  const s = await sheetForChange(tx, auth, id);
  const start = input.startedAt ?? isoNN(s.startedAt);
  const end = input.endedAt ?? isoNN(s.endedAt);
  const mins = (Date.parse(end) - Date.parse(start)) / 60_000;
  if (mins <= 0 || mins > 16 * 60)
    throw invalid('The end must be after the start, and no more than 16 hours later', {
      fields: { endedAt: 'Check the times' },
    });
  assertNotFuture(end);
  await assertNoOverlap(tx, s.userId, start, end, id);
  await tx`
    UPDATE timesheets
       SET started_at = ${start}, ended_at = ${end},
           note = ${input.note === undefined ? tx`note` : input.note},
           updated_by = ${auth.userId}, updated_at = now()
     WHERE id = ${id}`;
  await audit(tx, auth, 'timesheet_edit', 'job', s.jobId, {
    timesheetId: id,
    from: { startedAt: isoNN(s.startedAt), endedAt: isoNN(s.endedAt) },
    to: { startedAt: start, endedAt: end },
  });
  return getJob(tx, s.jobId, auth);
}

export async function deleteTimesheet(tx: Tx, auth: Auth, id: string) {
  assertCanRecord(auth);
  const s = await sheetForChange(tx, auth, id);
  await tx`DELETE FROM timesheets WHERE id = ${id}`;
  await audit(tx, auth, 'timesheet_delete', 'job', s.jobId, {
    timesheetId: id,
    userId: s.userId,
    startedAt: isoNN(s.startedAt),
    endedAt: isoNN(s.endedAt),
  });
  return getJob(tx, s.jobId, auth);
}

/* ----------------------- materials added by hand ----------------------- */

async function sellFor(tx: Tx, cost: number | null, sell: number | null) {
  if (sell !== null) return sell;
  if (cost !== null) return sellFromCost(cost, await defaultMarkup(tx));
  throw invalid('Enter what it cost or what to charge', {
    fields: { unitCostPence: 'Enter a cost or a price' },
  });
}

export async function addJobLine(
  tx: Tx,
  auth: Auth,
  jobId: string,
  input: z.output<typeof jobLineCreate>,
) {
  assertCanRecord(auth);
  await lockJob(tx, jobId);
  const sell = await sellFor(tx, input.unitCostPence, input.unitSellPence);
  const [pos] = await tx<{ next: number }[]>`
    SELECT coalesce(max(position) + 1, 0)::int AS next FROM job_lines WHERE job_id = ${jobId}`;
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO job_lines (tenant_id, job_id, position, kind, description, qty_milli, unit_cost_pence,
                           unit_sell_pence, total_pence, source)
    VALUES (${auth.tenantId}, ${jobId}, ${pos!.next}, ${input.kind}, ${input.description},
            ${input.qtyMilli}, ${input.unitCostPence}, ${sell}, ${signedLineTotal(input.qtyMilli, sell)},
            'manual')
    RETURNING id`;
  await audit(tx, auth, 'job_line_add', 'job', jobId, { lineId: row!.id });
  return getJob(tx, jobId, auth);
}

async function manualLine(tx: Tx, id: string) {
  const [l] = await tx<
    {
      jobId: string;
      source: string;
      invoiced: boolean;
      unitCostPence: string | null;
      unitSellPence: string;
      qtyMilli: string;
    }[]
  >`
    SELECT job_id, source, invoice_id IS NOT NULL AS invoiced, unit_cost_pence, unit_sell_pence, qty_milli
      FROM job_lines WHERE id = ${id} FOR UPDATE`;
  if (!l) throw notFound('Line');
  if (l.source !== 'manual')
    throw conflict(
      'not_manual',
      l.source === 'quote'
        ? 'Lines from the quote change through a new quote revision.'
        : 'Lines from a supplier bill change through the bill.',
    );
  if (l.invoiced)
    throw conflict('invoiced', 'This line is on an invoice. Credit the invoice to change it.');
  return l;
}

export async function updateJobLine(
  tx: Tx,
  auth: Auth,
  id: string,
  input: z.output<typeof jobLineUpdate>,
) {
  assertCanRecord(auth);
  const l = await manualLine(tx, id);
  const cost =
    input.unitCostPence !== undefined
      ? input.unitCostPence
      : l.unitCostPence === null
        ? null
        : Number(l.unitCostPence);
  // A changed cost with no explicit price re-derives the price from the markup.
  const sell =
    input.unitSellPence !== undefined
      ? await sellFor(tx, cost, input.unitSellPence)
      : input.unitCostPence !== undefined
        ? await sellFor(tx, cost, null)
        : Number(l.unitSellPence);
  const qty = input.qtyMilli ?? Number(l.qtyMilli);
  await tx`
    UPDATE job_lines
       SET description = coalesce(${input.description ?? null}, description),
           qty_milli = ${qty}, unit_cost_pence = ${cost}, unit_sell_pence = ${sell},
           total_pence = ${signedLineTotal(qty, sell)}
     WHERE id = ${id}`;
  await audit(tx, auth, 'job_line_edit', 'job', l.jobId, { lineId: id });
  return getJob(tx, l.jobId, auth);
}

export async function deleteJobLine(tx: Tx, auth: Auth, id: string) {
  assertCanRecord(auth);
  const l = await manualLine(tx, id);
  await tx`DELETE FROM job_lines WHERE id = ${id}`;
  await audit(tx, auth, 'job_line_delete', 'job', l.jobId, { lineId: id });
  return getJob(tx, l.jobId, auth);
}

/* --------------------------------- notes -------------------------------- */

/** Lists answer 404 for a job this business cannot see, like every other job route. */
async function assertJobVisible(tx: Tx, jobId: string) {
  const [j] = await tx`SELECT 1 FROM jobs WHERE id = ${jobId}`;
  if (!j) throw notFound('Job');
}

export async function listNotes(tx: Tx, jobId: string): Promise<JobNoteDto[]> {
  await assertJobVisible(tx, jobId);
  const rows = await tx<
    { id: string; userId: string; userName: string; body: string; createdAt: Date }[]
  >`
    SELECT n.id, n.user_id, u.name AS user_name, n.body, n.created_at
      FROM job_notes n JOIN users u ON u.id = n.user_id
     WHERE n.job_id = ${jobId} ORDER BY n.created_at DESC`;
  return rows.map((r) => ({ ...r, createdAt: isoNN(r.createdAt) }));
}

export async function addNote(
  tx: Tx,
  auth: Auth,
  jobId: string,
  input: z.output<typeof jobNoteCreate>,
) {
  assertCanRecord(auth);
  await lockJob(tx, jobId);
  await tx`INSERT INTO job_notes (tenant_id, job_id, user_id, body)
           VALUES (${auth.tenantId}, ${jobId}, ${auth.userId}, ${input.body})`;
  await audit(tx, auth, 'note_add', 'job', jobId, {});
  return listNotes(tx, jobId);
}

export async function deleteNote(tx: Tx, auth: Auth, id: string) {
  assertCanRecord(auth);
  const [n] = await tx<{ jobId: string; userId: string }[]>`
    SELECT job_id, user_id FROM job_notes WHERE id = ${id} FOR UPDATE`;
  if (!n) throw notFound('Note');
  if (!isOwner(auth) && n.userId !== auth.userId)
    throw new AppError(403, 'not_yours', 'You can only delete your own notes.');
  await tx`DELETE FROM job_notes WHERE id = ${id}`;
  await audit(tx, auth, 'note_delete', 'job', n.jobId, { noteId: id });
  return listNotes(tx, n.jobId);
}

/* -------------------------------- photos -------------------------------- */

export async function listPhotos(tx: Tx, jobId: string): Promise<JobPhotoDto[]> {
  await assertJobVisible(tx, jobId);
  const rows = await tx<
    {
      id: string;
      contentType: string;
      bytes: number;
      width: number | null;
      height: number | null;
      caption: string | null;
      userName: string;
      createdAt: Date;
    }[]
  >`
    SELECT p.id, p.content_type, p.bytes, p.width, p.height, p.caption, u.name AS user_name, p.created_at
      FROM job_photos p JOIN users u ON u.id = p.user_id
     WHERE p.job_id = ${jobId} ORDER BY p.created_at DESC`;
  return rows.map((r) => ({
    ...r,
    url: `/api/photos/${r.id}`,
    createdAt: isoNN(r.createdAt),
  }));
}

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as const;

export async function addPhoto(
  tx: Tx,
  auth: Auth,
  blobs: BlobStore,
  jobId: string,
  input: z.output<typeof photoUpload>,
) {
  assertCanRecord(auth);
  await lockJob(tx, jobId);
  const { type, bytes } = dataUrlBytes(input.dataUrl);
  const real = sniffImage(bytes);
  if (!real || real !== type)
    throw invalid('That file is not a JPEG, PNG or WebP photo.', {
      fields: { dataUrl: 'Not a photo' },
    });
  if (bytes.length > 3_000_000)
    throw invalid('That photo is too big (3 MB at most).', { fields: { dataUrl: 'Too big' } });
  const id = crypto.randomUUID();
  const key = `${auth.tenantId}/jobs/${jobId}/${id}.${EXT[real]}`;
  try {
    await blobs.put(key, bytes, real);
  } catch (e) {
    if (e instanceof BlobsNotConfigured)
      throw new AppError(503, 'storage_not_configured', 'Photo storage is not set up yet.');
    throw e;
  }
  await tx`
    INSERT INTO job_photos (id, tenant_id, job_id, user_id, storage_key, content_type, bytes, width, height, caption)
    VALUES (${id}, ${auth.tenantId}, ${jobId}, ${auth.userId}, ${key}, ${real}, ${bytes.length},
            ${input.width ?? null}, ${input.height ?? null}, ${input.caption ?? null})`;
  await audit(tx, auth, 'photo_add', 'job', jobId, { photoId: id, bytes: bytes.length });
  return listPhotos(tx, jobId);
}

/** RLS scopes the lookup to this business, so another tenant's photo id is simply not found. */
export async function photoFile(tx: Tx, blobs: BlobStore, id: string) {
  const [p] = await tx<{ storageKey: string; contentType: string }[]>`
    SELECT storage_key, content_type FROM job_photos WHERE id = ${id}`;
  if (!p) throw notFound('Photo');
  const blob = await blobs.get(p.storageKey);
  if (!blob) throw notFound('Photo file');
  return { bytes: blob.bytes, contentType: p.contentType };
}

export async function deletePhoto(tx: Tx, auth: Auth, blobs: BlobStore, id: string) {
  assertCanRecord(auth);
  const [p] = await tx<{ jobId: string; userId: string; storageKey: string }[]>`
    SELECT job_id, user_id, storage_key FROM job_photos WHERE id = ${id} FOR UPDATE`;
  if (!p) throw notFound('Photo');
  if (!isOwner(auth) && p.userId !== auth.userId)
    throw new AppError(403, 'not_yours', 'You can only delete your own photos.');
  await tx`DELETE FROM job_photos WHERE id = ${id}`;
  await audit(tx, auth, 'photo_delete', 'job', p.jobId, { photoId: id });
  // The row is gone first; a failed file delete only leaves an orphan, never a broken photo.
  await blobs.delete(p.storageKey).catch(() => undefined);
  return listPhotos(tx, p.jobId);
}
