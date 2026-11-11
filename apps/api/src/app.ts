import {
  contactInput,
  customerCreate,
  customerUpdate,
  jobCreate,
  appointmentCreate,
  appointmentRange,
  appointmentUpdate,
  timerAction,
  jobStageCreate,
  jobStageUpdate,
  jobUpdate,
  listQuery,
  quoteAccept,
  quoteCreate,
  quoteRevisionUpdate,
  quoteStatus,
  siteInput,
  settingsUpdate,
  priceItemInput,
  priceItemUpdate,
  priceImportInput,
  kitInput,
  kitUpdate,
  invoiceCreate,
  invoiceUpdate,
  paymentCreate,
  billApply,
  billCreate,
  billUpdate,
  supplierInput,
  supplierUpdate,
  type ApiErrorBody,
  type BusinessDocument,
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
import * as stages from './services/stages';
import * as schedule from './services/schedule';
import * as pricelist from './services/pricelist';
import * as invoices from './services/invoices';
import * as documents from './services/documents';
import * as bills from './services/bills';

export interface AppDeps {
  /** Returns a Postgres client for this request (a shared pool in Node, per-request on Workers). */
  getSql: (c: Context) => Sql;
  /** Magic-link sign-in, sessions and CSRF (see auth.ts). */
  auth: AuthConfig;
  corsOrigins?: string[];
}

/** `If-Match: 7` or `If-Match: "7"` -> 7. Absent means "don't check" (online edits from the latest copy). */
const ifMatch = (c: Context): number | undefined => {
  const h = c.req.header('if-match');
  if (!h) return undefined;
  const n = Number(h.replace(/^W\//, '').replace(/"/g, ''));
  if (!Number.isSafeInteger(n) || n < 1)
    throw new AppError(400, 'bad_if_match', 'If-Match must be a version number');
  return n;
};

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
        allowHeaders: ['Content-Type', 'Idempotency-Key', 'X-CSRF-Token', 'If-Match'],
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
    const v = ifMatch(c);
    return c.json(await c.var.tx((tx) => quotes.updateQuote(tx, c.var.auth, id, input, v)));
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
    stageId: z.uuid().optional(),
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
    const v = ifMatch(c);
    return c.json(await c.var.tx((tx) => jobs.updateJob(tx, c.var.auth, id, input, v)));
  });

  app.post('/api/jobs/:id/assignees', async (c) => {
    const id = uuidParam(c);
    const { userId } = parse(z.object({ userId: z.uuid() }), await jsonBody(c.req));
    return c.json(await c.var.tx((tx) => jobs.assign(tx, c.var.auth, id, userId)));
  });
  app.delete('/api/jobs/:id/assignees/:userId', async (c) => {
    const id = uuidParam(c);
    const userId = uuidParam(c, 'userId');
    return c.json(await c.var.tx((tx) => jobs.unassign(tx, c.var.auth, id, userId)));
  });
  app.post('/api/jobs/:id/appointments', async (c) => {
    const id = uuidParam(c);
    const input = parse(appointmentCreate, await jsonBody(c.req));
    return c.json(await c.var.tx((tx) => jobs.createAppointment(tx, c.var.auth, id, input)), 201);
  });
  app.delete('/api/appointments/:id', async (c) => {
    const id = uuidParam(c);
    return c.json(await c.var.tx((tx) => jobs.deleteAppointment(tx, c.var.auth, id)));
  });
  // Timer start/stop can be queued offline and replayed: Idempotency-Key makes a replay harmless.
  for (const action of ['start', 'stop'] as const) {
    app.post(`/api/jobs/:id/timer/${action}`, async (c) => {
      const id = uuidParam(c);
      const body = await jsonBody(c.req).catch(() => ({}));
      const input = parse(timerAction, body ?? {});
      const key = c.req.header('idempotency-key');
      const result = await c.var.tx((tx) =>
        idempotent(
          tx,
          c.var.auth,
          key,
          `timer:${action}:${id}:${JSON.stringify(input)}`,
          async () => ({
            status: 200,
            body:
              action === 'start'
                ? await jobs.startTimer(tx, c.var.auth, id, input)
                : await jobs.stopTimer(tx, c.var.auth, id, input),
          }),
        ),
      );
      if (result.replayed) c.header('Idempotent-Replayed', 'true');
      return c.json(result.body);
    });
  }
  app.get('/api/timer', async (c) => c.json(await c.var.tx((tx) => schedule.runningTimer(tx))));

  /* ----------------------------- schedule ---------------------------- */
  app.get('/api/members', async (c) => c.json(await c.var.tx((tx) => schedule.listMembers(tx))));
  app.get('/api/appointments', async (c) => {
    const range = parse(appointmentRange, {
      from: c.req.query('from'),
      to: c.req.query('to'),
    });
    return c.json(await c.var.tx((tx) => schedule.listAppointments(tx, range)));
  });
  app.patch('/api/appointments/:id', async (c) => {
    const id = uuidParam(c);
    const input = parse(appointmentUpdate, await jsonBody(c.req));
    return c.json(await c.var.tx((tx) => schedule.updateAppointment(tx, c.var.auth, id, input)));
  });

  /* ---------------------------- job stages --------------------------- */
  app.get('/api/job-stages', async (c) => c.json(await c.var.tx((tx) => stages.listStages(tx))));
  app.post('/api/job-stages', async (c) => {
    const input = parse(jobStageCreate, await jsonBody(c.req));
    return c.json(await c.var.tx((tx) => stages.createStage(tx, c.var.auth, input)), 201);
  });
  app.patch('/api/job-stages/:id', async (c) => {
    const id = uuidParam(c);
    const input = parse(jobStageUpdate, await jsonBody(c.req));
    return c.json(await c.var.tx((tx) => stages.updateStage(tx, c.var.auth, id, input)));
  });
  app.delete('/api/job-stages/:id', async (c) => {
    const id = uuidParam(c);
    await c.var.tx((tx) => stages.deleteStage(tx, c.var.auth, id));
    return c.body(null, 204);
  });

  /* ---------------------------- price list --------------------------- */
  const ownerOnly = (c: Context<AppEnv>, what: string) => {
    if (c.var.auth.role !== 'owner')
      throw new AppError(403, 'owner_only', `Only the business owner can ${what}.`);
  };
  app.get('/api/price-list', async (c) => {
    const q = parse(
      z.object({
        q: z.string().max(100).optional(),
        inactive: z.enum(['true', 'false']).optional(),
      }),
      { q: c.req.query('q'), inactive: c.req.query('inactive') },
    );
    return c.json(
      await c.var.tx((tx) =>
        pricelist.listItems(tx, { search: q.q, includeInactive: q.inactive === 'true' }),
      ),
    );
  });
  app.post('/api/price-list', async (c) => {
    ownerOnly(c, 'change the price list');
    const input = parse(priceItemInput, await jsonBody(c.req));
    return c.json(await c.var.tx((tx) => pricelist.createItem(tx, c.var.auth, input)), 201);
  });
  app.post('/api/price-list/import', async (c) => {
    ownerOnly(c, 'import a price list');
    const input = parse(priceImportInput, await jsonBody(c.req));
    return c.json(
      await c.var.tx((tx) => pricelist.importCsv(tx, c.var.auth, input.csv, input.apply)),
    );
  });
  app.get('/api/price-list/:id', async (c) => {
    const id = uuidParam(c);
    return c.json(await c.var.tx((tx) => pricelist.getItem(tx, id)));
  });
  app.patch('/api/price-list/:id', async (c) => {
    ownerOnly(c, 'change the price list');
    const id = uuidParam(c);
    const input = parse(priceItemUpdate, await jsonBody(c.req));
    return c.json(await c.var.tx((tx) => pricelist.updateItem(tx, c.var.auth, id, input)));
  });
  app.delete('/api/price-list/:id', async (c) => {
    ownerOnly(c, 'change the price list');
    const id = uuidParam(c);
    await c.var.tx((tx) => pricelist.deleteItem(tx, c.var.auth, id));
    return c.body(null, 204);
  });

  /* ------------------------------- kits ------------------------------ */
  app.get('/api/kits', async (c) => c.json(await c.var.tx((tx) => pricelist.listKits(tx))));
  app.post('/api/kits', async (c) => {
    ownerOnly(c, 'change kits');
    const input = parse(kitInput, await jsonBody(c.req));
    return c.json(await c.var.tx((tx) => pricelist.createKit(tx, c.var.auth, input)), 201);
  });
  app.get('/api/kits/:id', async (c) => {
    const id = uuidParam(c);
    return c.json(await c.var.tx((tx) => pricelist.getKit(tx, id)));
  });
  app.patch('/api/kits/:id', async (c) => {
    ownerOnly(c, 'change kits');
    const id = uuidParam(c);
    const input = parse(kitUpdate, await jsonBody(c.req));
    return c.json(await c.var.tx((tx) => pricelist.updateKit(tx, c.var.auth, id, input)));
  });
  app.delete('/api/kits/:id', async (c) => {
    ownerOnly(c, 'change kits');
    const id = uuidParam(c);
    await c.var.tx((tx) => pricelist.deleteKit(tx, c.var.auth, id));
    return c.body(null, 204);
  });

  /* ----------------------------- invoices ---------------------------- */
  app.get('/api/invoices', async (c) => {
    const q = parse(
      z.object({
        filter: z.enum(['all', 'draft', 'outstanding', 'overdue', 'paid']).optional(),
        jobId: z.uuid().optional(),
      }),
      { filter: c.req.query('filter'), jobId: c.req.query('jobId') },
    );
    return c.json(await c.var.tx((tx) => invoices.listInvoices(tx, q)));
  });
  app.get('/api/jobs/:id/invoicing', async (c) => {
    const id = uuidParam(c);
    return c.json(await c.var.tx((tx) => invoices.jobInvoicing(tx, id)));
  });
  app.post('/api/jobs/:id/invoices', async (c) => {
    const id = uuidParam(c);
    const input = parse(invoiceCreate, await jsonBody(c.req));
    const key = c.req.header('idempotency-key');
    const result = await c.var.tx((tx) =>
      idempotent(tx, c.var.auth, key, `invoice:${id}:${JSON.stringify(input)}`, async () => ({
        status: 201,
        body: await invoices.createInvoice(tx, c.var.auth, id, input),
      })),
    );
    if (result.replayed) c.header('Idempotent-Replayed', 'true');
    return c.json(result.body, result.status as 201);
  });
  app.get('/api/invoices/:id', async (c) => {
    const id = uuidParam(c);
    return c.json(await c.var.tx((tx) => invoices.getInvoice(tx, id)));
  });
  app.patch('/api/invoices/:id', async (c) => {
    const id = uuidParam(c);
    const input = parse(invoiceUpdate, await jsonBody(c.req));
    return c.json(
      await c.var.tx((tx) => invoices.updateDraft(tx, c.var.auth, id, input, ifMatch(c))),
    );
  });
  app.delete('/api/invoices/:id', async (c) => {
    const id = uuidParam(c);
    await c.var.tx((tx) => invoices.deleteDraft(tx, c.var.auth, id));
    return c.body(null, 204);
  });
  // Owner decisions. Each is a separate explicit tap in the app; none is ever automatic.
  app.post('/api/invoices/:id/approve', async (c) => {
    const id = uuidParam(c);
    return c.json(await c.var.tx((tx) => invoices.approve(tx, c.var.auth, id, ifMatch(c))));
  });
  app.post('/api/invoices/:id/mark-sent', async (c) => {
    const id = uuidParam(c);
    return c.json(await c.var.tx((tx) => invoices.markSent(tx, c.var.auth, id)));
  });
  app.post('/api/invoices/:id/payments', async (c) => {
    const id = uuidParam(c);
    const input = parse(paymentCreate, await jsonBody(c.req));
    const key = c.req.header('idempotency-key');
    const result = await c.var.tx((tx) =>
      idempotent(tx, c.var.auth, key, `payment:${id}:${JSON.stringify(input)}`, async () => ({
        status: 201,
        body: await invoices.recordPayment(tx, c.var.auth, id, input),
      })),
    );
    if (result.replayed) c.header('Idempotent-Replayed', 'true');
    return c.json(result.body, result.status as 201);
  });

  // Documents: the layout model (for the in-app preview) and the PDF (for the share sheet).
  // Reading or downloading a document never sends anything and never changes its status.
  const pdfResponse = async (c: Context<AppEnv>, doc: BusinessDocument) => {
    const bytes = await documents.pdfOf(doc);
    return c.body(bytes as unknown as ArrayBuffer, 200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(doc.fileName)}`,
      'Cache-Control': 'private, no-store',
    });
  };
  app.get('/api/invoices/:id/document', async (c) => {
    const id = uuidParam(c);
    return c.json(await c.var.tx((tx) => documents.invoiceDoc(tx, id)));
  });
  app.get('/api/invoices/:id/pdf', async (c) => {
    const id = uuidParam(c);
    return pdfResponse(c, await c.var.tx((tx) => documents.invoiceDoc(tx, id)));
  });
  app.get('/api/quotes/:id/document', async (c) => {
    const id = uuidParam(c);
    return c.json(await c.var.tx((tx) => documents.quoteDoc(tx, id)));
  });
  app.get('/api/quotes/:id/pdf', async (c) => {
    const id = uuidParam(c);
    return pdfResponse(c, await c.var.tx((tx) => documents.quoteDoc(tx, id)));
  });

  /* ------------------------ suppliers and bills ------------------------ */
  app.get('/api/suppliers', async (c) => c.json(await c.var.tx((tx) => bills.listSuppliers(tx))));
  app.post('/api/suppliers', async (c) => {
    const input = parse(supplierInput, await jsonBody(c.req));
    return c.json(await c.var.tx((tx) => bills.createSupplier(tx, c.var.auth, input)), 201);
  });
  app.get('/api/suppliers/:id', async (c) => {
    const id = uuidParam(c);
    return c.json(await c.var.tx((tx) => bills.getSupplier(tx, id)));
  });
  app.patch('/api/suppliers/:id', async (c) => {
    ownerOnly(c, 'edit suppliers');
    const id = uuidParam(c);
    const input = parse(supplierUpdate, await jsonBody(c.req));
    return c.json(
      await c.var.tx((tx) => bills.updateSupplier(tx, c.var.auth, id, input, ifMatch(c))),
    );
  });
  app.get('/api/supplier-bills', async (c) => {
    const q = parse(
      z.object({
        status: z.enum(['draft', 'applied']).optional(),
        supplierId: z.uuid().optional(),
        jobId: z.uuid().optional(),
      }),
      {
        status: c.req.query('status'),
        supplierId: c.req.query('supplierId'),
        jobId: c.req.query('jobId'),
      },
    );
    return c.json(await c.var.tx((tx) => bills.listBills(tx, q)));
  });
  app.post('/api/supplier-bills', async (c) => {
    const input = parse(billCreate, await jsonBody(c.req));
    const key = c.req.header('idempotency-key');
    const result = await c.var.tx((tx) =>
      idempotent(tx, c.var.auth, key, `bill:${JSON.stringify(input)}`, async () => ({
        status: 201,
        body: await bills.createBill(tx, c.var.auth, input),
      })),
    );
    if (result.replayed) c.header('Idempotent-Replayed', 'true');
    return c.json(result.body, result.status as 201);
  });
  app.get('/api/supplier-bills/:id', async (c) => {
    const id = uuidParam(c);
    return c.json(await c.var.tx((tx) => bills.getBill(tx, id)));
  });
  app.patch('/api/supplier-bills/:id', async (c) => {
    const id = uuidParam(c);
    const input = parse(billUpdate, await jsonBody(c.req));
    return c.json(await c.var.tx((tx) => bills.updateBill(tx, c.var.auth, id, input, ifMatch(c))));
  });
  app.delete('/api/supplier-bills/:id', async (c) => {
    const id = uuidParam(c);
    await c.var.tx((tx) => bills.deleteBill(tx, c.var.auth, id));
    return c.body(null, 204);
  });
  // Owner decision with a preview first: dryRun (the default) changes nothing.
  app.post('/api/supplier-bills/:id/apply', async (c) => {
    const id = uuidParam(c);
    const input = parse(billApply, await jsonBody(c.req));
    return c.json(await c.var.tx((tx) => bills.applyBill(tx, c.var.auth, id, input.dryRun)));
  });

  return app;
}
