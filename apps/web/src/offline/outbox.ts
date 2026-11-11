/**
 * The outbox: every offline-capable edit is written here (on the device) FIRST, then sent.
 *
 * Guarantees
 * - Saved on the device before we say anything is saved; survives reloads and the app being killed.
 * - Sent in order, one at a time, each with an idempotency key and the row version it was made from.
 * - Nothing is ever silently dropped: an edit leaves the outbox only when the server confirmed it,
 *   or when the person chose to discard it.
 *
 * Conflict rules (server answers 409 version_conflict with its current record)
 * 1. Fields this edit didn't touch never conflict: the server keeps its newer values.
 * 2. If none of the fields we changed were changed on the server since we started → re-send on top
 *    of the new version automatically ("rebase").
 * 3. If the server already has exactly our value → nothing to do.
 * 4. If the same field was changed on both sides → stop and ask: "Keep mine" or "Use theirs".
 * 5. If the server refuses for a business reason (e.g. the quote was sent from another device, so it
 *    is locked) → mark it "Couldn't save" with the server's message; the person decides.
 * Network errors, 5xx and 401 keep the edit pending and stop the run; it retries later.
 *
 * Actions (kind 'action', e.g. timer start/stop) are POSTs that happened at a moment: they are never
 * merged, carry no row version (so never conflict), are sent in order with everything else, and are
 * replay-safe through their idempotency key. A refusal (e.g. "timer running on job 124") is rule 5.
 */
import { editableFields, sameValue, type Entity, type Fields } from './fields';

export type OpStatus = 'pending' | 'conflict' | 'failed';

export interface OutboxOp {
  /** Also used as the Idempotency-Key. */
  id: string;
  /** 'edit' (PATCH, merged, If-Match) is the default; 'action' is a one-off POST. */
  kind?: 'edit' | 'action';
  seq: number;
  tenantId: string;
  entity: Entity;
  entityId: string;
  /** Short human label, e.g. "Job 123" or "Q-0004". */
  label: string;
  path: string;
  changes: Fields;
  /** Values of the changed fields as they were when the edit was made. */
  base: Fields;
  baseVersion: number;
  status: OpStatus;
  attempts: number;
  error?: string;
  conflict?: { fields: string[]; server: Fields; serverVersion: number; record: unknown };
  createdAt: string;
  updatedAt: string;
}

export interface OutboxStorage {
  all(): Promise<OutboxOp[]>;
  put(op: OutboxOp): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface SendError {
  status: number;
  code: string;
  message: string;
  details?: unknown;
}
export type Sender = (op: OutboxOp) => Promise<{ version: number }>;

export interface SyncSnapshot {
  pending: number;
  needsAttention: number;
  syncing: boolean;
  lastSyncedAt: string | null;
  /** Why the last run stopped early (offline, server trouble), if it did. */
  stalled: string | null;
  ops: OutboxOp[];
}

const asSendError = (e: unknown): SendError => {
  const x = e as Partial<SendError> & { message?: string };
  return {
    status: x.status ?? 0,
    code: x.code ?? 'network',
    message: x.message ?? 'Network error',
    details: x.details,
  };
};

export class Outbox {
  private ops: OutboxOp[] = [];
  private loaded: Promise<void> | null = null;
  private running: Promise<void> | null = null;
  private listeners = new Set<() => void>();
  private snapshot: SyncSnapshot = {
    pending: 0,
    needsAttention: 0,
    syncing: false,
    lastSyncedAt: null,
    stalled: null,
    ops: [],
  };
  private syncing = false;
  private lastSyncedAt: string | null = null;
  private stalled: string | null = null;

  constructor(
    private readonly storage: OutboxStorage,
    private readonly opts: {
      send: Sender;
      /** Current business; only its edits are sent (a shared device never mixes businesses). */
      tenantId: () => string | null;
      /** Called with the server's record after an edit is confirmed or the server copy is chosen. */
      onRecord?: (entity: Entity, id: string, record: unknown) => void;
      newId?: () => string;
      now?: () => Date;
    },
  ) {}

  /* ------------------------------ reading ------------------------------ */

