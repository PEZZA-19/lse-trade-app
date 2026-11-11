import {
  creditNoteCreate,
  logoUpload,
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
  billReadRequest,
  publicEnquiry,
  spamReason,
  enquiryCreate,
  enquiryConvert,
  enquiryReject,
  proposalEdit,
  supplierInput,
  supplierUpdate,
  type ApiErrorBody,
  type BusinessDocument,
} from '@lse/shared';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import {
  checkCsrf,
  clientIp,
  hit,
  mountAuthRoutes,
  readSession,
  type AuthConfig,
  type RateLimit,
} from './auth';
import { StubTurnstile, type TurnstileVerifier } from './lib/turnstile';
import * as enquiries from './services/enquiries';
import * as proposals from './services/proposals';
import type { MessageSender } from './lib/messages';
import { withTenant, type Sql, type Tx } from './db/client';
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
import * as creditNotes from './services/creditNotes';
import * as billRead from './services/billRead';
import { AiGateway } from './ai/gateway';

export interface AppDeps {
  /** Returns a Postgres client for this request (a shared pool in Node, per-request on Workers). */
  getSql: (c: Context) => Sql;
  /** Magic-link sign-in, sessions and CSRF (see auth.ts). */
  auth: AuthConfig;
  corsOrigins?: string[];
  /** Model calls (drafts only). Absent: AI helpers are off and say so. */
  ai?: AiGateway;
  /** Website enquiry form checks. Defaults to the stub (no Cloudflare account yet). */
  turnstile?: TurnstileVerifier;
  enquiryLimits?: { perIp: RateLimit; perForm: RateLimit };
  /** Sends approved emails. None is connected: approved emails end "not sent". */
  sender?: MessageSender;
  /** Seconds an approved email waits (Stop button). Two minutes outside tests. */
  holdSeconds?: number;
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
  const ai = deps.ai ?? new AiGateway(null);

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

