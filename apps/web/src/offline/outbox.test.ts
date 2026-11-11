import 'fake-indexeddb/auto';
import type { JobDetailDto } from '@lse/shared';
import { describe, expect, it, vi } from 'vitest';
import { idbOutboxStorage, openOfflineDb } from './idb';
import { Outbox, type OutboxOp, type SendError } from './outbox';

let dbCount = 0;
const stg = (id: string) =>
  ({ id, systemKey: null, name: id, colour: 'grey', isActive: true }) as const;
const job = (over: Partial<JobDetailDto> = {}) =>
  ({
    id: 'job-1',
    number: '123',
    title: 'Fuse board',
    description: null,
    stage: stg('open'),
    placeOfWork: 'sark',
    siteId: 'site-1',
    version: 1,
    ...over,
  }) as unknown as JobDetailDto;

const httpError = (status: number, code: string, message = code, details?: unknown): SendError => ({
  status,
  code,
  message,
  details,
});

function setup(send: (op: OutboxOp) => Promise<{ version: number }>, name = `t${++dbCount}`) {
  const storage = idbOutboxStorage(() => openOfflineDb(name));
  const onRecord = vi.fn();
  let tenant = 'tenant-a';
  const make = () => new Outbox(storage, { send: vi.fn(send), tenantId: () => tenant, onRecord });
  const outbox = make();
  return { outbox, make, storage, onRecord, setTenant: (t: string) => (tenant = t) };
}

const edit = (o: Outbox, changes: Record<string, unknown>, record = job()) =>
  o.enqueue({
    entity: 'job',
    entityId: record.id,
    label: 'Job 123',
    path: `/jobs/${record.id}`,
    changes,
    record,
    version: record.version,
  });

describe('outbox: saved on the device first', () => {
  it('keeps edits across a reload / app kill and sends them later', async () => {
    const offline = () => Promise.reject(httpError(0, 'network'));
    const { outbox, make, storage } = setup(offline);
    await edit(outbox, { stageId: 'completed' });
    await outbox.flush();
    expect(outbox.getSnapshot()).toMatchObject({ pending: 1, stalled: 'offline' });

    // "Kill" the app: a brand-new Outbox reading the same IndexedDB.
    const sent: OutboxOp[] = [];
    const revived = new Outbox(storage, {
      send: async (op) => {
        sent.push(op);
        return { version: 2 };
      },
      tenantId: () => 'tenant-a',
    });
    await revived.load();
    expect(revived.getSnapshot().pending).toBe(1);
    await revived.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ changes: { stageId: 'completed' }, baseVersion: 1 });
    expect(revived.getSnapshot().pending).toBe(0);
    expect((await storage.all()).length).toBe(0);
    void make;
  });

  it('merges several offline edits to one record into one request (latest value wins)', async () => {
    const calls: OutboxOp[] = [];
    let online = false;
    const { outbox } = setup(async (op) => {
      if (!online) throw httpError(0, 'network');
      calls.push(structuredClone(op));
      return { version: 2 };
    });
    await edit(outbox, { stageId: 'scheduled' });
    await edit(outbox, { stageId: 'in_progress' }, job({ stage: stg('scheduled') }));
    await edit(outbox, { title: 'Fuse board + RCD' }, job({ stage: stg('in_progress') }));
    expect(outbox.getSnapshot().pending).toBe(1);
    online = true;
    await outbox.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.changes).toEqual({ stageId: 'in_progress', title: 'Fuse board + RCD' });
    // The base is what the record looked like before the FIRST edit.
    expect(calls[0]!.base).toEqual({ stageId: 'open', title: 'Fuse board' });
  });

  it('sends in order and stops at the first network failure', async () => {
    const order: string[] = [];
    let failOn = 'job-2';
    const { outbox } = setup(async (op) => {
      if (op.entityId === failOn) throw httpError(0, 'network');
      order.push(op.entityId);
      return { version: 2 };
    });
    await edit(outbox, { stageId: 'completed' }, job({ id: 'job-1' }));
    await edit(outbox, { stageId: 'completed' }, job({ id: 'job-2' }));
    await edit(outbox, { stageId: 'completed' }, job({ id: 'job-3' }));
    await outbox.flush();
    expect(order).toEqual(['job-1']);
    failOn = '';
    await outbox.flush();
    expect(order).toEqual(['job-1', 'job-2', 'job-3']);
  });

  it('keeps edits pending on server errors and sign-out, counting attempts', async () => {
    let status = 503;
    const { outbox } = setup(async () => {
      throw httpError(status, 'x');
    });
    await edit(outbox, { stageId: 'completed' });
    await outbox.flush();
    expect(outbox.getSnapshot()).toMatchObject({ pending: 1, stalled: 'server' });
    expect(outbox.getSnapshot().ops[0]!.attempts).toBe(1);
    status = 401;
    await outbox.flush();
    expect(outbox.getSnapshot()).toMatchObject({ pending: 1, stalled: 'signed_out' });
  });

  it('only sends the signed-in business’s edits', async () => {
    const sent: string[] = [];
    const { outbox, setTenant } = setup(async (op) => {
      sent.push(op.tenantId);
      return { version: 2 };
    });
    setTenant('tenant-a');
    await outbox.load();
    // queue for A while offline-ish: enqueue then switch business before flushing
    await edit(outbox, { stageId: 'completed' });
    setTenant('tenant-b');
    await outbox.flush();
    expect(sent).toEqual([]);
    expect(outbox.getSnapshot().pending).toBe(0); // B sees none of A's edits
    setTenant('tenant-a');
    await outbox.flush();
    expect(sent).toEqual(['tenant-a']);
  });

  it('confirms with the server record so the screen shows the real saved state', async () => {
    const { outbox, onRecord } = setup(async () => ({ version: 2, stageId: 'completed' }) as never);
    await edit(outbox, { stageId: 'completed' });
    await outbox.flush();
    expect(onRecord).toHaveBeenCalledWith('job', 'job-1', { version: 2, stageId: 'completed' });
  });
});

