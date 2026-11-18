/**
 * Two-way calendar sync: runs the shared plans (packages/shared/src/calendarSync.ts) against a
 * provider adapter. App → calendar writes events to the person's "LSE jobs" calendar; calendar →
 * app turns moves and deletes into proposals in Approvals (never silent changes).
 *
 * The Google and Microsoft adapters need an OAuth app each (Google Cloud project, Azure app
 * registration), which don't exist yet; until they do, `available` is false for both and the
 * Connect buttons say so. Tests use a fake adapter.
 */
import {
  CALENDAR_PROVIDER_LABELS,
  CALENDAR_PROVIDERS,
  planPull,
  planPush,
  slotText,
  type CalendarChangePayload,
  type CalendarConnectionDto,
  type CalendarEventBody,
  type CalendarProvider,
  type CalendarSyncResultDto,
  type CalendarSyncStatusDto,
  type EventLink,
  type PullProposal,
  type RemoteChange,
} from '@lse/shared';
import type { Tx } from '../db/client';
import { notFound } from '../lib/errors';
import { iso, type Auth } from '../lib/types';
import { audit } from './audit';
import { feedRows } from './calendar';

export interface CalendarConnection {
  id: string;
  userId: string;
  provider: CalendarProvider;
  calendarId: string;
  /** Encrypted by the Worker; adapters decrypt it with the server key. */
  tokenEnc: string;
  syncToken: string | null;
}

/** What a calendar service must do for the sync. */
export interface CalendarAdapter {
  /** Creates (remoteId null) or replaces the event; returns its id and version tag. */
  upsert(
    conn: CalendarConnection,
    body: CalendarEventBody,
    remoteId: string | null,
  ): Promise<{ remoteId: string; etag: string | null }>;
  /** Deletes the event; an event that is already gone is fine. */
  remove(conn: CalendarConnection, remoteId: string): Promise<void>;
  /** Changes since the sync token (all events in the calendar when null). */
  changes(
    conn: CalendarConnection,
    syncToken: string | null,
  ): Promise<{ changes: RemoteChange[]; nextSyncToken: string | null }>;
}
export type CalendarAdapters = Partial<Record<CalendarProvider, CalendarAdapter>>;

export async function status(
  tx: Tx,
  auth: Auth,
  adapters: CalendarAdapters,
): Promise<CalendarSyncStatusDto> {
  const rows = await tx<
    {
      id: string;
      provider: CalendarProvider;
      accountEmail: string | null;
      calendarName: string;
      status: 'connected' | 'needs_reconnect';
      lastSyncedAt: Date | null;
      linked: string;
    }[]
  >`
    SELECT c.id, c.provider, c.account_email, c.calendar_name, c.status, c.last_synced_at,
           (SELECT count(*) FROM calendar_event_links l WHERE l.connection_id = c.id) AS linked
      FROM calendar_connections c WHERE c.user_id = ${auth.userId} ORDER BY c.provider`;
  const connections: CalendarConnectionDto[] = rows.map((r) => ({
    id: r.id,
    provider: r.provider,
    accountEmail: r.accountEmail,
    calendarName: r.calendarName,
    status: r.status,
    lastSyncedAt: iso(r.lastSyncedAt),
    linkedEvents: Number(r.linked),
  }));
  const available = Object.fromEntries(CALENDAR_PROVIDERS.map((p) => [p, !!adapters[p]])) as Record<
    CalendarProvider,
    boolean
  >;
  return { available, connections };
}

