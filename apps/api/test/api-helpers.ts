/* eslint-disable @typescript-eslint/no-explicit-any */
import { createApp } from '../src/app';
import { AiGateway } from '../src/ai/gateway';
import { FakeProvider } from '../src/ai/fake';
import { DEFAULT_ORIGIN, signIn, type SessionClient } from '../src/dev/session-client';
import { ConsoleMailer } from '../src/lib/mailer';
import { FakeCalendar } from '../src/dev/fakeCalendar';
import { appSql, newTenant } from './helpers';

export interface Client {
  tenantId: string;
  userId: string;
  email: string;
  session: SessionClient;
  req: <T = any>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) => Promise<{ status: number; body: T; headers: Headers }>;
}

/** Captures sign-in links instead of emailing them. */
export const mailer = new ConsoleMailer(() => {});
const generous = { max: 10_000, windowSeconds: 60 };
/** The deterministic stand-in model; no test ever calls a real one. */
export const fakeAi = new FakeProvider();
/** In-memory Google calendar for the two-way sync tests. */
export const fakeCalendar = new FakeCalendar();
export const app = createApp({
  getSql: () => appSql,
  auth: {
    mailer,
    appOrigin: DEFAULT_ORIGIN,
    rateLimits: { linkPerIp: generous, verifyPerIp: generous },
  },
  ai: new AiGateway(fakeAi),
  calendarLimits: { perIp: generous, perFeed: generous },
  calendarAdapters: { google: fakeCalendar },
});

export async function toResult(res: Response) {
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

/** Signs in through the real magic-link flow and returns a client bound to that session. */
export async function clientFor(
  email: string,
  ids: { tenantId: string; userId: string },
): Promise<Client> {
  const session = await signIn(app, mailer, email);
  return {
    ...ids,
    email,
    session,
    req: async (method, path, body, headers) =>
      toResult(await session.request(method, path, body, headers)),
  };
}

/** A new business (complete details unless `incomplete`), signed in as its owner. */
export async function client(
  opts: { nextJobNumber?: number; incomplete?: boolean } = {},
): Promise<Client> {
  const t = await newTenant(opts);
  return clientFor(t.ownerEmail, t);
}

export async function rawRequest(path: string, init: RequestInit) {
  return app.request(path, init);
}

/** A customer with one site, ready for quotes and jobs. */
export async function seedCustomer(c: Client, overrides: Record<string, unknown> = {}) {
  const r = await c.req('POST', '/api/customers', {
    name: 'Seigneurie Farm',
    email: 'Farm@Example.com',
    sites: [{ label: 'Barn', address: 'La Seigneurie, Sark' }],
    ...overrides,
  });
  if (r.status !== 201) throw new Error(`seedCustomer failed: ${JSON.stringify(r.body)}`);
  return r.body;
}