describe('outbox: conflict rules', () => {
  const conflict = (current: JobDetailDto) =>
    httpError(409, 'version_conflict', 'changed', { current, currentVersion: current.version });

  it('rule 2: someone changed a different field → re-sent automatically on the new version', async () => {
    const seen: OutboxOp[] = [];
    const server = job({ title: 'Renamed on laptop', version: 2 });
    const { outbox } = setup(async (op) => {
      seen.push(structuredClone(op));
      if (op.baseVersion !== server.version) throw conflict(server);
      return { version: 3 };
    });
    await edit(outbox, { stageId: 'completed' });
    await outbox.flush();
    expect(seen.map((o) => o.baseVersion)).toEqual([1, 2]);
    expect(outbox.getSnapshot().ops).toHaveLength(0);
  });

  it('rule 3: server already has my value → treated as saved', async () => {
    const server = job({ stage: stg('completed'), version: 4 });
    let n = 0;
    const { outbox } = setup(async (op) => {
      n++;
      if (op.baseVersion !== 4) throw conflict(server);
      return { version: 5 };
    });
    await edit(outbox, { stageId: 'completed' });
    await outbox.flush();
    expect(n).toBe(2);
    expect(outbox.getSnapshot().needsAttention).toBe(0);
  });

  it('rule 4: same field changed on both sides → asks; "Keep mine" re-sends, "Use theirs" drops', async () => {
    const server = job({ stage: stg('cancelled'), version: 2 });
    const sends: OutboxOp[] = [];
    const { outbox, onRecord } = setup(async (op) => {
      sends.push(structuredClone(op));
      if (op.baseVersion !== 2) throw conflict(server);
      return { version: 3 };
    });
    await edit(outbox, { stageId: 'completed' });
    await outbox.flush();
    const snap = outbox.getSnapshot();
    expect(snap.needsAttention).toBe(1);
    expect(snap.ops[0]!.conflict).toMatchObject({
      fields: ['stageId'],
      server: { stageId: 'cancelled' },
    });

    await outbox.keepMine(snap.ops[0]!.id);
    expect(sends.at(-1)).toMatchObject({ baseVersion: 2, changes: { stageId: 'completed' } });
    expect(outbox.getSnapshot().ops).toHaveLength(0);

    // Use theirs
    await edit(outbox, { stageId: 'completed' });
    await outbox.flush(); // baseVersion 1 -> conflict again
    const op = outbox.getSnapshot().ops[0]!;
    expect(op.status).toBe('conflict');
    await outbox.discard(op.id);
    expect(outbox.getSnapshot().ops).toHaveLength(0);
    expect(onRecord).toHaveBeenLastCalledWith('job', 'job-1', server);
  });

  it('rule 5: business refusal (quote sent elsewhere) → "Couldn’t save" with the reason, never dropped', async () => {
    const { outbox } = setup(async () => {
      throw httpError(
        409,
        'quote_locked',
        'This quote has been sent. Make a new revision to change it.',
      );
    });
    await edit(outbox, { title: 'x' });
    await outbox.flush();
    const op = outbox.getSnapshot().ops[0]!;
    expect(op).toMatchObject({
      status: 'failed',
      error: 'This quote has been sent. Make a new revision to change it.',
    });
    // Still on the device until the person decides.
    await outbox.flush();
    expect(outbox.getSnapshot().ops).toHaveLength(1);
  });

  it('a record with an unresolved problem holds back later edits to it, but not to others', async () => {
    const sent: string[] = [];
    const { outbox } = setup(async (op) => {
      if (op.entityId === 'job-1' && op.changes.stageId === 'completed')
        throw httpError(422, 'validation_failed', 'bad');
      sent.push(`${op.entityId}:${JSON.stringify(op.changes)}`);
      return { version: 9 };
    });
    await edit(outbox, { stageId: 'completed' }, job({ id: 'job-1' }));
    await outbox.flush();
    await edit(outbox, { title: 'later' }, job({ id: 'job-1' }));
    await edit(outbox, { title: 'other' }, job({ id: 'job-2' }));
    await outbox.flush();
    expect(sent).toEqual(['job-2:{"title":"other"}']);
  });
});