/** Saves a connection after the OAuth step (called by the provider callback). */
export async function connect(
  tx: Tx,
  auth: Auth,
  input: {
    provider: CalendarProvider;
    accountEmail: string | null;
    calendarId: string;
    tokenEnc: string;
  },
): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO calendar_connections (tenant_id, user_id, provider, account_email, calendar_id, token_enc)
    VALUES (${auth.tenantId}, ${auth.userId}, ${input.provider}, ${input.accountEmail}, ${input.calendarId}, ${input.tokenEnc})
    ON CONFLICT (tenant_id, user_id, provider) DO UPDATE
      SET account_email = EXCLUDED.account_email, calendar_id = EXCLUDED.calendar_id,
          token_enc = EXCLUDED.token_enc, status = 'connected', sync_token = NULL
    RETURNING id`;
  await audit(tx, auth, 'calendar_connected', 'calendar_connection', row!.id, {
    provider: input.provider,
  });
  return row!.id;
}

/** Forgets the connection and its tokens. Events already in the calendar stay there. */
export async function disconnect(tx: Tx, auth: Auth, id: string): Promise<void> {
  const r =
    await tx`DELETE FROM calendar_connections WHERE id = ${id} AND user_id = ${auth.userId} RETURNING id`;
  if (!r.length) throw notFound('Calendar connection');
  await audit(tx, auth, 'calendar_disconnected', 'calendar_connection', id);
}

async function loadLinks(tx: Tx, connectionId: string): Promise<EventLink[]> {
  const rows = await tx<
    {
      appointmentId: string;
      remoteId: string;
      etag: string | null;
      appHash: string;
      remoteStartsAt: Date;
      remoteEndsAt: Date;
    }[]
  >`
    SELECT appointment_id, remote_id, etag, app_hash, remote_starts_at, remote_ends_at
      FROM calendar_event_links WHERE connection_id = ${connectionId}`;
  return rows.map((r) => ({
    ...r,
    remoteStartsAt: new Date(r.remoteStartsAt).toISOString(),
    remoteEndsAt: new Date(r.remoteEndsAt).toISOString(),
  }));
}

function proposalText(p: PullProposal, provider: CalendarProvider, job: string) {
  const where = CALENDAR_PROVIDER_LABELS[provider];
  const clash = p.conflict
    ? ' It was also changed in the app since the last sync; approving replaces that change.'
    : '';
  if (p.type === 'cancel')
    return {
      title: `${job}: deleted in ${where}`,
      summary: `The event for ${job} was deleted in ${where}. Approve to remove the appointment from the app too; discard to keep it (it goes back into the calendar).${clash}`,
    };
  return {
    title: `${job}: moved in ${where}`,
    summary: `${job} was moved in ${where} to ${slotText(p.startsAt, p.endsAt)} (was ${slotText(p.fromStartsAt, p.fromEndsAt)}). Approve to move the appointment; discard to put the event back.${clash}`,
  };
}

/** Writes or refreshes the waiting proposal for an appointment (one per appointment). */
async function propose(
  tx: Tx,
  auth: Auth,
  conn: CalendarConnection,
  p: PullProposal,
  job: string,
): Promise<void> {
  const payload: CalendarChangePayload = {
    provider: conn.provider,
    connectionId: conn.id,
    change: p,
  };
  const { title, summary } = proposalText(p, conn.provider, job);
  const updated = await tx`
    UPDATE proposals SET payload = ${tx.json(payload as never)}, title = ${title.slice(0, 200)},
           summary = ${summary.slice(0, 1000)}, updated_at = now(), version = version + 1
     WHERE kind = 'calendar_change' AND source_id = ${p.appointmentId} AND status = 'pending'
     RETURNING id`;
  if (updated.length) return;
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO proposals (tenant_id, agent, kind, title, summary, payload, source_type, source_id)
    VALUES (${auth.tenantId}, 'calendar-sync', 'calendar_change', ${title.slice(0, 200)}, ${summary.slice(0, 1000)},
            ${tx.json(payload as never)}, 'appointment', ${p.appointmentId})
    RETURNING id`;
  await tx`INSERT INTO proposal_events (tenant_id, proposal_id, event, by_user, data)
           VALUES (${auth.tenantId}, ${row!.id}, 'created', ${auth.userId}, ${tx.json({ agent: 'calendar-sync' })})`;
}

