/* eslint-disable @typescript-eslint/no-explicit-any */
import { createApp } from '../src/app';
import { appSql, newTenant } from './helpers';

export interface Client {
  tenantId: string;
  userId: string;
  req: <T = any>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) => Promise<{ status: number; body: T; headers: Headers }>;
}

const app = createApp({ getSql: () => appSql, authMode: 'dev' });

export async function client(opts: { nextJobNumber?: number } = {}): Promise<Client> {
  const t = await newTenant(opts);
  return {
    ...t,
    async req(method, path, body, headers = {}) {
      const res = await app.request(path, {
        method,
        headers: { 'content-type': 'application/json', 'x-user-id': t.userId, ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
    },
  };
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
