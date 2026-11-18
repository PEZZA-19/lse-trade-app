/**
 * Two-way calendar sync: runs the shared plans (packages/shared/src/calendarSync.ts) against a
 * provider adapter. App → calendar writes events to the person's "LSE jobs" calendar; calendar →
 * app applies moves and deletes straight away and logs them with Undo (Joe, 18 Nov 2026).
 *
 * Google Calendar only for now (Joe, 18 Nov 2026). The Google adapter and sign-in live in
 * googleCalendar.ts and need a Google Cloud OAuth client (docs/GOOGLE_CALENDAR_SETUP.md); until it
 * is configured `available.google` is false and the app says "needs setting up". Tests use fakes.
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
  type AppliedCalendarChange,
  type RemoteChange,
  type SyncAppointment,
  type CalendarActivityDto,
  bodyHash,
  eventBody,
} from '@lse/shared';
import { withTenant, type Sql, type Tx } from '../db/client';
import { pkceChallenge } from '../lib/sealed';
import { randomToken, sha256Hex } from '../lib/crypto';
import { AppError, notFound } from '../lib/errors';
import { iso, type Auth } from '../lib/types';
import { audit } from './audit';
import { feedRows } from './calendar';
import { lockJob } from './jobs';
import { applyEvent } from './stages';
import { CalendarAuthError, type GoogleCalendar } from './googleCalendar';

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
      lastError: string | null;
      linked: string;
    }[]
  >`
    SELECT c.id, c.provider, c.account_email, c.calendar_name, c.status, c.last_synced_at, c.last_error,
           (SELECT count(*) FROM calendar_event_links l WHERE l.connection_id = c.id) AS linked
      FROM calendar_connections c WHERE c.user_id = ${auth.userId} ORDER BY c.provider`;
  const connections: CalendarConnectionDto[] = rows.map((r) => ({
    id: r.id,
    provider: r.provider,
    accountEmail: r.accountEmail,
    calendarName: r.calendarName,
    status: r.status,
    lastSyncedAt: iso(r.lastSyncedAt),
    lastError: r.lastError,
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
    /** True when this is a new calendar replacing an earlier one (drops the old event links). */
    calendarChanged?: boolean;
  },
): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO calendar_connections (tenant_id, user_id, provider, account_email, calendar_id, token_enc)
    VALUES (${auth.tenantId}, ${auth.userId}, ${input.provider}, ${input.accountEmail}, ${input.calendarId}, ${input.tokenEnc})
    ON CONFLICT (tenant_id, user_id, provider) DO UPDATE
      SET account_email = EXCLUDED.account_email, calendar_id = EXCLUDED.calendar_id,
          token_enc = EXCLUDED.token_enc, status = 'connected', sync_token = NULL, last_error = NULL
    RETURNING id`;
  // A different calendar (e.g. the old one was deleted): its event links mean nothing there, so
  // the next sync puts every booking into the new calendar.
  if (input.calendarChanged)
    await tx`DELETE FROM calendar_event_links WHERE connection_id = ${row!.id}`;
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

function activityText(p: AppliedCalendarChange, provider: CalendarProvider, job: string) {
  const where = CALENDAR_PROVIDER_LABELS[provider];
  const clash = p.conflict
    ? ' It had also been changed in the app, but the calendar change was more recent.'
    : '';
  if (p.type === 'cancel')
    return {
      title: `${job}: deleted in ${where}`,
      detail: `The appointment was removed from the app.${clash}`,
    };
  return {
    title: `${job}: moved in ${where}`,
    detail: `Now ${slotText(p.startsAt, p.endsAt)} (was ${slotText(p.fromStartsAt, p.fromEndsAt)}).${clash}`,
  };
}

interface ApptSnapshot {
  jobId: string;
  userId: string | null;
  startsAt: string;
  endsAt: string;
  createdAt: string;
  enquiryIds: string[];
}

/**
 * Applies a move or delete made in the calendar to the app straight away (Joe, 18 Nov 2026) and
 * logs it with what it replaced, so it can be undone from the Calendar screen.
 */
async function applyFromCalendar(
  tx: Tx,
  auth: Auth,
  conn: CalendarConnection,
  p: AppliedCalendarChange,
  job: string,
  appOrigin: string | null,
  appt: SyncAppointment | undefined,
): Promise<boolean> {
  const [a] = await tx<
    { jobId: string; userId: string | null; startsAt: Date; endsAt: Date; createdAt: Date }[]
  >`SELECT job_id, user_id, starts_at, ends_at, created_at FROM appointments WHERE id = ${p.appointmentId}`;
  if (!a) return false;
  await lockJob(tx, a.jobId);
  const enquiries = await tx<{ id: string }[]>`
    SELECT id FROM enquiries WHERE appointment_id = ${p.appointmentId}`;
  const before: ApptSnapshot = {
    jobId: a.jobId,
    userId: a.userId,
    startsAt: new Date(a.startsAt).toISOString(),
    endsAt: new Date(a.endsAt).toISOString(),
    createdAt: new Date(a.createdAt).toISOString(),
    enquiryIds: enquiries.map((e) => e.id),
  };
  const { title, detail } = activityText(p, conn.provider, job);
  if (p.type === 'cancel') {
    await tx`DELETE FROM appointments WHERE id = ${p.appointmentId}`;
    await applyEvent(tx, auth, a.jobId, 'appointment_deleted');
    // The event is gone in the calendar; Undo puts the appointment back and the next sync re-adds it.
    await tx`DELETE FROM calendar_event_links WHERE connection_id = ${conn.id} AND appointment_id = ${p.appointmentId}`;
  } else {
    await tx`UPDATE appointments SET starts_at = ${p.startsAt}, ends_at = ${p.endsAt}, updated_at = now()
              WHERE id = ${p.appointmentId}`;
    // The calendar already shows the new times: record them so the push has nothing to send.
    const hash = appt
      ? bodyHash(eventBody({ ...appt, startsAt: p.startsAt, endsAt: p.endsAt }, appOrigin))
      : '';
    await tx`UPDATE calendar_event_links SET remote_starts_at = ${p.startsAt}, remote_ends_at = ${p.endsAt},
                    app_hash = ${hash}, synced_at = now()
              WHERE connection_id = ${conn.id} AND appointment_id = ${p.appointmentId}`;
  }
  await tx`
    INSERT INTO calendar_activity (tenant_id, user_id, provider, appointment_id, job_id, kind, title, detail, before, after, conflict)
    VALUES (${auth.tenantId}, ${auth.userId}, ${conn.provider}, ${p.appointmentId}, ${a.jobId},
            ${p.type === 'cancel' ? 'deleted' : 'moved'}, ${title.slice(0, 200)}, ${detail.slice(0, 1000)},
            ${tx.json(before as never)},
            ${p.type === 'move' ? tx.json({ startsAt: p.startsAt, endsAt: p.endsAt } as never) : null},
            ${p.conflict})`;
  await audit(
    tx,
    auth,
    `appointment_${p.type === 'move' ? 'moved' : 'removed'}_from_calendar`,
    'appointment',
    p.appointmentId,
    { provider: conn.provider, conflict: p.conflict },
  );
  return true;
}

/** One connection: calendar changes first (applied straight away), then the app's changes out. */
async function syncOne(
  tx: Tx,
  auth: Auth,
  conn: CalendarConnection,
  adapter: CalendarAdapter,
  appOrigin: string | null,
): Promise<CalendarSyncResultDto> {
  const rows = await feedRows(tx, auth, 'mine');
  const changedAt = new Map(
    (
      await tx<{ id: string; updatedAt: Date }[]>`
        SELECT id, updated_at FROM appointments WHERE id = ANY(${rows.map((r) => r.id)}::uuid[])`
    ).map((r) => [r.id, new Date(r.updatedAt).toISOString()]),
  );
  const appts = rows.map((r) => ({
    id: r.id,
    startsAt: new Date(r.startsAt).toISOString(),
    endsAt: new Date(r.endsAt).toISOString(),
    jobNumber: r.jobNumber,
    jobTitle: r.jobTitle,
    customerName: r.customerName,
    siteAddress: r.siteAddress,
    assignee: r.assignee,
    updatedAt: changedAt.get(r.id) ?? null,
  }));
  const jobOf = new Map(rows.map((r) => [r.id, `Job ${r.jobNumber}`]));
  const result: CalendarSyncResultDto = { created: 0, updated: 0, deleted: 0, applied: 0 };

  // Calendar → app, straight away.
  let links = await loadLinks(tx, conn.id);
  const { changes, nextSyncToken } = await adapter.changes(conn, conn.syncToken);
  const byId = new Map(appts.map((a) => [a.id, a]));
  for (const p of planPull(changes, links, appts, appOrigin)) {
    if (p.type === 'restore') {
      // The app's change is newer than the calendar's delete: forget the old event; the push below
      // puts the booking back in the calendar.
      await tx`DELETE FROM calendar_event_links WHERE connection_id = ${conn.id} AND appointment_id = ${p.appointmentId}`;
      await audit(tx, auth, 'calendar_conflict_app_kept', 'appointment', p.appointmentId, {
        provider: conn.provider,
      });
      continue;
    }
    const job = jobOf.get(p.appointmentId) ?? 'A job';
    if (await applyFromCalendar(tx, auth, conn, p, job, appOrigin, byId.get(p.appointmentId)))
      result.applied++;
    if (p.type === 'move')
      byId.set(p.appointmentId, {
        ...byId.get(p.appointmentId)!,
        startsAt: p.startsAt,
        endsAt: p.endsAt,
      });
    else byId.delete(p.appointmentId);
  }
  const current = [...byId.values()];
  // Older calendar proposals still waiting in Approvals (before 18 Nov 2026) aren't pushed.
  const waiting = new Set(
    (
      await tx<{ sourceId: string }[]>`
        SELECT source_id FROM proposals WHERE kind = 'calendar_change' AND status = 'pending'`
    ).map((r) => r.sourceId),
  );

  // App → calendar.
  links = await loadLinks(tx, conn.id);
  const ops = planPush(
    current.filter((a) => !waiting.has(a.id)),
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
  await tx`UPDATE calendar_connections SET sync_token = ${nextSyncToken}, last_synced_at = now(), last_error = NULL
            WHERE id = ${conn.id}`;
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
  const total: CalendarSyncResultDto = {
    created: 0,
    updated: 0,
    deleted: 0,
    applied: 0,
    problems: [],
  };
  for (const c of conns) {
    const adapter = adapters[c.provider];
    if (!adapter) continue;
    try {
      // A savepoint, so one calendar failing half-way doesn't undo what the others did.
      const r = await tx.savepoint((sp) =>
        syncOne(sp as unknown as Tx, auth, c, adapter, appOrigin),
      );
      total.created += r.created;
      total.updated += r.updated;
      total.deleted += r.deleted;
      total.applied += r.applied;
    } catch (e) {
      const reconnect = e instanceof CalendarAuthError;
      const message = (
        e instanceof Error && (reconnect || e.name === 'CalendarApiError')
          ? e.message
          : 'The sync failed; it will try again later.'
      ).slice(0, 500);
      await tx`UPDATE calendar_connections
                  SET last_error = ${message}, status = ${reconnect ? 'needs_reconnect' : 'connected'}
                WHERE id = ${c.id}`;
      total.problems!.push(message);
    }
  }
  await audit(tx, auth, 'calendar_synced', 'user', auth.userId, { ...total });
  return total;
}

/** Approving an older calendar proposal (made before changes applied straight away). */
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

/* ------------------------ changes from the calendar, with Undo ------------------------ */

interface ActivityRow {
  id: string;
  provider: CalendarProvider;
  appointmentId: string;
  jobId: string | null;
  kind: 'moved' | 'deleted';
  title: string;
  detail: string;
  before: ApptSnapshot;
  after: { startsAt: string; endsAt: string } | null;
  conflict: boolean;
  createdAt: Date;
  undoneAt: Date | null;
  latest: boolean;
  nowStartsAt: Date | null;
  nowEndsAt: Date | null;
}

const ACTIVITY_SELECT = (tx: Tx, auth: Auth, id: string | null) => tx<ActivityRow[]>`
  SELECT a.id, a.provider, a.appointment_id, a.job_id, a.kind, a.title, a.detail, a.before, a.after,
         a.conflict, a.created_at, a.undone_at,
         NOT EXISTS (SELECT 1 FROM calendar_activity b
                      WHERE b.appointment_id = a.appointment_id AND b.created_at > a.created_at) AS latest,
         p.starts_at AS now_starts_at, p.ends_at AS now_ends_at
    FROM calendar_activity a LEFT JOIN appointments p ON p.id = a.appointment_id
   WHERE a.user_id = ${auth.userId} ${id ? tx`AND a.id = ${id}` : tx``}
   ORDER BY a.created_at DESC
   LIMIT 30`;

/** Undo only the latest change to an appointment, and only while the app still matches it. */
function undoable(r: ActivityRow): boolean {
  if (r.undoneAt || !r.latest) return false;
  if (r.kind === 'deleted') return r.nowStartsAt === null;
  return (
    !!r.after &&
    r.nowStartsAt !== null &&
    new Date(r.nowStartsAt).toISOString() === new Date(r.after.startsAt).toISOString() &&
    new Date(r.nowEndsAt!).toISOString() === new Date(r.after.endsAt).toISOString()
  );
}

const activityDto = (r: ActivityRow): CalendarActivityDto => ({
  id: r.id,
  provider: r.provider,
  appointmentId: r.appointmentId,
  jobId: r.jobId,
  kind: r.kind,
  title: r.title,
  detail: r.detail,
  conflict: r.conflict,
  createdAt: iso(r.createdAt)!,
  undoneAt: iso(r.undoneAt),
  canUndo: undoable(r),
});

/** The last 30 changes made in this person's calendar and applied to the app. */
export async function listActivity(tx: Tx, auth: Auth): Promise<CalendarActivityDto[]> {
  return (await ACTIVITY_SELECT(tx, auth, null)).map(activityDto);
}

/**
 * Undo: a move goes back to the old times, a delete puts the appointment back (same job, person,
 * times and enquiry). The next sync puts the app's version back into the calendar.
 */
export async function undoActivity(tx: Tx, auth: Auth, id: string): Promise<CalendarActivityDto> {
  const [r] = await ACTIVITY_SELECT(tx, auth, id);
  if (!r) throw notFound('Calendar change');
  if (r.undoneAt) throw new AppError(409, 'already_undone', 'That change has already been undone.');
  if (!undoable(r))
    throw new AppError(
      409,
      'changed_since',
      'The appointment has changed since then, so this can’t be undone. Change it on the job instead.',
    );
  const b = r.before;
  await lockJob(tx, b.jobId);
  if (r.kind === 'moved') {
    await tx`UPDATE appointments SET starts_at = ${b.startsAt}, ends_at = ${b.endsAt}, updated_at = now()
              WHERE id = ${r.appointmentId}`;
  } else {
    const [job] = await tx`SELECT 1 FROM jobs WHERE id = ${b.jobId}`;
    if (!job) throw new AppError(409, 'changed_since', 'The job has been deleted since then.');
    const [person] = b.userId
      ? await tx`SELECT 1 FROM memberships WHERE tenant_id = ${auth.tenantId} AND user_id = ${b.userId}`
      : [true];
    await tx`
      INSERT INTO appointments (id, tenant_id, job_id, user_id, starts_at, ends_at, created_at)
      VALUES (${r.appointmentId}, ${auth.tenantId}, ${b.jobId}, ${person ? b.userId : null},
              ${b.startsAt}, ${b.endsAt}, ${b.createdAt})`;
    if (b.enquiryIds.length)
      await tx`UPDATE enquiries SET appointment_id = ${r.appointmentId}
                WHERE id = ANY(${b.enquiryIds}::uuid[]) AND appointment_id IS NULL`;
    await applyEvent(tx, auth, b.jobId, 'appointment_created');
  }
  // Make the next sync send the app's version to the calendar.
  await tx`UPDATE calendar_event_links SET app_hash = '' WHERE appointment_id = ${r.appointmentId}`;
  await tx`UPDATE calendar_activity SET undone_at = now(), undone_by = ${auth.userId} WHERE id = ${id}`;
  await audit(tx, auth, 'calendar_change_undone', 'appointment', r.appointmentId, { kind: r.kind });
  const [after] = await ACTIVITY_SELECT(tx, auth, id);
  return activityDto(after!);
}

/* ------------------------- Google sign-in (OAuth + PKCE) ------------------------- */

/** Starts the Google sign-in: a one-off state and PKCE verifier, and the URL to send them to. */
export async function startGoogleConnect(tx: Tx, auth: Auth, google: GoogleCalendar) {
  const state = randomToken(32);
  const verifier = randomToken(48); // 64 characters, within PKCE's 43..128
  await tx`DELETE FROM calendar_oauth_states WHERE user_id = ${auth.userId} OR expires_at < now()`;
  await tx`INSERT INTO calendar_oauth_states (state_hash, tenant_id, user_id, provider, code_verifier)
           VALUES (${await sha256Hex(state)}, ${auth.tenantId}, ${auth.userId}, 'google', ${verifier})`;
  return { url: google.authUrl(state, await pkceChallenge(verifier)) };
}

/**
 * Google sent them back with a code: check the state is theirs and fresh, swap the code for tokens
 * (with the PKCE verifier), make (or reuse) the "LSE jobs" calendar, seal the refresh token, save.
 */
export async function finishGoogleConnect(
  tx: Tx,
  auth: Auth,
  google: GoogleCalendar,
  q: { code: string; state: string },
): Promise<{ connectionId: string; accountEmail: string | null }> {
  const [st] = await tx<{ codeVerifier: string }[]>`
    DELETE FROM calendar_oauth_states
     WHERE state_hash = ${await sha256Hex(q.state)} AND user_id = ${auth.userId}
       AND provider = 'google' AND expires_at > now()
    RETURNING code_verifier`;
  if (!st)
    throw new AppError(
      400,
      'calendar_state',
      'That Google sign-in has expired or wasn’t started here. Tap Connect again.',
    );
  const t = await google.exchange(q.code, st.codeVerifier);
  const [prev] = await tx<{ calendarId: string }[]>`
    SELECT calendar_id FROM calendar_connections WHERE user_id = ${auth.userId} AND provider = 'google'`;
  const reuse = prev && (await google.calendarExists(t.accessToken, prev.calendarId));
  const calendarId = reuse ? prev.calendarId : await google.createCalendar(t.accessToken);
  const connectionId = await connect(tx, auth, {
    provider: 'google',
    accountEmail: t.email,
    calendarId,
    tokenEnc: await google.sealToken(t.refreshToken, auth.userId),
    calendarChanged: !!prev && !reuse,
  });
  return { connectionId, accountEmail: t.email };
}

/* --------------------------------- schedule --------------------------------- */

/**
 * Workers cron: syncs everyone whose calendar is due (not synced for `every`), each in their own
 * business's transaction as that person. One failing doesn't stop the others.
 */
export async function syncDue(
  sql: Sql,
  adapters: CalendarAdapters,
  appOrigin: string | null,
  every = '15 minutes',
): Promise<{ synced: number; failed: number }> {
  const due = await sql<{ tenantId: string; userId: string; role: Auth['role'] }[]>`
    SELECT tenant_id, user_id, role FROM calendar_sync_due(${every}::interval)`;
  let synced = 0;
  let failed = 0;
  for (const d of due) {
    try {
      const auth: Auth = { tenantId: d.tenantId, userId: d.userId, role: d.role };
      await withTenant(sql, auth, (tx) => syncMine(tx, auth, adapters, appOrigin));
      synced++;
    } catch {
      failed++;
    }
  }
  return { synced, failed };
}
