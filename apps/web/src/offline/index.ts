import type { JobDetailDto, JobSummaryDto, Page, QuoteDetailDto } from '@lse/shared';
import type { QueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { api, ApiError } from '../api/client';
import type { Fields } from './fields';
import { idbOutboxStorage, openOfflineDb } from './idb';
import { Outbox, type SyncSnapshot } from './outbox';

export type SaveResult = 'synced' | 'queued';

let outbox: Outbox | null = null;
let qcRef: QueryClient | null = null;

/** Wires the outbox to the API and the query cache. Called once from main.tsx. */
export function initOffline(qc: QueryClient) {
  qcRef = qc;
  outbox = new Outbox(
    idbOutboxStorage(() => openOfflineDb()),
    {
      send: (op) =>
        op.kind === 'action'
          ? api<{ version: number }>('POST', op.path, op.changes, { idempotencyKey: op.id })
          : api<{ version: number }>('PATCH', op.path, op.changes, {
              ifMatch: op.baseVersion,
              idempotencyKey: op.id,
            }),
      tenantId: () =>
        qc.getQueryData<{ tenantId: string | null } | null>(['session'])?.tenantId ?? null,
      onRecord: (entity, id, record) => {
        if (id.startsWith('new:')) {
          // A record created offline has now been made on the server: show it in its list.
          void qc.invalidateQueries({ queryKey: [`${entity}s`] });
          return;
        }
        qc.setQueryData([entity, id], record);
        void qc.invalidateQueries({ queryKey: [entity === 'job' ? 'jobs' : 'quotes'] });
        if (entity === 'job') {
          void qc.invalidateQueries({ queryKey: ['timer'] });
          void qc.invalidateQueries({ queryKey: ['appointments'] });
        }
      },
    },
  );
  const kick = () => void outbox?.flush();
  window.addEventListener('online', kick);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') kick();
  });
  // Gentle retry while anything is waiting (e.g. server trouble or a flaky signal).
  setInterval(() => {
    if (outbox && outbox.getSnapshot().pending > 0 && navigator.onLine) kick();
  }, 30_000);
  void outbox.load().then(kick);
  return outbox;
}

/**
 * After the cached data is restored from the device, refresh what's on screen, unless edits are
 * still waiting to sync (then the outbox refreshes each record as it's delivered, and a refetch
 * now would briefly show the server's older values over the person's own changes).
 */
export async function afterRestore(qc: QueryClient) {
  if (!outbox) return;
  await outbox.load();
  if (outbox.getSnapshot().ops.length === 0) await qc.invalidateQueries();
}

export const getOutbox = () => {
  if (!outbox) throw new Error('initOffline() was not called');
  return outbox;
};

const EMPTY: SyncSnapshot = {
  pending: 0,
  needsAttention: 0,
  syncing: false,
  lastSyncedAt: null,
  stalled: null,
  ops: [],
};
export function useSync(): SyncSnapshot {
  return useSyncExternalStore(
    (cb) => outbox?.subscribe(cb) ?? (() => {}),
    () => outbox?.getSnapshot() ?? EMPTY,
    () => EMPTY,
  );
}

/** Thrown when the edit is on the device but the server won't take it as it is. */
export class NeedsAttentionError extends Error {}

/**
 * Saves an edit through the outbox: on the device first, then to the server if we can.
 * Resolves 'synced' (server confirmed) or 'queued' (safely on this device, will sync).
 */
async function save(
  entity: 'job' | 'quote',
  id: string,
  label: string,
  changes: Fields,
  record: { version: number },
): Promise<SaveResult> {
  const box = getOutbox();
  const op = await box.enqueue({
    entity,
    entityId: id,
    label,
    path: `/${entity}s/${id}`,
    changes,
    record,
    version: record.version,
  });
  await box.flush();
  const still = box.getSnapshot().ops.find((o) => o.id === op.id);
  if (!still) return 'synced';
  if (still.status === 'pending') return 'queued';
  throw new NeedsAttentionError(
    still.status === 'conflict'
      ? `${label} was changed on another device too. Choose which version to keep.`
      : `${label} couldn’t be saved: ${still.error ?? 'the server refused it'}`,
  );
}

