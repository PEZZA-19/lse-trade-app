import type { ApiErrorBody } from '@lse/shared';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly fields: Record<string, string> = {},
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
  get isNetwork() {
    return this.code === 'network';
  }
}

/* ------------------------------- session ------------------------------- */

let csrfToken: string | null = null;
/** Remembered from GET /auth/session or POST /auth/verify; sent on every change. */
export const setCsrfToken = (t: string | null) => {
  csrfToken = t;
};

/** Fired when the server says the session is gone, so the app can show the sign-in screen. */
export const SIGNED_OUT_EVENT = 'lse:signed-out';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface RequestOptions {
  idempotencyKey?: string;
  /** Row version the edit was made from; the server refuses with 409 if it has moved on. */
  ifMatch?: number;
  signal?: AbortSignal;
}

/**
 * Thin fetch wrapper. Errors are always ApiError with a plain-English message.
 * A network failure says clearly that nothing was saved, never pretending otherwise.
 */
export async function api<T>(
  method: string,
  path: string,
  body?: unknown,
  opts: RequestOptions = {},
  retried = false,
): Promise<T> {
  if (import.meta.env.VITE_DEMO === '1') {
    // Static preview build: an in-browser stand-in for the API (see src/demo/mockApi.ts).
    const { handle } = await import('../demo/mockApi');
    return (await handle(
      method,
      path,
      body,
      opts.ifMatch ? { 'if-match': String(opts.ifMatch) } : {},
    )) as T;
  }
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
  if (opts.ifMatch !== undefined) headers['if-match'] = `"${opts.ifMatch}"`;
  if (MUTATING.has(method) && csrfToken) headers['x-csrf-token'] = csrfToken;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: opts.signal ?? null,
      credentials: 'same-origin',
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, 'network', 'No connection. Nothing was saved.');
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    const err = (data as ApiErrorBody | null)?.error;
    if (res.status === 401 && !path.startsWith('/auth/')) {
      window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
    }
    // Stale CSRF token (e.g. signed in on another tab): refresh it once and retry.
    // Safe to retry: the server rejected the request before doing anything.
    if (res.status === 403 && err?.code === 'csrf' && !retried) {
      const s = await api<{ csrfToken: string }>('GET', '/auth/session');
      setCsrfToken(s.csrfToken);
      return api<T>(method, path, body, opts, true);
    }
    const fields = ((err?.details as { fields?: Record<string, string> } | undefined)?.fields ??
      {}) as Record<string, string>;
    throw new ApiError(
      res.status,
      err?.code ?? 'http_error',
      err?.message ?? `Request failed (${res.status})`,
      fields,
      err?.details,
    );
  }
  return data as T;
}

export const newIdempotencyKey = () => `web-${crypto.randomUUID()}`;