describe('outbox: actions (timer start/stop)', () => {
  it('are kept in order, never merged, and an edit after an action is sent after it', async () => {
    let online = false;
    const calls: string[] = [];
    const { outbox } = setup(async (op) => {
      if (!online) throw httpError(0, 'network');
      calls.push(`${op.kind ?? 'edit'}:${op.path}:${JSON.stringify(op.changes)}`);
      return { version: 2 };
    });
    await edit(outbox, { title: 'Before' });
    await outbox.enqueueAction({
      entity: 'job',
      entityId: 'job-1',
      label: 'Job 123',
      path: '/jobs/job-1/timer/start',
      body: { at: 'T1' },
    });
    await edit(outbox, { title: 'After' });
    await outbox.enqueueAction({
      entity: 'job',
      entityId: 'job-1',
      label: 'Job 123',
      path: '/jobs/job-1/timer/stop',
      body: { at: 'T2' },
    });
    expect(outbox.getSnapshot().pending).toBe(4);
    online = true;
    await outbox.flush();
    expect(calls).toEqual([
      'edit:/jobs/job-1:{"title":"Before"}',
      'action:/jobs/job-1/timer/start:{"at":"T1"}',
      'edit:/jobs/job-1:{"title":"After"}',
      'action:/jobs/job-1/timer/stop:{"at":"T2"}',
    ]);
  });

  it('survive the app being killed, and a refusal is kept for the person to see', async () => {
    const name = `t${++dbCount}`;
    const first = setup(async () => {
      throw httpError(0, 'network');
    }, name);
    await first.outbox.enqueueAction({
      entity: 'job',
      entityId: 'job-1',
      label: 'Job 123',
      path: '/jobs/job-1/timer/start',
      body: { at: 'T1' },
    });
    // "Restart": a new outbox over the same device storage.
    const second = setup(async () => {
      throw httpError(409, 'timer_running', 'Your timer is running on job 124. Stop it first.');
    }, name);
    await second.outbox.flush();
    const [op] = second.outbox.getSnapshot().ops;
    expect(op).toMatchObject({
      kind: 'action',
      status: 'failed',
      error: 'Your timer is running on job 124. Stop it first.',
    });
  });
});
