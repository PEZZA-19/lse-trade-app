import {
  dataUrlBytes,
  jobLineCreate,
  jobLineUpdate,
  jobNoteCreate,
  photoUpload,
  sellFromCost,
  signedLineTotal,
  timesheetCreate,
  timesheetUpdate,
  type JobLineDto,
  type JobNoteDto,
  type JobPhotoDto,
} from '@lse/shared';
import type { z } from 'zod';

export interface DemoNote {
  id: string;
  jobId: string;
  userId: string;
  body: string;
  createdAt: string;
}
export interface DemoPhoto {
  id: string;
  jobId: string;
  userId: string;
  /** The demo keeps the resized photo itself (there is no file store in the preview). */
  dataUrl: string;
  bytes: number;
  width: number | null;
  height: number | null;
  caption: string | null;
  createdAt: string;
}
export interface JobDetailDb {
  notes: DemoNote[];
  photos: DemoPhoto[];
}
export const freshJobDetail = (): JobDetailDb => ({ notes: [], photos: [] });

interface Sheet {
  id: string;
  jobId: string;
  startedAt: string;
  endedAt: string;
  userId?: string;
  source?: 'timer' | 'manual';
  note?: string | null;
  invoiced?: boolean;
}

export interface JobDetailCtx {
  db: JobDetailDb;
  timesheets: Sheet[];
  /** The demo user's own timers (the demo has one person timing). */
  timers?: { jobId: string; startedAt: string; stoppedAt: string | null }[];
  jobs: { id: string; number: string; lines: JobLineDto[] }[];
  members: { userId: string; name: string }[];
  userId: string;
  markupBp: number;
  parse: <S extends z.ZodType>(schema: S, data: unknown) => z.output<S>;
  fail: (status: number, code: string, message: string, details?: unknown) => never;
  uid: () => string;
  now: () => string;
  jobDetail: (jobId: string) => unknown;
}

const name = (c: JobDetailCtx, id: string) =>
  c.members.find((m) => m.userId === id)?.name ?? 'Someone';

