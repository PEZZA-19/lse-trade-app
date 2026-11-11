import { buildIcs, feedEvents, type CalendarFeedDto, type FeedAppointment } from '@lse/shared';
import type { Tx } from '../db/client';
import { notFound } from '../lib/errors';
import type { Auth } from '../lib/types';
import { accessOf, assertAdmin } from './access';
import { audit } from './audit';

export type FeedScope = 'mine' | 'all';
export const FEED_PATH = (token: string) => `/api/public/calendar/${token}.ics`;
export const FEED_TOKEN = /^[A-Za-z0-9_-]{32,64}$/;

/** 32 random bytes, base64url (43 characters): unguessable. */
function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** The signed-in person's own links ('all jobs' only for admins). */
export async function getFeeds(tx: Tx, auth: Auth): Promise<CalendarFeedDto[]> {
  const rows = await tx<{ scope: FeedScope; token: string; createdAt: Date }[]>`
    SELECT scope, token, created_at AS "createdAt" FROM calendar_feeds
     WHERE tenant_id = ${auth.tenantId} AND user_id = ${auth.userId}`;
  const scopes: FeedScope[] = accessOf(auth).isAdmin ? ['mine', 'all'] : ['mine'];
  return scopes.map((scope) => {
    const r = rows.find((x) => x.scope === scope);
    return {
      scope,
      path: r ? FEED_PATH(r.token) : null,
      createdAt: r ? r.createdAt.toISOString() : null,
    };
  });
}

/** Makes the link, or replaces it (the old link stops working straight away). */
export async function regenerate(tx: Tx, auth: Auth, scope: FeedScope): Promise<CalendarFeedDto> {
  if (scope === 'all') assertAdmin(auth, 'get a calendar of everyone’s jobs');
  const token = newToken();
  await tx`
    INSERT INTO calendar_feeds (tenant_id, user_id, scope, token)
    VALUES (${auth.tenantId}, ${auth.userId}, ${scope}, ${token})
    ON CONFLICT (tenant_id, user_id, scope) DO UPDATE SET token = EXCLUDED.token, created_at = now()`;
  await audit(tx, auth, 'calendar_feed_regenerated', 'user', auth.userId, { scope });
  return (await getFeeds(tx, auth)).find((f) => f.scope === scope)!;
}

/** Switches a link off. */
export async function revoke(tx: Tx, auth: Auth, scope: FeedScope): Promise<CalendarFeedDto[]> {
  await tx`DELETE FROM calendar_feeds
            WHERE tenant_id = ${auth.tenantId} AND user_id = ${auth.userId} AND scope = ${scope}`;
  await audit(tx, auth, 'calendar_feed_revoked', 'user', auth.userId, { scope });
  return getFeeds(tx, auth);
}

/**
 * Appointments for the feed: the person's own (booked with them, or unassigned on a job they're on),
 * or everyone's for an admin's 'all jobs' link. Cancelled jobs drop out; removed appointments simply
 * disappear. Only what everyone who can open a job may see: no prices or money.
 */
export async function feedRows(tx: Tx, auth: Auth, scope: FeedScope): Promise<FeedAppointment[]> {
  if (scope === 'all' && !accessOf(auth).isAdmin) throw notFound('Calendar');
  const mine = scope === 'mine';
  return tx<FeedAppointment[]>`
    SELECT a.id, a.starts_at AS "startsAt", a.ends_at AS "endsAt", j.id AS "jobId",
           j.number AS "jobNumber", j.title AS "jobTitle", c.name AS "customerName",
           c.phone AS "customerPhone", s.address AS "siteAddress", u.name AS assignee
      FROM appointments a
      JOIN jobs j ON j.tenant_id = a.tenant_id AND j.id = a.job_id
      JOIN job_stages st ON st.tenant_id = j.tenant_id AND st.id = j.stage_id
      JOIN customers c ON c.tenant_id = j.tenant_id AND c.id = j.customer_id
      LEFT JOIN sites s ON s.tenant_id = j.tenant_id AND s.id = j.site_id
      LEFT JOIN users u ON u.id = a.user_id
     WHERE a.tenant_id = ${auth.tenantId}
       AND st.system_key IS DISTINCT FROM 'cancelled'
       AND a.ends_at > now() - interval '60 days'
       AND a.starts_at < now() + interval '400 days'
       AND (${!mine} OR a.user_id = ${auth.userId}
            OR (a.user_id IS NULL AND EXISTS (
                  SELECT 1 FROM job_assignees ja
                   WHERE ja.tenant_id = a.tenant_id AND ja.job_id = a.job_id
                     AND ja.user_id = ${auth.userId})))
     ORDER BY a.starts_at, a.id
     LIMIT 2000`;
}

export async function feedIcs(
  tx: Tx,
  auth: Auth,
  scope: FeedScope,
  appOrigin: string | null,
): Promise<string> {
  const rows = await feedRows(tx, auth, scope);
  const [t] = await tx<{ name: string }[]>`SELECT name FROM tenants WHERE id = ${auth.tenantId}`;
  const [me] = await tx<{ name: string }[]>`SELECT name FROM users WHERE id = ${auth.userId}`;
  const name =
    scope === 'all'
      ? `${t?.name ?? 'LSE'}: all jobs`
      : `${t?.name ?? 'LSE'}: ${me?.name ?? 'my'} jobs`;
  return buildIcs({ name, events: feedEvents(rows, appOrigin), now: new Date() });
}
