/**
 * A fake of the parts of Google the calendar sync uses, as a `fetch`: the OAuth token endpoint
 * (authorization code + PKCE S256, refresh tokens, revocation), calendars.insert/get and
 * events insert/update/delete/list with sync tokens, paging and 410 for expired tokens.
 * Tests and local development only: nothing here talks to Google.
 */
interface FakeEvent {
  id: string;
  etag: number;
  status: 'confirmed' | 'cancelled';
  summary: string;
  description?: string;
  location?: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  extendedProperties?: { private?: Record<string, string> };
  /** Position in the calendar's change log. */
  seq: number;
}
interface FakeCal {
  id: string;
  summary: string;
  timeZone: string;
  events: Map<string, FakeEvent>;
  seq: number;
  deleted: boolean;
}

const b64url = (bytes: Uint8Array) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export class FakeGoogle {
  readonly clientId = 'fake-client.apps.googleusercontent.com';
  readonly clientSecret = 'fake-secret';
  calendars = new Map<string, FakeCal>();
  /** Every request, for assertions (method and path, never bodies). */
  requests: string[] = [];
  /** Events per list page (small, so paging is exercised). */
  pageSize = 2;
  /** Sync tokens older than this sequence are "expired" (410). */
  expireTokensBefore = 0;
  private codes = new Map<
    string,
    { challenge: string; redirectUri: string; email: string; scope: string }
  >();
  private refresh = new Map<string, { email: string; revoked: boolean }>();
  private access = new Map<string, string>();
  private n = 0;

  /** The person signs in and allows access: returns the code Google would put on the redirect. */
  authorize(url: string, opts: { email?: string; scope?: string } = {}) {
    const u = new URL(url);
    const p = u.searchParams;
    if (u.origin + u.pathname !== 'https://accounts.google.com/o/oauth2/v2/auth')
      throw new Error(`not Google's sign-in page: ${u.origin}${u.pathname}`);
    if (p.get('client_id') !== this.clientId) throw new Error('unknown client');
    if (p.get('code_challenge_method') !== 'S256') throw new Error('PKCE S256 required');
    if (p.get('access_type') !== 'offline') throw new Error('offline access required');
    const code = `code-${++this.n}`;
    this.codes.set(code, {
      challenge: p.get('code_challenge')!,
      redirectUri: p.get('redirect_uri')!,
      email: opts.email ?? 'joe@example.com',
      scope: opts.scope ?? p.get('scope')!,
    });
    return { code, state: p.get('state')!, redirectUri: p.get('redirect_uri')! };
  }

  /** The person removes the app's access in their Google account. */
  revokeAll() {
    for (const r of this.refresh.values()) r.revoked = true;
    this.access.clear();
  }
  /** Every access token expires (forces a refresh). */
  expireAccessTokens() {
    this.access.clear();
  }

  private log(cal: FakeCal, e: FakeEvent) {
    e.seq = ++cal.seq;
    e.etag++;
  }
  /** Someone moves an event in Google Calendar. */
  move(calendarId: string, eventId: string, startsAt: string, endsAt: string) {
    const cal = this.calendars.get(calendarId)!;
    const e = cal.events.get(eventId)!;
    e.start = { dateTime: startsAt };
    e.end = { dateTime: endsAt };
    this.log(cal, e);
  }
  /** Someone deletes an event in Google Calendar. */
  remove(calendarId: string, eventId: string) {
    const cal = this.calendars.get(calendarId)!;
    const e = cal.events.get(eventId)!;
    e.status = 'cancelled';
    this.log(cal, e);
  }
  /** Someone adds their own all-day event. */
  addAllDay(calendarId: string, date: string) {
    const cal = this.calendars.get(calendarId)!;
    const e: FakeEvent = {
      id: `hand${++this.n}`,
      etag: 0,
      status: 'confirmed',
      summary: 'Holiday',
      start: { date },
      end: { date },
      seq: 0,
    };
    cal.events.set(e.id, e);
    this.log(cal, e);
  }
  live(calendarId: string) {
    return [...(this.calendars.get(calendarId)?.events.values() ?? [])].filter(
      (e) => e.status !== 'cancelled',
    );
  }

  private async tokenEndpoint(form: URLSearchParams) {
    if (form.get('client_id') !== this.clientId || form.get('client_secret') !== this.clientSecret)
      return json(401, { error: 'invalid_client' });
    if (form.get('grant_type') === 'authorization_code') {
      const c = this.codes.get(form.get('code') ?? '');
      this.codes.delete(form.get('code') ?? '');
      if (!c) return json(400, { error: 'invalid_grant' });
      if (form.get('redirect_uri') !== c.redirectUri)
        return json(400, { error: 'redirect_uri_mismatch' });
      const d = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(form.get('code_verifier') ?? ''),
      );
      if (b64url(new Uint8Array(d)) !== c.challenge) return json(400, { error: 'invalid_grant' });
      const refresh = `refresh-${++this.n}`;
      const access = `access-${++this.n}`;
      this.refresh.set(refresh, { email: c.email, revoked: false });
      this.access.set(access, c.email);
      const idToken = `x.${b64url(new TextEncoder().encode(JSON.stringify({ email: c.email })))}.y`;
      return json(200, {
        access_token: access,
        expires_in: 3599,
        refresh_token: refresh,
        id_token: idToken,
        scope: c.scope,
        token_type: 'Bearer',
      });
    }
    if (form.get('grant_type') === 'refresh_token') {
      const r = this.refresh.get(form.get('refresh_token') ?? '');
      if (!r || r.revoked) return json(400, { error: 'invalid_grant' });
      const access = `access-${++this.n}`;
      this.access.set(access, r.email);
      return json(200, { access_token: access, expires_in: 3599, token_type: 'Bearer' });
    }
    return json(400, { error: 'unsupported_grant_type' });
  }

  /** Use as `fetch`. */
  fetch: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const method = (init?.method ?? 'GET').toUpperCase();
    this.requests.push(`${method} ${url.pathname}`);
    if (url.href.startsWith('https://oauth2.googleapis.com/token'))
      return this.tokenEndpoint(new URLSearchParams(String(init?.body ?? '')));
    if (!url.href.startsWith('https://www.googleapis.com/calendar/v3/'))
      return json(404, { error: 'not faked' });
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    if (!this.access.has(auth.replace(/^Bearer /, ''))) return json(401, { error: 'unauthorized' });
    const path = url.pathname.replace('/calendar/v3', '').split('/').map(decodeURIComponent);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    // /calendars
    if (path.length === 2 && method === 'POST') {
      const cal: FakeCal = {
        id: `cal${++this.n}@group.calendar.google.com`,
        summary: body.summary,
        timeZone: body.timeZone,
        events: new Map(),
        seq: 0,
        deleted: false,
      };
      this.calendars.set(cal.id, cal);
      return json(200, { id: cal.id, summary: cal.summary, timeZone: cal.timeZone });
    }
    const cal = this.calendars.get(path[2] ?? '');
    if (!cal || cal.deleted) return json(404, { error: 'notFound' });
    if (path.length === 3 && method === 'GET')
      return json(200, { id: cal.id, summary: cal.summary });
    if (path[3] !== 'events') return json(404, { error: 'not faked' });
    const eventId = path[4];
    if (!eventId && method === 'POST') {
      const e: FakeEvent = { id: `ev${++this.n}`, etag: 0, status: 'confirmed', seq: 0, ...body };
      cal.events.set(e.id, e);
      this.log(cal, e);
      return json(200, { ...e, etag: `"${e.etag}"` });
    }
    if (eventId) {
      const e = cal.events.get(eventId);
      if (!e) return json(404, { error: 'notFound' });
      if (method === 'DELETE') {
        if (e.status === 'cancelled') return json(410, { error: 'deleted' });
        e.status = 'cancelled';
        this.log(cal, e);
        return new Response(null, { status: 204 });
      }
      if (method === 'PUT') {
        Object.assign(e, body, { status: 'confirmed' });
        this.log(cal, e);
        return json(200, { ...e, etag: `"${e.etag}"` });
      }
    }
    if (!eventId && method === 'GET') {
      const q = url.searchParams;
      const sync = q.get('syncToken');
      const from = sync ? Number(sync.replace('sync-', '')) : 0;
      if (sync && (!/^sync-\d+$/.test(sync) || from < this.expireTokensBefore))
        return json(410, { error: 'fullSyncRequired' });
      const all = [...cal.events.values()]
        .filter(
          (e) =>
            e.seq > from && (sync || e.status !== 'cancelled' || q.get('showDeleted') === 'true'),
        )
        .sort((a, b) => a.seq - b.seq);
      const offset = Number(q.get('pageToken') ?? 0);
      const page = all.slice(offset, offset + this.pageSize);
      const more = offset + this.pageSize < all.length;
      return json(200, {
        items: page.map((e) => ({ ...e, etag: `"${e.etag}"` })),
        ...(more
          ? { nextPageToken: String(offset + this.pageSize) }
          : { nextSyncToken: `sync-${cal.seq}` }),
      });
    }
    return json(404, { error: 'not faked' });
  };

  /** The person deletes the whole LSE jobs calendar in Google. */
  deleteCalendar(calendarId: string) {
    this.calendars.get(calendarId)!.deleted = true;
  }
}