export function notesFor(c: JobDetailCtx, jobId: string): JobNoteDto[] {
  return c.db.notes
    .filter((n) => n.jobId === jobId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(({ jobId: _j, ...n }) => ({ ...n, userName: name(c, n.userId) }));
}
export function photosFor(c: JobDetailCtx, jobId: string): JobPhotoDto[] {
  return c.db.photos
    .filter((p) => p.jobId === jobId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((p) => ({
      id: p.id,
      url: p.dataUrl,
      contentType: 'image/jpeg',
      bytes: p.bytes,
      width: p.width,
      height: p.height,
      caption: p.caption,
      userName: name(c, p.userId),
      createdAt: p.createdAt,
    }));
}

function noOverlap(c: JobDetailCtx, userId: string, s: string, e: string, except?: string) {
  const clash = c.timesheets.find(
    (t) => t.id !== except && (t.userId ?? c.userId) === userId && t.startedAt < e && t.endedAt > s,
  );
  if (clash) {
    const n = c.jobs.find((j) => j.id === clash.jobId)?.number ?? '?';
    c.fail(422, 'validation_failed', `That overlaps time already logged on job ${n}.`, {
      fields: { startedAt: 'Overlaps other time' },
    });
  }
  const running =
    userId === c.userId ? c.timers?.find((t) => !t.stoppedAt && t.startedAt < e) : undefined;
  if (running) {
    const n = c.jobs.find((j) => j.id === running.jobId)?.number ?? '?';
    c.fail(
      422,
      'validation_failed',
      `That overlaps a timer still running on job ${n}. Stop it first, or log time before it started.`,
      { fields: { endedAt: 'Overlaps a running timer' } },
    );
  }
}
const notFuture = (c: JobDetailCtx, e: string) => {
  if (Date.parse(e) > Date.now() + 5 * 60_000)
    c.fail(422, 'validation_failed', 'Time can only be logged once it has happened.');
};
const iso = (s: string) => new Date(s).toISOString();

/** Same rules as the server's job detail routes (the demo user is the owner). */
export function jobDetailRoute(
  c: JobDetailCtx,
  method: string,
  seg: string[],
  body: unknown,
): unknown {
  const [a, id, sub] = seg;
  const job = (jid: string) =>
    c.jobs.find((j) => j.id === jid) ?? c.fail(404, 'not_found', 'Job not found');

  if (a === 'jobs' && id) {
    if (sub === 'timesheets' && method === 'POST') {
      job(id);
      const p = c.parse(timesheetCreate, body);
      const userId = p.userId ?? c.userId;
      if (!c.members.some((m) => m.userId === userId))
        c.fail(422, 'validation_failed', 'That person is not part of this business');
      const s = iso(p.startedAt);
      const e = iso(p.endedAt);
      notFuture(c, e);
      noOverlap(c, userId, s, e);
      c.timesheets.push({
        id: c.uid(),
        jobId: id,
        startedAt: s,
        endedAt: e,
        userId,
        source: 'manual',
        note: p.note ?? null,
      });
      return c.jobDetail(id);
    }
    if (sub === 'lines' && method === 'POST') {
      const j = job(id);
      const p = c.parse(jobLineCreate, body);
      const sell =
        p.unitSellPence ??
        (p.unitCostPence !== null
          ? sellFromCost(p.unitCostPence, c.markupBp)
          : c.fail(422, 'validation_failed', 'Enter what it cost or what to charge'));
      j.lines.push({
        id: c.uid(),
        position: j.lines.reduce((m, l) => Math.max(m, l.position + 1), 0),
        kind: p.kind,
        description: p.description,
        qtyMilli: p.qtyMilli,
        unitCostPence: p.unitCostPence,
        unitSellPence: sell,
        totalPence: signedLineTotal(p.qtyMilli, sell),
        source: 'manual',
        invoiced: false,
      } as JobLineDto);
      return c.jobDetail(id);
    }
    if (sub === 'notes') {
      job(id);
      if (method === 'GET') return notesFor(c, id);
      if (method === 'POST') {
        const p = c.parse(jobNoteCreate, body);
        c.db.notes.push({
          id: c.uid(),
          jobId: id,
          userId: c.userId,
          body: p.body,
          createdAt: c.now(),
        });
        return notesFor(c, id);
      }
    }
    if (sub === 'photos') {
      job(id);
      if (method === 'GET') return photosFor(c, id);
      if (method === 'POST') {
        const p = c.parse(photoUpload, body);
        // The preview keeps photos in this browser's storage (about 5 MB in total).
        const used = c.db.photos.reduce((n, x) => n + x.dataUrl.length, 0);
        if (used + p.dataUrl.length > 3_000_000)
          c.fail(
            422,
            'validation_failed',
            'The preview can only keep a few photos on this device. Delete one first.',
          );
        const { bytes } = dataUrlBytes(p.dataUrl);
        c.db.photos.push({
          id: c.uid(),
          jobId: id,
          userId: c.userId,
          dataUrl: p.dataUrl,
          bytes: bytes.length,
          width: p.width ?? null,
          height: p.height ?? null,
          caption: p.caption ?? null,
          createdAt: c.now(),
        });
        return photosFor(c, id);
      }
    }
    return undefined;
  }

  if (a === 'timesheets' && id) {
    const t =
      c.timesheets.find((x) => x.id === id) ?? c.fail(404, 'not_found', 'Time entry not found');
    if (t.invoiced)
      c.fail(409, 'invoiced', 'This time is on an invoice. Credit the invoice to change it.');
    if (method === 'DELETE') {
      c.timesheets.splice(c.timesheets.indexOf(t), 1);
      return c.jobDetail(t.jobId);
    }
    if (method === 'PATCH') {
      const p = c.parse(timesheetUpdate, body);
      const s = p.startedAt ? iso(p.startedAt) : t.startedAt;
      const e = p.endedAt ? iso(p.endedAt) : t.endedAt;
      const mins = (Date.parse(e) - Date.parse(s)) / 60_000;
      if (mins <= 0 || mins > 16 * 60)
        c.fail(
          422,
          'validation_failed',
          'The end must be after the start, and no more than 16 hours later',
        );
      notFuture(c, e);
      noOverlap(c, t.userId ?? c.userId, s, e, t.id);
      Object.assign(t, {
        startedAt: s,
        endedAt: e,
        ...(p.note !== undefined ? { note: p.note } : {}),
      });
      return c.jobDetail(t.jobId);
    }
  }

  if (a === 'job-lines' && id) {
    const j =
      c.jobs.find((x) => x.lines.some((l) => l.id === id)) ??
      c.fail(404, 'not_found', 'Line not found');
    const l = j.lines.find((x) => x.id === id)!;
    if (l.source !== 'manual')
      c.fail(
        409,
        'not_manual',
        l.source === 'quote'
          ? 'Lines from the quote change through a new quote revision.'
          : 'Lines from a supplier bill change through the bill.',
      );
    if (l.invoiced)
      c.fail(409, 'invoiced', 'This line is on an invoice. Credit the invoice to change it.');
    if (method === 'DELETE') {
      j.lines.splice(j.lines.indexOf(l), 1);
      return c.jobDetail(j.id);
    }
    if (method === 'PATCH') {
      const p = c.parse(jobLineUpdate, body);
      const cost = p.unitCostPence !== undefined ? p.unitCostPence : l.unitCostPence;
      const sell =
        p.unitSellPence ??
        (p.unitCostPence !== undefined || p.unitSellPence === null
          ? cost !== null
            ? sellFromCost(cost, c.markupBp)
            : c.fail(422, 'validation_failed', 'Enter what it cost or what to charge')
          : l.unitSellPence);
      const qty = p.qtyMilli ?? l.qtyMilli;
      Object.assign(l, {
        description: p.description ?? l.description,
        qtyMilli: qty,
        unitCostPence: cost,
        unitSellPence: sell,
        totalPence: signedLineTotal(qty, sell),
      });
      return c.jobDetail(j.id);
    }
  }

  if (a === 'notes' && id && method === 'DELETE') {
    const n = c.db.notes.find((x) => x.id === id) ?? c.fail(404, 'not_found', 'Note not found');
    c.db.notes.splice(c.db.notes.indexOf(n), 1);
    return notesFor(c, n.jobId);
  }
  if (a === 'photos' && id && method === 'DELETE') {
    const p = c.db.photos.find((x) => x.id === id) ?? c.fail(404, 'not_found', 'Photo not found');
    c.db.photos.splice(c.db.photos.indexOf(p), 1);
    return photosFor(c, p.jobId);
  }
  return undefined;
}