/**
 * Timer start/stop through the outbox: recorded on the device with the time it happened, then sent.
 * Resolves 'synced' or 'queued'; throws NeedsAttentionError if the server refused it.
 */
export async function timerAction(
  job: { id: string; number: string },
  action: 'start' | 'stop',
  opts: { switch?: boolean; at?: Date } = {},
): Promise<SaveResult> {
  const box = getOutbox();
  const label = `Job ${job.number}`;
  const op = await box.enqueueAction({
    entity: 'job',
    entityId: job.id,
    label,
    path: `/jobs/${job.id}/timer/${action}`,
    body: {
      at: (opts.at ?? new Date()).toISOString(),
      ...(opts.switch ? { switch: true } : {}),
    },
  });
  await box.flush();
  const still = box.getSnapshot().ops.find((o) => o.id === op.id);
  if (!still) return 'synced';
  if (still.status === 'pending') return 'queued';
  throw new NeedsAttentionError(
    `${label}: timer not ${action === 'start' ? 'started' : 'stopped'}. ${still.error ?? ''}`.trim(),
  );
}

/** Latest copy we have of a job: the detail if cached, otherwise its row in any loaded list. */
function cachedJob(id: string): (JobSummaryDto & Partial<JobDetailDto>) | undefined {
  const qc = qcRef!;
  const detail = qc.getQueryData<JobDetailDto>(['job', id]);
  if (detail) return detail;
  for (const [, page] of qc.getQueriesData<Page<JobSummaryDto>>({ queryKey: ['jobs'] })) {
    const row = page?.items.find((j) => j.id === id);
    if (row) return row;
  }
  return undefined;
}

/**
 * @param showLocally applies the change to the screen. Called AFTER we've read the record as the
 * person saw it, so the conflict base is the old value, not our own optimistic one.
 */
export async function saveJob(
  id: string,
  changes: Fields,
  showLocally?: () => void,
): Promise<SaveResult> {
  const job = cachedJob(id);
  const before = job ? structuredClone(job) : undefined;
  showLocally?.();
  if (!before) {
    // Never seen on this device: needs a connection.
    await api('PATCH', `/jobs/${id}`, changes);
    return 'synced';
  }
  return save('job', id, `Job ${before.number}`, changes, before);
}

export async function saveQuote(id: string, changes: Fields): Promise<SaveResult> {
  const q = qcRef!.getQueryData<QuoteDetailDto>(['quote', id]);
  if (!q) {
    await api('PATCH', `/quotes/${id}`, changes);
    return 'synced';
  }
  return save('quote', id, q.number, changes, q);
}

export type CreateResult<T> = { status: 'created'; record: T } | { status: 'queued' };

/**
 * Creates a customer, quote or job. With signal it is made at once. With no connection it is saved
 * on this device and made when the signal returns, under the SAME Idempotency-Key, so if the first
 * try did reach the server, the replay returns that record instead of making a second one.
 * Anything the server refuses (e.g. a missing name) is thrown as usual and nothing is queued.
 */
export async function createOrQueue<T>(
  entity: 'customer' | 'quote' | 'job',
  body: object,
  label: string,
): Promise<CreateResult<T>> {
  const key = crypto.randomUUID();
  const path = `/${entity}s`;
  try {
    return { status: 'created', record: await api<T>('POST', path, body, { idempotencyKey: key }) };
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 0) throw e;
  }
  const box = getOutbox();
  await box.enqueueAction({
    id: key,
    entity,
    entityId: `new:${key}`,
    label,
    path,
    body: { ...body },
  });
  return { status: 'queued' };
}
