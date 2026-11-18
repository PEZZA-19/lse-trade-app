/**
 * Google Calendar for the two-way sync: OAuth sign-in (authorization code + PKCE, offline access so
 * we get a refresh token) and the CalendarAdapter the sync engine runs against.
 *
 * Scope: `calendar.app.created` only ("make secondary calendars and manage events on them"): the app
 * makes its own "LSE jobs" calendar and can never see or touch the person's other calendars. Plus
 * `openid email` to show which Google account is connected.
 *
 * Nothing here runs until a Google Cloud OAuth client exists (docs/GOOGLE_CALENDAR_SETUP.md):
 * googleFromEnv() returns null and the app says "needs setting up". Tests use dev/fakeGoogle.ts.
 */
import { SYNC_CALENDAR_NAME, type CalendarEventBody, type RemoteChange } from '@lse/shared';
import { seal, sealingKey, unseal } from '../lib/sealed';
import type { CalendarAdapter, CalendarConnection } from './calendarSync';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_API = 'https://www.googleapis.com/calendar/v3';
export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.app.created',
];

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  /** Must match an "Authorised redirect URI" on the OAuth client exactly. */
  redirectUri: string;
  /** Seals refresh tokens (CALENDAR_TOKEN_KEY). */
  key: CryptoKey;
  timeZone?: string;
  /** Injected in tests (fake Google); the real fetch otherwise. */
  fetch?: typeof fetch;
}

/** Google won't let us in any more (access removed, token revoked, calendar deleted): reconnect. */
export class CalendarAuthError extends Error {}
/** Google answered with something unexpected (outage, quota): try again later. */
export class CalendarApiError extends Error {}

interface Sealed {
  refreshToken: string;
}

export class GoogleCalendar implements CalendarAdapter {
  readonly name = 'google';
  private cache = new Map<string, { token: string; until: number }>();
  constructor(private cfg: GoogleConfig) {}

  private get f() {
    return this.cfg.fetch ?? fetch;
  }

  /** Where to send the person to sign in and allow access. */
  authUrl(state: string, codeChallenge: string): string {
    const q = new URLSearchParams({
      client_id: this.cfg.clientId,
      redirect_uri: this.cfg.redirectUri,
      response_type: 'code',
      scope: GOOGLE_SCOPES.join(' '),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      access_type: 'offline',
      // Always ask, so Google always gives a refresh token (also on a reconnect).
      prompt: 'consent',
    });
    return `${GOOGLE_AUTH_URL}?${q}`;
  }

  private async token(params: Record<string, string>) {
    const res = await this.f(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        ...params,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      if (body.error === 'invalid_grant')
        throw new CalendarAuthError(
          'Google no longer allows access (it was removed in the Google account, or it expired). Connect again.',
        );
      throw new CalendarApiError(
        `Google sign-in failed (${res.status} ${String(body.error ?? '')}).`,
      );
    }
    return body as {
      access_token: string;
      expires_in?: number;
      refresh_token?: string;
      id_token?: string;
      scope?: string;
    };
  }

  /** After the redirect: swaps the code for tokens. Checks the calendar scope was really granted. */
  async exchange(code: string, codeVerifier: string) {
    const t = await this.token({
      grant_type: 'authorization_code',
      code,
      code_verifier: codeVerifier,
      redirect_uri: this.cfg.redirectUri,
    });
    if (!t.refresh_token)
      throw new CalendarApiError(
        'Google didn’t give long-term access. Please try connecting again.',
      );
    if (t.scope && !t.scope.split(' ').includes(GOOGLE_SCOPES[2]!))
      throw new CalendarAuthError(
        'Calendar access wasn’t allowed. Tick the calendar box on Google’s screen and try again.',
      );
    return {
      refreshToken: t.refresh_token,
      accessToken: t.access_token,
      expiresIn: t.expires_in ?? 3600,
      email: emailFromIdToken(t.id_token),
    };
  }

  /** Seals the refresh token for the database, bound to the person. */
  sealToken(refreshToken: string, userId: string): Promise<string> {
    return seal(
      this.cfg.key,
      JSON.stringify({ refreshToken } satisfies Sealed),
      `calendar:${userId}`,
    );
  }