  /* ------------------------- public enquiry form ------------------------ */
  // No session and any origin (Joe's website posts here), so it sits before the session and CSRF
  // checks, never uses cookies, and can only create an enquiry through public_enquiry_submit().
  const turnstile = deps.turnstile ?? new StubTurnstile();
  const enquiryLimits = deps.enquiryLimits ?? {
    perIp: { max: 5, windowSeconds: 10 * 60 },
    perForm: { max: 60, windowSeconds: 60 * 60 },
  };
  app.use(
    '/api/public/*',
    cors({ origin: '*', allowMethods: ['POST'], allowHeaders: ['Content-Type'] }),
  );
  app.post('/api/public/enquiries/:formKey', async (c) => {
    const formKey = c.req.param('formKey');
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(formKey)) throw notFound('Form');
    const sql = deps.getSql(c);
    const ip = clientIp(c);
    await hit(sql, `enquiry:ip:${ip}`, enquiryLimits.perIp);
    await hit(sql, `enquiry:form:${formKey}`, enquiryLimits.perForm);
    const input = parse(publicEnquiry, await jsonBody(c.req));
    if (!(await turnstile.verify(input.turnstileToken, ip)))
      throw new AppError(400, 'turnstile_failed', 'Please complete the check and send again.');
    // Likely spam is accepted and dropped: bots learn nothing from the response.
    const accepted = { ok: true, message: 'Thanks, your message has been sent.' };
    if (spamReason(input)) return c.json(accepted, 202);
    const [row] = await sql<{ ok: boolean }[]>`
      SELECT public_enquiry_submit(${formKey}, ${input.name}, ${input.email}, ${input.phone},
                                   ${input.address}, ${input.message}) AS ok`;
    if (!row?.ok) throw notFound('Form');
    return c.json(accepted, 202);
  });

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
  app.put('/api/settings/logo', async (c) => {
    if (c.var.auth.role !== 'owner')
      throw new AppError(403, 'forbidden', 'Only the business owner can change the logo');
    const { dataUrl } = parse(logoUpload, await jsonBody(c.req));
    return c.json(await c.var.tx((tx) => settings.setLogo(tx, c.var.auth, dataUrl)));
  });
  app.delete('/api/settings/logo', async (c) => {
    if (c.var.auth.role !== 'owner')
      throw new AppError(403, 'forbidden', 'Only the business owner can change the logo');
    return c.json(await c.var.tx((tx) => settings.setLogo(tx, c.var.auth, null)));
  });
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

  // Customer credit notes: drafted by anyone, approved (numbered, applied) by the owner.
  app.post('/api/invoices/:id/credit-notes', async (c) => {
    const id = uuidParam(c);
    const input = parse(creditNoteCreate, await jsonBody(c.req));
    const key = c.req.header('idempotency-key');
    const result = await c.var.tx((tx) =>
      idempotent(tx, c.var.auth, key, `credit:${id}:${JSON.stringify(input)}`, async () => ({
        status: 201,
        body: await creditNotes.createCreditNote(tx, c.var.auth, id, input),
      })),
    );
    if (result.replayed) c.header('Idempotent-Replayed', 'true');
    return c.json(result.body, result.status as 201);
  });
  app.get('/api/credit-notes/:id', async (c) => {
    const id = uuidParam(c);
    return c.json(await c.var.tx((tx) => creditNotes.getCreditNote(tx, id)));
  });
  app.delete('/api/credit-notes/:id', async (c) => {
    const id = uuidParam(c);
    await c.var.tx((tx) => creditNotes.deleteCreditNote(tx, c.var.auth, id));
    return c.body(null, 204);
  });
  app.post('/api/credit-notes/:id/approve', async (c) => {
    const id = uuidParam(c);
    return c.json(
      await c.var.tx((tx) => creditNotes.approveCreditNote(tx, c.var.auth, id, ifMatch(c))),
    );
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
  app.get('/api/credit-notes/:id/document', async (c) => {
    const id = uuidParam(c);
    return c.json(await c.var.tx((tx) => documents.creditNoteDoc(tx, id)));
  });
  app.get('/api/credit-notes/:id/pdf', async (c) => {
    const id = uuidParam(c);
    return pdfResponse(c, await c.var.tx((tx) => documents.creditNoteDoc(tx, id)));
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
  /* ----------------------------- enquiries ----------------------------- */
  app.get('/api/enquiries', async (c) => {
    const which = c.req.query('status') === 'done' ? 'done' : 'todo';
    return c.json(await c.var.tx((tx) => enquiries.listEnquiries(tx, which)));
  });
  app.get('/api/enquiries/counts', async (c) =>
    c.json(await c.var.tx((tx) => enquiries.enquiryCounts(tx))),
  );
  app.post('/api/enquiries', async (c) => {
    const input = parse(enquiryCreate, await jsonBody(c.req));
    const key = c.req.header('idempotency-key');
    const result = await c.var.tx((tx) =>
      idempotent(tx, c.var.auth, key, `enquiry:${JSON.stringify(input)}`, async () => ({
        status: 201,
        body: await enquiries.createEnquiry(tx, c.var.auth, input),
      })),
    );
    return c.json(result.body, result.status as 201);
  });
  app.get('/api/enquiries/:id', async (c) => {
    const id = uuidParam(c);
    return c.json(await c.var.tx((tx) => enquiries.getEnquiry(tx, id)));
  });
  app.post('/api/enquiries/:id/actioned', async (c) => {
    const id = uuidParam(c);
    return c.json(await c.var.tx((tx) => enquiries.markActioned(tx, c.var.auth, id, ifMatch(c))));
  });
  app.post('/api/enquiries/:id/reject', async (c) => {
    const id = uuidParam(c);
    const { reason } = parse(enquiryReject, await jsonBody(c.req));
    return c.json(await c.var.tx((tx) => enquiries.reject(tx, c.var.auth, id, reason, ifMatch(c))));
  });
  app.post('/api/enquiries/:id/convert', async (c) => {
    const id = uuidParam(c);
    const input = parse(enquiryConvert, await jsonBody(c.req));
    return c.json(await c.var.tx((tx) => enquiries.convert(tx, c.var.auth, id, input, ifMatch(c))));
  });
  app.get('/api/settings/enquiry-form', async (c) =>
    c.json(await c.var.tx((tx) => enquiries.getForm(tx))),
  );
  app.post('/api/settings/enquiry-form', async (c) => {
    if (c.var.auth.role !== 'owner')
      throw new AppError(403, 'forbidden', 'Only the business owner can change the website form');
    const { on } = parse(z.object({ on: z.boolean() }), await jsonBody(c.req));
    return c.json(await c.var.tx((tx) => enquiries.setForm(tx, c.var.auth, on)));
  });

  /* ----------------------------- approvals ----------------------------- */
  const sender = deps.sender ?? null;
  // Held emails are released whenever the inbox is looked at (and by the cron on Workers).
  const withRelease = <T>(c: Context<AppEnv>, fn: (tx: Tx) => Promise<T>) =>
    c.var.tx(async (tx) => {
      await proposals.releaseDue(tx, sender);
      return fn(tx);
    });
  app.get('/api/proposals', async (c) => {
    const which = c.req.query('status') === 'done' ? 'done' : 'open';
    return c.json(await withRelease(c, (tx) => proposals.listProposals(tx, which)));
  });
  app.get('/api/proposals/counts', async (c) =>
    c.json(await withRelease(c, (tx) => proposals.counts(tx))),
  );
  app.get('/api/proposals/:id', async (c) => {
    const id = uuidParam(c);
    return c.json(await withRelease(c, (tx) => proposals.getProposal(tx, id)));
  });
  app.post('/api/proposals/:id/approve', async (c) => {
    const id = uuidParam(c);
    return c.json(
      await withRelease(c, (tx) =>
        proposals.approve(tx, c.var.auth, id, ifMatch(c), deps.holdSeconds),
      ),
    );
  });
  app.post('/api/proposals/:id/stop', async (c) => {
    const id = uuidParam(c);
    return c.json(await c.var.tx((tx) => proposals.stop(tx, c.var.auth, id)));
  });
  app.post('/api/proposals/:id/discard', async (c) => {
    const id = uuidParam(c);
    return c.json(await c.var.tx((tx) => proposals.discard(tx, c.var.auth, id, ifMatch(c))));
  });
  app.patch('/api/proposals/:id', async (c) => {
    const id = uuidParam(c);
    const input = parse(proposalEdit, await jsonBody(c.req));
    return c.json(await c.var.tx((tx) => proposals.edit(tx, c.var.auth, id, input, ifMatch(c))));
  });
  // Helpers: each makes drafts only.
  app.post('/api/enquiries/:id/draft-reply', async (c) => {
    const id = uuidParam(c);
    return c.json(await c.var.tx((tx) => proposals.draftReply(tx, c.var.auth, ai, id)), 201);
  });
  app.post('/api/enquiries/:id/draft-quote', async (c) => {
    const id = uuidParam(c);
    return c.json(await c.var.tx((tx) => proposals.draftQuote(tx, c.var.auth, ai, id)), 201);
  });
  app.post('/api/proposals/overdue-reminders', async (c) =>
    c.json(await c.var.tx((tx) => proposals.draftOverdueReminders(tx, c.var.auth, ai))),
  );
  app.post('/api/supplier-bills/:id/suggest-prices', async (c) => {
    const id = uuidParam(c);
    return c.json(await c.var.tx((tx) => proposals.suggestPriceUpdates(tx, c.var.auth, id)), 201);
  });

  // AI fallback for PDFs the built-in readers don't know: returns a draft to review, saves nothing.
  app.post('/api/supplier-bills/read', async (c) => {
    const input = parse(billReadRequest, await jsonBody(c.req));
    const result = await c.var.tx((tx) => billRead.readBillWithAi(tx, c.var.auth, ai, input));
    // 200 either way, so the call log commits; ok: false carries the reason.
    return c.json(result);
  });
  // Owner decision with a preview first: dryRun (the default) changes nothing.
  app.post('/api/supplier-bills/:id/apply', async (c) => {
    const id = uuidParam(c);
    const input = parse(billApply, await jsonBody(c.req));
    return c.json(await c.var.tx((tx) => bills.applyBill(tx, c.var.auth, id, input.dryRun)));
  });

  return app;
}
