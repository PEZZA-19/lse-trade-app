import type { Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { withUser, type Sql } from './db/client';
import { randomToken, safeEqual, sha256Hex } from './lib/crypto';
import { AppError } from './lib/errors';
import type { Mailer } from './lib/mailer';
import type { AppEnv, Auth } from './lib/types';
import { jsonBody, parse } from './lib/validate';

export const SESSION_TTL_SECONDS = 30 * 24 * 3600; // 30 days, sliding
export const LINK_TTL_SECONDS = 15 * 60;

export interface RateLimit {
  max: number;
  windowSeconds: number;
}
export interface AuthConfig {
  mailer: Mailer;
  /** Public URL of the web app, used in sign-in links and to check the Origin header, e.g. https://app.example */
  appOrigin: string;
  /** Extra allowed origins (local dev on 127.0.0.1 vs localhost). */
  extraOrigins?: string[];
  rateLimits?: Partial<Record<'linkPerEmail' | 'linkPerIp' | 'verifyPerIp', RateLimit>>;
}

const DEFAULT_LIMITS = {
  linkPerEmail: { max: 5, windowSeconds: 15 * 60 },
  linkPerIp: { max: 30, windowSeconds: 15 * 60 },
  verifyPerIp: { max: 30, windowSeconds: 15 * 60 },
};

const emailBody = z.object({ email: z.email('Enter a valid email').trim().toLowerCase().max(254) });
const tokenBody = z.object({ token: z.string().min(20).max(200) });
const tenantBody = z.object({ tenantId: z.uuid() });

const isHttps = (c: Context) =>
  new URL(c.req.url).protocol === 'https:' || c.req.header('x-forwarded-proto') === 'https';
/** __Host- prefix (HTTPS only) pins the cookie to this exact host and path. */
const cookieName = (c: Context) => (isHttps(c) ? '__Host-lse_session' : 'lse_session');
const clientIp = (c: Context) =>
  c.req.header('cf-connecting-ip') ?? c.req.header('x-real-ip') ?? 'unknown';

async function hit(sql: Sql, key: string, limit: RateLimit) {
  const [row] = await sql<
    { ok: boolean }[]
  >`SELECT rate_limit_hit(${key}, ${limit.windowSeconds}, ${limit.max}) AS ok`;
  if (!row?.ok)
    throw new AppError(
      429,
      'rate_limited',
      'Too many attempts. Please wait a few minutes and try again.',
    );
}

export interface SessionInfo {
  idHash: string;
  userId: string;
  tenantId: string | null;
  role: Auth['role'] | null;
  csrfToken: string;
}

export async function readSession(c: Context, sql: Sql): Promise<SessionInfo | null> {
  const raw = getCookie(c, cookieName(c));
  if (!raw || raw.length > 200) return null;
  const idHash = await sha256Hex(raw);
  const [row] = await sql<
    { userId: string; tenantId: string | null; role: Auth['role'] | null; csrfToken: string }[]
  >`
    SELECT * FROM auth_session(${idHash}, ${SESSION_TTL_SECONDS})`;
  return row ? { idHash, ...row } : null;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * CSRF defence in depth:
 * 1. SameSite=Lax cookie (not sent on cross-site POSTs).
 * 2. If an Origin header is present it must be our app's origin.
 * 3. Every mutating request must echo the session's CSRF token in X-CSRF-Token.
 */
export function checkCsrf(c: Context, cfg: AuthConfig, session: SessionInfo | null) {
  if (!MUTATING.has(c.req.method)) return;
  const origin = c.req.header('origin');
  const allowed = [cfg.appOrigin, ...(cfg.extraOrigins ?? [])];
  if (origin && !allowed.includes(origin))
    throw new AppError(403, 'bad_origin', 'Request blocked: it did not come from the app.');
  if (session) {
    const sent = c.req.header('x-csrf-token') ?? '';
    if (!safeEqual(sent, session.csrfToken))
      throw new AppError(403, 'csrf', 'Your session needs refreshing. Please reload the page.');
  }
}

/** Public auth routes. Mounted before the authenticated /api/* middleware. */
export function mountAuthRoutes(app: Hono<AppEnv>, getSql: (c: Context) => Sql, cfg: AuthConfig) {
  const limits = { ...DEFAULT_LIMITS, ...cfg.rateLimits };

  app.post('/api/auth/request-link', async (c) => {
    checkCsrf(c, cfg, null);
    const sql = getSql(c);
    const { email } = parse(emailBody, await jsonBody(c.req));
    await hit(sql, `link:ip:${clientIp(c)}`, limits.linkPerIp);
    await hit(sql, `link:email:${email}`, limits.linkPerEmail);
    const token = randomToken(32);
    const [row] = await sql<{ userId: string | null }[]>`
      SELECT auth_issue_login_token(${email}, ${await sha256Hex(token)}, ${LINK_TTL_SECONDS}) AS user_id`;
    if (row?.userId) {
      // The token travels in the URL fragment: it never reaches server logs or proxies.
      await cfg.mailer.sendMagicLink({
        to: email,
        link: `${cfg.appOrigin}/sign-in/verify#token=${token}`,
        expiresInMinutes: LINK_TTL_SECONDS / 60,
      });
    }
    // Same answer whether or not the email is known, so addresses can't be probed.
    return c.json(
      { ok: true, message: 'If that email belongs to an account, a sign-in link is on its way.' },
      202,
    );
  });

  app.post('/api/auth/verify', async (c) => {
    checkCsrf(c, cfg, null);
    const sql = getSql(c);
    await hit(sql, `verify:ip:${clientIp(c)}`, limits.verifyPerIp);
    const { token } = parse(tokenBody, await jsonBody(c.req));
    const sessionToken = randomToken(32);
    const csrfToken = randomToken(24);
    const [row] = await sql<{ userId: string | null }[]>`
      SELECT auth_redeem_login_token(${await sha256Hex(token)}, ${await sha256Hex(sessionToken)}, ${csrfToken},
                                     ${c.req.header('user-agent') ?? null}, ${SESSION_TTL_SECONDS}) AS user_id`;
    if (!row?.userId) {
      throw new AppError(
        400,
        'link_invalid',
        'This sign-in link has expired or was already used. Ask for a new one.',
      );
    }
    setCookie(c, cookieName(c), sessionToken, {
      httpOnly: true,
      secure: isHttps(c),
      sameSite: 'Lax',
      path: '/',
      maxAge: SESSION_TTL_SECONDS,
    });
    return c.json({ ok: true, csrfToken });
  });

  app.post('/api/auth/logout', async (c) => {
    const sql = getSql(c);
    const session = await readSession(c, sql);
    checkCsrf(c, cfg, session);
    if (session) await sql`SELECT auth_end_session(${session.idHash})`;
    deleteCookie(c, cookieName(c), { path: '/', secure: isHttps(c) });
    return c.body(null, 204);
  });

  /** Who am I, which businesses can I use, and the CSRF token for this session. */
  app.get('/api/auth/session', async (c) => {
    const sql = getSql(c);
    const session = await readSession(c, sql);
    if (!session) throw new AppError(401, 'unauthenticated', 'Please sign in');
    const data = await withUser(sql, session.userId, async (tx) => {
      const [user] = await tx<
        { id: string; name: string; email: string }[]
      >`SELECT id, name, email FROM users WHERE id = ${session.userId}`;
      const memberships = await tx<{ tenantId: string; tenantName: string; role: string }[]>`
        SELECT m.tenant_id, t.name AS tenant_name, m.role
          FROM memberships m JOIN tenants t ON t.id = m.tenant_id
         WHERE m.user_id = ${session.userId} ORDER BY t.name`;
      return { user, memberships };
    });
    return c.json({
      ...data,
      tenantId: session.tenantId,
      role: session.role,
      csrfToken: session.csrfToken,
    });
  });

  app.post('/api/auth/switch-tenant', async (c) => {
    const sql = getSql(c);
    const session = await readSession(c, sql);
    if (!session) throw new AppError(401, 'unauthenticated', 'Please sign in');
    checkCsrf(c, cfg, session);
    const { tenantId } = parse(tenantBody, await jsonBody(c.req));
    const [row] = await sql<
      { ok: boolean }[]
    >`SELECT auth_switch_tenant(${session.idHash}, ${tenantId}) AS ok`;
    if (!row?.ok) throw new AppError(403, 'forbidden', 'You do not have access to this business');
    return c.json({ ok: true, tenantId });
  });
}