  private async accessToken(conn: CalendarConnection, fresh = false): Promise<string> {
    const hit = this.cache.get(conn.id);
    if (!fresh && hit && hit.until > Date.now()) return hit.token;
    let sealed: Sealed;
    try {
      sealed = JSON.parse(await unseal(this.cfg.key, conn.tokenEnc, `calendar:${conn.userId}`));
    } catch {
      throw new CalendarAuthError('The saved Google access can’t be read any more. Connect again.');
    }
    const t = await this.token({ grant_type: 'refresh_token', refresh_token: sealed.refreshToken });
    this.cache.set(conn.id, {
      token: t.access_token,
      until: Date.now() + Math.max(60, (t.expires_in ?? 3600) - 120) * 1000,
    });
    return t.access_token;
  }

  /** One Calendar API call with the connection's access token (refreshed once on a 401). */
  private async api(
    conn: CalendarConnection | { token: string },
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const call = async (token: string) =>
      this.f(`${GOOGLE_API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    if ('token' in conn) return call(conn.token);
    let res = await call(await this.accessToken(conn));
    if (res.status === 401) res = await call(await this.accessToken(conn, true));
    if (res.status === 401 || res.status === 403)
      throw new CalendarAuthError('Google refused access to the LSE jobs calendar. Connect again.');
    return res;
  }

  /** Makes the dedicated "LSE jobs" calendar in the person's account; returns its id. */
  async createCalendar(accessToken: string): Promise<string> {
    const res = await this.api({ token: accessToken }, 'POST', '/calendars', {
      summary: SYNC_CALENDAR_NAME,
      description:
        'Booked jobs from LSE Trade. Moving or deleting an event here asks for approval in the app.',
      timeZone: this.cfg.timeZone ?? 'Europe/Guernsey',
    });
    if (!res.ok) throw new CalendarApiError(`Google couldn’t make the calendar (${res.status}).`);
    return ((await res.json()) as { id: string }).id;
  }

  /** On a reconnect: is the calendar we made last time still there? */
  async calendarExists(accessToken: string, calendarId: string): Promise<boolean> {
    const res = await this.api(
      { token: accessToken },
      'GET',
      `/calendars/${encodeURIComponent(calendarId)}`,
    );
    return res.ok;
  }

  private events(conn: CalendarConnection) {
    return `/calendars/${encodeURIComponent(conn.calendarId)}/events`;
  }

  private eventJson(body: CalendarEventBody) {
    const tz = this.cfg.timeZone ?? 'Europe/Guernsey';
    return {
      summary: body.title,
      description: body.description,
      location: body.location ?? undefined,
      start: { dateTime: body.startsAt, timeZone: tz },
      end: { dateTime: body.endsAt, timeZone: tz },
      extendedProperties: { private: { lseId: body.lseId } },
    };
  }

  async upsert(conn: CalendarConnection, body: CalendarEventBody, remoteId: string | null) {
    if (remoteId) {
      const res = await this.api(
        conn,
        'PUT',
        `${this.events(conn)}/${encodeURIComponent(remoteId)}`,
        this.eventJson(body),
      );
      if (res.ok) {
        const e = (await res.json()) as { id: string; etag?: string };
        return { remoteId: e.id, etag: e.etag ?? null };
      }
      // Gone from the calendar: make it again below.
      if (res.status !== 404 && res.status !== 410) throw await apiError(res, conn);
    }
    const res = await this.api(conn, 'POST', this.events(conn), this.eventJson(body));
    if (!res.ok) throw await apiError(res, conn);
    const e = (await res.json()) as { id: string; etag?: string };
    return { remoteId: e.id, etag: e.etag ?? null };
  }

  async remove(conn: CalendarConnection, remoteId: string) {
    const res = await this.api(
      conn,
      'DELETE',
      `${this.events(conn)}/${encodeURIComponent(remoteId)}`,
    );
    if (!res.ok && res.status !== 404 && res.status !== 410) throw await apiError(res, conn);
  }

  /** Incremental sync with Google's sync token; a full read when there is none or it expired. */
  async changes(conn: CalendarConnection, syncToken: string | null) {
    const read = async (token: string | null) => {
      const out: RemoteChange[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < 100; page++) {
        const q = new URLSearchParams({
          showDeleted: 'true',
          singleEvents: 'true',
          maxResults: '250',
        });
        if (token) q.set('syncToken', token);
        if (pageToken) q.set('pageToken', pageToken);
        const res = await this.api(conn, 'GET', `${this.events(conn)}?${q}`);
        if (res.status === 410) return null; // sync token expired: start again from scratch
        if (!res.ok) throw await apiError(res, conn);
        const body = (await res.json()) as {
          items?: GoogleEvent[];
          nextPageToken?: string;
          nextSyncToken?: string;
        };
        for (const e of body.items ?? []) out.push(toChange(e));
        if (body.nextPageToken) {
          pageToken = body.nextPageToken;
          continue;
        }
        return { changes: out, nextSyncToken: body.nextSyncToken ?? null };
      }
      throw new CalendarApiError('Too many pages from Google; try again later.');
    };
    return (await read(syncToken)) ?? (await read(null))!;
  }
}

interface GoogleEvent {
  id: string;
  etag?: string;
  status?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  extendedProperties?: { private?: Record<string, string> };
}

function toChange(e: GoogleEvent): RemoteChange {
  const cancelled = e.status === 'cancelled';
  const at = (x?: { dateTime?: string }) =>
    x?.dateTime ? new Date(x.dateTime).toISOString() : null;
  return {
    remoteId: e.id,
    lseId: e.extendedProperties?.private?.lseId ?? null,
    etag: e.etag ?? null,
    cancelled,
    // An all-day event has no times: the planner treats it as made by hand unless it's ours.
    startsAt: cancelled ? null : at(e.start),
    endsAt: cancelled ? null : at(e.end),
  };
}

async function apiError(res: Response, _conn: CalendarConnection) {
  // Events that are gone are handled by the callers; a 404 here means the calendar itself.
  if (res.status === 404)
    return new CalendarAuthError(
      'The LSE jobs calendar was deleted in Google. Connect again to make a new one.',
    );
  return new CalendarApiError(
    `Google Calendar answered ${res.status}; the sync will try again later.`,
  );
}

/** The email in Google's ID token (from Google's own token endpoint over TLS, so not re-verified). */
export function emailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  try {
    const part = idToken.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(atob(part + '='.repeat((4 - (part.length % 4)) % 4))) as {
      email?: string;
    };
    return typeof json.email === 'string' ? json.email.slice(0, 320) : null;
  } catch {
    return null;
  }
}

export interface GoogleEnv {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** 32 random bytes, base64 (`openssl rand -base64 32`). Seals refresh tokens. */
  CALENDAR_TOKEN_KEY?: string;
  /** Optional: defaults to <APP_ORIGIN>/api/calendar-sync/google/callback. */
  GOOGLE_REDIRECT_URI?: string;
}

/**
 * The Google connection when all of client id, client secret and token key are set; otherwise
 * null with the reason, and the app says "needs setting up". A bad key fails loudly here.
 */
export async function googleFromEnv(
  env: GoogleEnv,
  appOrigin: string,
  f?: typeof fetch,
): Promise<{ google: GoogleCalendar | null; missing: string[] }> {
  const missing = (
    ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'CALENDAR_TOKEN_KEY'] as const
  ).filter((k) => !env[k]?.trim());
  if (missing.length) return { google: null, missing };
  return {
    google: new GoogleCalendar({
      clientId: env.GOOGLE_CLIENT_ID!.trim(),
      clientSecret: env.GOOGLE_CLIENT_SECRET!.trim(),
      redirectUri:
        env.GOOGLE_REDIRECT_URI?.trim() ||
        `${appOrigin.replace(/\/$/, '')}/api/calendar-sync/google/callback`,
      key: await sealingKey(env.CALENDAR_TOKEN_KEY!),
      ...(f ? { fetch: f } : {}),
    }),
    missing: [],
  };
}
