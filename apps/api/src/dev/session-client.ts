// Signs in through the real magic-link flow against an in-process app. Used by the seed script and tests,
// so they exercise exactly the same cookie + CSRF path as the browser (no back door).
import type { Hono } from 'hono';
import type { ConsoleMailer } from '../lib/mailer';
import type { AppEnv } from '../lib/types';

export interface SessionClient {
  request: (
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) => Promise<Response>;
  cookie: string;
  csrfToken: string;
}

export const DEFAULT_ORIGIN = 'http://app.test';

export async function signIn(
  app: Hono<AppEnv>,
  mailer: ConsoleMailer,
  email: string,
  opts: { origin?: string; ip?: string } = {},
): Promise<SessionClient> {
  const origin = opts.origin ?? DEFAULT_ORIGIN;
  const base = {
    'content-type': 'application/json',
    origin,
    'cf-connecting-ip': opts.ip ?? '203.0.113.1',
  };
  const before = mailer.sent.length;
  const r1 = await app.request('/api/auth/request-link', {
    method: 'POST',
    headers: base,
    body: JSON.stringify({ email }),
  });
  if (r1.status !== 202) throw new Error(`request-link: ${r1.status} ${await r1.text()}`);
  const mail = mailer.sent.slice(before).find((m) => m.to === email.toLowerCase());
  if (!mail) throw new Error(`No sign-in link was issued for ${email}`);
  const token = new URL(mail.link).hash.replace('#token=', '');
  const r2 = await app.request('/api/auth/verify', {
    method: 'POST',
    headers: base,
    body: JSON.stringify({ token }),
  });
  if (r2.status !== 200) throw new Error(`verify: ${r2.status} ${await r2.text()}`);
  const cookie = (r2.headers.get('set-cookie') ?? '').split(';')[0]!;
  const { csrfToken } = (await r2.json()) as { csrfToken: string };
  return {
    cookie,
    csrfToken,
    request: async (method, path, body, headers = {}) =>
      app.request(path, {
        method,
        headers: { ...base, cookie, 'x-csrf-token': csrfToken, ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
  };
}