  async load() {
    this.loaded ??= this.storage.all().then((ops) => {
      this.ops = ops.sort((a, b) => a.seq - b.seq);
      this.emit();
    });
    return this.loaded;
  }
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.snapshot;
  /** Pending local values for a record, to overlay on cached server data. */
  pendingChanges(entity: Entity, id: string): Fields | null {
    const mine = this.ops.filter((o) => o.entity === entity && o.entityId === id);
    if (!mine.length) return null;
    return Object.assign({}, ...mine.map((o) => o.changes));
  }

  private emit() {
    const tenant = this.opts.tenantId();
    const ops = this.ops.filter((o) => !tenant || o.tenantId === tenant);
    this.snapshot = {
      pending: ops.filter((o) => o.status === 'pending').length,
      needsAttention: ops.filter((o) => o.status !== 'pending').length,
      syncing: this.syncing,
      lastSyncedAt: this.lastSyncedAt,
      stalled: this.stalled,
      ops,
    };
    for (const fn of this.listeners) fn();
  }

  /* ------------------------------ writing ------------------------------ */

  /**
   * Saves an edit on the device. Several edits to the same record before it syncs are merged into one
   * (latest value per field wins; the base stays the one from the first edit).
   */
  async enqueue(input: {
    entity: Entity;
    entityId: string;
    label: string;
    path: string;
    changes: Fields;
    /** The record as the person saw it when they made the edit. */
    record: unknown;
    version: number;
  }): Promise<OutboxOp> {
    await this.load();
    const tenantId = this.opts.tenantId();
    if (!tenantId) throw new Error('Not signed in');
    const now = (this.opts.now?.() ?? new Date()).toISOString();
    const current = editableFields(input.entity, input.record);
    // Merge into the latest pending op for this record, unless that is an action: an edit made after
    // an action (e.g. starting the timer) must be sent after it.
    const latest = this.ops
      .filter((o) => o.entity === input.entity && o.entityId === input.entityId)
      .at(-1);
    const existing = latest?.status === 'pending' && latest.kind !== 'action' ? latest : undefined;
    if (existing) {
      for (const k of Object.keys(input.changes))
        if (!(k in existing.base)) existing.base[k] = current[k];
      existing.changes = { ...existing.changes, ...input.changes };
      existing.updatedAt = now;
      await this.storage.put(existing);
      this.emit();
      return existing;
    }
    const base: Fields = {};
    for (const k of Object.keys(input.changes)) base[k] = current[k];
    const op: OutboxOp = {
      id: this.opts.newId?.() ?? crypto.randomUUID(),
      seq: Math.max(0, ...this.ops.map((o) => o.seq)) + 1,
      tenantId,
      entity: input.entity,
      entityId: input.entityId,
      label: input.label,
      path: input.path,
      changes: { ...input.changes },
      base,
      baseVersion: input.version,
      status: 'pending',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    // Write to the device before anything else; if this throws, the caller must not say "saved".
    await this.storage.put(op);
    this.ops.push(op);
    this.emit();
    return op;
  }

  /** Saves a one-off action (POST) on the device, to be sent in order with the edits. */
  async enqueueAction(input: {
    entity: Entity;
    entityId: string;
    label: string;
    path: string;
    body: Fields;
  }): Promise<OutboxOp> {
    await this.load();
    const tenantId = this.opts.tenantId();
    if (!tenantId) throw new Error('Not signed in');
    const now = (this.opts.now?.() ?? new Date()).toISOString();
    const op: OutboxOp = {
      id: this.opts.newId?.() ?? crypto.randomUUID(),
      kind: 'action',
      seq: Math.max(0, ...this.ops.map((o) => o.seq)) + 1,
      tenantId,
      entity: input.entity,
      entityId: input.entityId,
      label: input.label,
      path: input.path,
      changes: { ...input.body },
      base: {},
      baseVersion: 0,
      status: 'pending',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    await this.storage.put(op);
    this.ops.push(op);
    this.emit();
    return op;
  }

  /** Sends pending edits in order. Safe to call often; concurrent calls share one run. */
  flush(): Promise<void> {
    this.running ??= this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run() {
    await this.load();
    const tenant = this.opts.tenantId();
    if (!tenant) return;
    this.syncing = true;
    this.stalled = null;
    this.emit();
    try {
      for (const op of [...this.ops]) {
        if (op.tenantId !== tenant || op.status !== 'pending' || !this.ops.includes(op)) continue;
        // An unresolved problem on the same record blocks later edits to it (keeps order meaningful).
        if (
          this.ops.some(
            (o) => o.entityId === op.entityId && o.status !== 'pending' && o.seq < op.seq,
          )
        )
          continue;
        const stop = await this.sendOne(op);
        if (stop) {
          this.stalled = stop;
          break;
        }
      }
    } finally {
      this.syncing = false;
      this.emit();
    }
  }

  /** Returns a reason to stop the run, or null to continue. */
  private async sendOne(op: OutboxOp, rebased = false): Promise<string | null> {
    try {
      const record = await this.opts.send(op);
      await this.remove(op);
      this.lastSyncedAt = (this.opts.now?.() ?? new Date()).toISOString();
      this.opts.onRecord?.(op.entity, op.entityId, record);
      return null;
    } catch (e) {
      const err = asSendError(e);
      if (err.status === 0) return 'offline';
      if (err.status === 401) return 'signed_out';
      if (err.status >= 500 || err.status === 429) {
        op.attempts++;
        await this.storage.put(op);
        return 'server';
      }
      if (err.status === 409 && err.code === 'version_conflict' && op.kind !== 'action') {
        const details = err.details as { current: unknown; currentVersion: number };
        const server = editableFields(op.entity, details.current);
        const changed = Object.keys(op.changes);
        const theyChanged = changed.filter((k) => !sameValue(server[k], op.base[k]));
        const clash = theyChanged.filter((k) => !sameValue(server[k], op.changes[k]));
        if (clash.length === 0 && !rebased) {
          // Rules 2 and 3: rebase on the server's version and try once more.
          op.base = Object.fromEntries(changed.map((k) => [k, server[k]]));
          op.baseVersion = details.currentVersion;
          await this.storage.put(op);
          return this.sendOne(op, true);
        }
        op.status = 'conflict';
        op.conflict = {
          fields: clash,
          server,
          serverVersion: details.currentVersion,
          record: details.current,
        };
        op.error = 'Changed on another device too.';
        await this.storage.put(op);
        this.emit();
        return null;
      }
      // Rule 5: the server won't accept it as it stands (locked, invalid, not found...).
      op.status = 'failed';
      op.error = err.message;
      await this.storage.put(op);
      this.emit();
      return null;
    }
  }

  private async remove(op: OutboxOp) {
    await this.storage.delete(op.id);
    this.ops = this.ops.filter((o) => o.id !== op.id);
    this.emit();
  }

  /* ----------------------------- resolving ----------------------------- */

  /** "Keep mine": re-send my values on top of the server's latest version. */
  async keepMine(id: string) {
    const op = this.ops.find((o) => o.id === id);
    if (!op?.conflict) return;
    op.base = Object.fromEntries(Object.keys(op.changes).map((k) => [k, op.conflict!.server[k]]));
    op.baseVersion = op.conflict.serverVersion;
    op.status = 'pending';
    delete op.conflict;
    delete op.error;
    await this.storage.put(op);
    this.emit();
    await this.flush();
  }

  /** "Use theirs" / "Discard": drop my edit and show the server's copy. */
  async discard(id: string) {
    const op = this.ops.find((o) => o.id === id);
    if (!op) return;
    await this.remove(op);
    if (op.conflict) this.opts.onRecord?.(op.entity, op.entityId, op.conflict.record);
  }

  /** Try a failed edit again (e.g. after fixing settings). */
  async retry(id: string) {
    const op = this.ops.find((o) => o.id === id);
    if (!op || op.status !== 'failed') return;
    op.status = 'pending';
    delete op.error;
    await this.storage.put(op);
    this.emit();
    await this.flush();
  }

  /** Used on sign-out once the person has confirmed losing unsynced edits. */
  async clear() {
    for (const op of this.ops) await this.storage.delete(op.id);
    this.ops = [];
    this.emit();
  }
}