/** One connection: calendar changes first (as proposals), then the app's changes out. */
async function syncOne(
  tx: Tx,
  auth: Auth,
  conn: CalendarConnection,
  adapter: CalendarAdapter,
  appOrigin: string | null,
): Promise<CalendarSyncResultDto> {
  const rows = await feedRows(tx, auth, 'mine');
  const appts = rows.map((r) => ({
    id: r.id,
    startsAt: new Date(r.startsAt).toISOString(),
    endsAt: new Date(r.endsAt).toISOString(),
    jobNumber: r.jobNumber,
    jobTitle: r.jobTitle,
    customerName: r.customerName,
    siteAddress: r.siteAddress,
    assignee: r.assignee,
  }));
  const jobOf = new Map(rows.map((r) => [r.id, `Job ${r.jobNumber}`]));
  const result: CalendarSyncResultDto = { created: 0, updated: 0, deleted: 0, proposals: 0 };

  // Calendar → app.
  let links = await loadLinks(tx, conn.id);
  const { changes, nextSyncToken } = await adapter.changes(conn, conn.syncToken);
  for (const p of planPull(changes, links, appts, appOrigin)) {
    await propose(tx, auth, conn, p, jobOf.get(p.appointmentId) ?? 'A job');
    result.proposals++;
    if (p.type === 'cancel')
      // The event is gone; if the proposal is discarded the next sync makes a new one.
      await tx`DELETE FROM calendar_event_links WHERE connection_id = ${conn.id} AND appointment_id = ${p.appointmentId}`;
    else
      await tx`UPDATE calendar_event_links SET remote_starts_at = ${p.startsAt}, remote_ends_at = ${p.endsAt}
                WHERE connection_id = ${conn.id} AND appointment_id = ${p.appointmentId}`;
  }
  // Appointments waiting on a calendar proposal aren't pushed (that would undo the move).
  const waiting = new Set(
    (
      await tx<{ sourceId: string }[]>`
        SELECT source_id FROM proposals WHERE kind = 'calendar_change' AND status = 'pending'`
    ).map((r) => r.sourceId),
  );

  // App → calendar.
  links = await loadLinks(tx, conn.id);
  const ops = planPush(
    appts.filter((a) => !waiting.has(a.id)),
    links.filter((l) => !waiting.has(l.appointmentId)),
    appOrigin,
  );
  for (const op of ops) {
    if (op.op === 'delete') {
      await adapter.remove(conn, op.remoteId);
      await tx`DELETE FROM calendar_event_links WHERE connection_id = ${conn.id} AND appointment_id = ${op.appointmentId}`;
      result.deleted++;
      continue;
    }
    const r = await adapter.upsert(conn, op.body, op.op === 'update' ? op.remoteId : null);
    await tx`
      INSERT INTO calendar_event_links (tenant_id, connection_id, appointment_id, remote_id, etag, app_hash, remote_starts_at, remote_ends_at)
      VALUES (${auth.tenantId}, ${conn.id}, ${op.appointmentId}, ${r.remoteId}, ${r.etag}, ${op.hash}, ${op.body.startsAt}, ${op.body.endsAt})
      ON CONFLICT (connection_id, appointment_id) DO UPDATE
        SET remote_id = EXCLUDED.remote_id, etag = EXCLUDED.etag, app_hash = EXCLUDED.app_hash,
            remote_starts_at = EXCLUDED.remote_starts_at, remote_ends_at = EXCLUDED.remote_ends_at,
            synced_at = now()`;
    if (op.op === 'create') result.created++;
    else result.updated++;
  }
  await tx`UPDATE calendar_connections SET sync_token = ${nextSyncToken}, last_synced_at = now() WHERE id = ${conn.id}`;
  return result;
}

/** Syncs every calendar this person has connected. */
export async function syncMine(
  tx: Tx,
  auth: Auth,
  adapters: CalendarAdapters,
  appOrigin: string | null,
): Promise<CalendarSyncResultDto> {
  const conns = await tx<CalendarConnection[]>`
    SELECT id, user_id, provider, calendar_id, token_enc, sync_token
      FROM calendar_connections WHERE user_id = ${auth.userId} AND status = 'connected'`;
  const total: CalendarSyncResultDto = { created: 0, updated: 0, deleted: 0, proposals: 0 };
  for (const c of conns) {
    const adapter = adapters[c.provider];
    if (!adapter) continue;
    const r = await syncOne(tx, auth, c, adapter, appOrigin);
    total.created += r.created;
    total.updated += r.updated;
    total.deleted += r.deleted;
    total.proposals += r.proposals;
  }
  await audit(tx, auth, 'calendar_synced', 'user', auth.userId, { ...total });
  return total;
}

/** Approving a calendar proposal: move the appointment, or remove it. */
export async function applyChange(tx: Tx, auth: Auth, payload: CalendarChangePayload) {
  const c = payload.change;
  if (c.type === 'move') {
    const r = await tx`
      UPDATE appointments SET starts_at = ${c.startsAt}, ends_at = ${c.endsAt}, updated_at = now()
       WHERE id = ${c.appointmentId} RETURNING id`;
    if (!r.length) throw notFound('Appointment');
  } else {
    await tx`DELETE FROM appointments WHERE id = ${c.appointmentId}`;
  }
  await audit(
    tx,
    auth,
    `appointment_${c.type === 'move' ? 'moved' : 'removed'}_from_calendar`,
    'appointment',
    c.appointmentId,
    {
      provider: payload.provider,
    },
  );
  return { appointmentId: c.appointmentId, change: c.type };
}

/** Discarding: the next sync puts the app's version back into the calendar. */
export async function discardChange(tx: Tx, payload: CalendarChangePayload) {
  await tx`UPDATE calendar_event_links SET app_hash = '' WHERE connection_id = ${payload.connectionId}
             AND appointment_id = ${payload.change.appointmentId}`;
}
