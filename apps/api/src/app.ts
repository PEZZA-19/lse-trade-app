import {
  contactInput,
  customerCreate,
  customerUpdate,
  jobCreate,
  jobStatus,
  jobUpdate,
  listQuery,
  quoteAccept,
  quoteCreate,
  quoteRevisionUpdate,
  quoteStatus,
  siteInput,
  settingsUpdate,
  type ApiErrorBody,
} from '@lse/shared';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import { checkCsrf, mountAuthRoutes, readSession, type AuthConfig } from './auth';
import { withTenant, type Sql } from './db/client';
import { AppError, notFound } from './lib/errors';
import { idempotent } from './lib/idempotency';
import type { AppEnv, Auth } from './lib/types';
import { isUuid, jsonBody, parse } from './lib/validate';
import * as customers from './services/customers';
import * as jobs from './services/jobs';
import * as quotes from './services/quotes';
import * as settings from './services/settings';

export interface AppDeps {
  /** Returns a Postgres client for this request (a shared pool in Node, per-request on Workers). */
  getSql: (c: Context) => Sql;
  /** Magic-link sign-in, sessions and CSRF (see auth.ts). */
  auth: AuthConfig;
  corsOrigins?: string[];
}

const uuidParam = (c: Context, name = 'id'): string => {
  const v = c.req.param(name);
  if (!v || !isUuid(v)) throw notFound('Record');
  return v;
};

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  app.onError((err, c) => {
    if (err instanceof AppError) {
      const body: ApiErrorBody = {
        error: { code: err.code, message: err.message, details: err.details },
      };
      return c.json(body, err.status);
    }
    console.error(err);
    const body: ApiErrorBody = {
      error: { code: 'internal', message: 'Something went wrong. Please try again.' },
    };
    return c.json(body, 500);
  });
  app.notFound((c) =>
    c.json(
      { error: { code: 'not_found', message: 'No such endpoint' } } satisfies ApiErrorBody,
      404,
    ),
  );

  if (deps.corsOrigins?.length) {
    app.use(
      '/api/*',
      cors({
        origin: deps.corsOrigins,
        allowHeaders: ['Content-Type', 'Idempotency-Key', 'X-CSRF-Token'],
        credentials: true,
      }),
    );
  }

  app.get('/api/health', (c) => c.json({ ok: true }));

  /* ------------------------------ auth ------------------------------ */
  mountAuthRoutes(app, deps.getSql, deps.auth);

  // Everything else under /api needs a live session with a business selected.
  app.use('/api/*', async (c, next) => {
    const sql = deps.getSql(c);
    c.set('sql', sql);
    const session = await readSession(c, sql);
    if (!session) throw new AppError(401, 'unauthenticated', 'Please sign in');
    checkCsrf(c, deps.auth, session);
    if (!session.tenantId || !session.role) {
      throw new AppError(403, 'forbidden', 'You do not have access to this business');
    }
    const auth: Auth = { userId: session.userId, tenantId: session.tenantId, role: session.role };
    c.set('auth', auth);
    c.set('tx', (fn) => withTenant(sql, auth, fn));
    await next();
  });

  /* ----------------------------- settings ---------------------------- */
  app.get('/api/settings', async (c) => c.json(await c.var.tx((tx) => settings.getSettings(tx))));
  app.get('/api/settings/readiness', async (c) =>
    c.json(await c.var.tx((tx) => settings.getReadiness(tx))),
  );
  app.patch('/api/settings', async (c) => {
    if (c.var.auth.role !== 'owner') {
      throw new AppError(403, 'forbidden', 'Only the business owner can change settings');
    }
    const input = parse(settingsUpdate, await jsonBody(c.req));
    return c.json(await c.var.tx((tx) => settings.updateSettings(tx, c.var.auth, input)));
  });

  /* ------------------------------- me ------------------------------- */
  app.get('/api/me', async (c) => {
    const auth = c.var.auth;
    const data = await c.var.tx(async (tx) => {
      const [user] = await tx<
        { id: string; name: string; email: string }[]
      >`SELECT id, name, email FROM users WHERE id = ${auth.userId}`;
      const [tenant] =
        await tx`SELECT id, name, default_markup_bp, labour_rate_pence, quote_valid_days, timezone, currency FROM tenants WHERE id = app_current_tenant()`;
      return { user, tenant, role: auth.role };
    });
    return c.json(data);
  });

  /* ---------------------------- customers --------------------------- */
  app.get('/api/customers', async (c) => {
    const q = parse(listQuery, c.req.query());
    return c.json(await c.var.tx((tx) => customers.listCustomers(tx, q)));
  });
  app.post('/api/customers', async (c) => {
    const input = parse(customerCreate, await jsonBody(c.req));
    return c.json(await c.var.tx((tx) => customers.createCustomer(tx, c.var.auth, input)), 201);
  });
  app.get('/api/customers/:id', async (c) => {
    const id = uuidParam(c);
    return c.json(await c.var.tx((tx) => customers.getCustomer(tx, id)));
  });
  app.patch('/api/customers/:id', async (c) => {
    const id = uuidParam(c);
    const input = parse(customerUpdate, await jsonBody(c.req));
    return c.json(await c.var.tx((tx) => customers.updateCustomer(tx, c.var.auth, id, input)));
  });
  app.post('/api/customers/:id/sites', async (c) => {
    const id = uuidParam(c);
    const input = parse(siteInput, await jsonBody(c.req));
    return c.json(await c.var.tx((tx) => customers.addSite(tx, c.var.auth, id, input)), 201);
  });
  app.patch('/api/sites/:id', async (c) => {
    const id = uuidParam(c);
    const input = parse(siteInput.partial(), await jsonBody(c.req));
    return c.json(await c.var.tx((tx) => customers.updateSite(tx, c.var.auth, id, input)));
  });

  app.post('/api/customers/:id/contacts', async (c) => {
    const id = uuidParam(c);
    const input = parse(contactInput, await jsonBody(c.req));
    return c.json(await c.var.tx((tx) => customers.addContact(tx, c.var.auth, id, input)), 201);
  });
  app.patch('/api/contacts/:id', async (c) => {
    const id = uuidParam(c);
    const input = parse(contactInput.partial(), await jsonBody(c.req));
    return c.json(await c.var.tx((tx) => customers.updateContact(tx, c.var.auth, id, input)));
  });
  app.delete('/api/contacts/:id', async (c) => {
    const id = uuidParam(c);
    await c.var.tx((tx) => customers.deleteContact(tx, c.var.auth, id));
    return c.body(null, 204);
  });

  /* ------------------------------ quotes ---------------------------- */
  const quoteListQuery = listQuery.extend({
    status: quoteStatus.optional(),
    customerId: z.uuid().optional(),
  });
  app.get('/api/quotes', async (c) => {
    const q = parse(quoteListQuery, c.req.query());
    return c.json(await c.var.tx((tx) => quotes.listQuotes(tx, q)));
  });
  app.post('/api/quotes', async (c) => {
    const input = parse(quoteCreate, await jsonBody(c.req));
    return c.json(await c.var.tx((tx) => quotes.createQuote(tx, c.var.auth, input)), 201);
  });
  app.get('/api/quotes/:id', async (c) => {
    const id = uuidParam(c);
    return c.json(await c.var.tx((tx) => quotes.getQuote(tx, id)));
  });
  app.patch('/api/quotes/:id', async (c) => {
    const id = uuidParam(c);
    const input = parse(quoteRevisionUpdate, await jsonBody(c.req));
    return c.json(await c.var.tx((tx) => quotes.updateQuote(tx, c.var.auth, id, input)));
  });
  app.post('/api/quotes/:id/send', async (c) => {
    const id = uuidParam(c);
    return c.json(await c.var.tx((tx) => quotes.markSent(tx, c.var.auth, id)));
  });
  app.post('/api/quotes/:id/revise', async (c) => {
    const id = uuidParam(c);
    return c.json(await c.var.tx((tx) => quotes.revise(tx, c.var.auth, id)), 201);
  });
  app.post('/api/quotes/:id/accept', async (c) => {
    const id = uuidParam(c);
    const body =
      c.req.header('content-length') === '0' ? {} : await jsonBody(c.req).catch(() => ({}));
    const input = parse(quoteAccept, body ?? {});
    return c.json(await c.var.tx((tx) => quotes.accept(tx, c.var.auth, id, input.acceptedOptions)));
  });
  app.post('/api/quotes/:id/decline', async (c) => {
    const id = uuidParam(c);
    return c.json(await c.var.tx((tx) => quotes.decline(tx, c.var.auth, id)));
  });
  app.post('/api/quotes/:id/convert', async (c) => {
    const id = uuidParam(c);
    const key = c.req.header('idempotency-key');
    const result = await c.var.tx((tx) =>
      idempotent(tx, c.var.auth, key, `convert:${id}`, async () => {
        const { jobId } = await quotes.convertToJob(tx, c.var.auth, id);
        return { status: 201, body: await jobs.getJob(tx, jobId) };
      }),
    );
    if (result.replayed) c.header('Idempotent-Replayed', 'true');
    return c.json(result.body, result.status as 201);
  });

  /* ------------------------------- jobs ----------------------------- */
  const jobListQuery = listQuery.extend({
    status: jobStatus.optional(),
    active: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
    customerId: z.uuid().optional(),
  });
  app.get('/api/jobs', async (c) => {
    const q = parse(jobListQuery, c.req.query());
    return c.json(await c.var.tx((tx) => jobs.listJobs(tx, q)));
  });
  app.post('/api/jobs', async (c) => {
    const input = parse(jobCreate, await jsonBody(c.req));
    return c.json(await c.var.tx((tx) => jobs.createJob(tx, c.var.auth, input)), 201);
  });
  app.get('/api/jobs/:id', async (c) => {
    const id = uuidParam(c);
    return c.json(await c.var.tx((tx) => jobs.getJob(tx, id)));
  });
  app.patch('/api/jobs/:id', async (c) => {
    const id = uuidParam(c);
    const input = parse(jobUpdate, await jsonBody(c.req));
    return c.json(await c.var.tx((tx) => jobs.updateJob(tx, c.var.auth, id, input)));
  });

  return app;
}
