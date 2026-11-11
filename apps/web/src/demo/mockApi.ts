/**
 * In-browser stand-in for the API, used ONLY by the static preview build (VITE_DEMO=1).
 * It applies the same shared validation and pricing rules as the real server, keeps data
 * in this browser (localStorage), and is clearly labelled as a demo in the UI.
 * The real rules (numbering in Postgres, RLS, idempotency) live in apps/api.
 */
import {
  contactInput,
  customerCreate,
  customerUpdate,
  jobCreate,
  jobUpdate,
  lineTotal,
  quoteAccept,
  quoteCreate,
  quoteDisplayNumber,
  quoteRevisionUpdate,
  quoteTotals,
  revisionLetter,
  runDemoScript,
  siteInput,
  unitSell,
  formatDocNumber,
  type ContactDto,
  type CustomerDetailDto,
  type CustomerDto,
  type JobDetailDto,
  type JobLineDto,
  type JobStatus,
  type JobSummaryDto,
  type QuoteDetailDto,
  type QuoteLineDto,
  type QuoteStatus,
  type QuoteSummaryDto,
  type SiteDto,
} from '@lse/shared';
import type { z } from 'zod';
import { ApiError } from '../api/client';

type LineIn = z.output<typeof quoteCreate>['lines'][number];
interface Rev {
  id: string;
  revision: number;
  title: string;
  notes: string | null;
  validDays: number;
  defaultMarkupBp: number;
  acceptedOptions: string[];
  sentAt: string | null;
  supersededAt: string | null;
  lines: (LineIn & { id: string })[];
}
interface Quote {
  id: string;
  number: string;
  status: QuoteStatus;
  customerId: string;
  siteId: string | null;
  currentRevision: number;
  acceptedRevision: number | null;
  convertedJobId: string | null;
  revisions: Rev[];
  createdAt: string;
  updatedAt: string;
}
interface Job {
  id: string;
  number: string;
  seq: number;
  status: JobStatus;
  customerId: string;
  siteId: string | null;
  title: string;
  description: string | null;
  placeOfWork: 'sark' | 'guernsey' | 'other';
  sourceQuoteId: string | null;
  sourceQuoteRevision: number | null;
  lines: JobLineDto[];
  createdAt: string;
  updatedAt: string;
}
interface Db {
  version: 1;
  seq: { quote: number; job: number };
  customers: CustomerDto[];
  sites: SiteDto[];
  contacts: ContactDto[];
  quotes: Quote[];
  jobs: Job[];
}

const KEY = 'lse-demo-db-v1';
const TENANT = {
  id: 'demo-tenant',
  name: 'Little Sark Electric',
  defaultMarkupBp: 13000,
  labourRatePence: 4500,
  quoteValidDays: 30,
};
let db: Db | null = null;
let seeding: Promise<void> | null = null;

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
const save = () => db && localStorage.setItem(KEY, JSON.stringify(db));
const fail = (status: number, code: string, message: string, details?: unknown): never => {
  throw new ApiError(
    status,
    code,
    message,
    ((details as { fields?: Record<string, string> })?.fields ?? {}) as Record<string, string>,
    details,
  );
};
function parse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const r = schema.safeParse(data ?? {});
  if (r.success) return r.data;
  const fields: Record<string, string> = {};
  for (const i of r.error.issues) fields[i.path.join('.') || '_'] ??= i.message;
  return fail(422, 'validation_failed', r.error.issues[0]?.message ?? 'Invalid input', { fields });
}
const notFound = (what: string) => fail(404, 'not_found', `${what} not found`);

/* ----------------------------- projections ----------------------------- */

const priced = (l: LineIn) => ({
  kind: l.kind,
  qtyMilli: l.qtyMilli,
  unitCostPence: l.unitCostPence,
  markupBp: l.markupBp,
  unitPricePence: l.unitPricePence,
  optionLabel: l.optionLabel,
});
const cur = (q: Quote) => q.revisions.find((r) => r.revision === q.currentRevision)!;
const revTotals = (r: Rev) =>
  quoteTotals(r.lines.map(priced), { markupBp: r.defaultMarkupBp }, r.acceptedOptions);
const customerName = (id: string) => db!.customers.find((c) => c.id === id)?.name ?? '';

function quoteSummary(q: Quote): QuoteSummaryDto {
  const r = cur(q);
  const job = db!.jobs.find((j) => j.id === q.convertedJobId);
  return {
    id: q.id,
    number: q.number,
    displayNumber: quoteDisplayNumber(q.number, q.currentRevision),
    status: q.status,
    customerId: q.customerId,
    customerName: customerName(q.customerId),
    siteId: q.siteId,
    title: r.title,
    currentRevision: q.currentRevision,
    totalPence: revTotals(r).totalPence,
    convertedJobId: q.convertedJobId,
    convertedJobNumber: job?.number ?? null,
    createdAt: q.createdAt,
    updatedAt: q.updatedAt,
  };
}
function quoteDetail(q: Quote): QuoteDetailDto {
  const r = cur(q);
  const lines: QuoteLineDto[] = r.lines.map((l, i) => {
    const sell = unitSell(priced(l), { markupBp: r.defaultMarkupBp });
    return { ...l, position: i, unitSellPence: sell, totalPence: lineTotal(l.qtyMilli, sell) };
  });
  return {
    ...quoteSummary(q),
    site: db!.sites.find((s) => s.id === q.siteId) ?? null,
    revisions: q.revisions.map((x) => ({
      id: x.id,
      revision: x.revision,
      revisionLetter: revisionLetter(x.revision),
      sentAt: x.sentAt,
      supersededAt: x.supersededAt,
    })),
    current: { ...r, revisionLetter: revisionLetter(r.revision), lines, totals: revTotals(r) },
  };
}
function jobSummary(j: Job): JobSummaryDto {
  const site = db!.sites.find((s) => s.id === j.siteId);
  return {
    id: j.id,
    number: j.number,
    status: j.status,
    customerId: j.customerId,
    customerName: customerName(j.customerId),
    siteId: j.siteId,
    siteAddress: site?.address ?? null,
    title: j.title,
    sourceQuoteId: j.sourceQuoteId,
    sourceQuoteNumber: db!.quotes.find((q) => q.id === j.sourceQuoteId)?.number ?? null,
    quotedTotalPence: j.lines
      .filter((l) => l.source === 'quote')
      .reduce((s, l) => s + l.totalPence, 0),
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
  };
}
const jobDetail = (j: Job): JobDetailDto => ({
  ...jobSummary(j),
  description: j.description,
  placeOfWork: j.placeOfWork,
  site: db!.sites.find((s) => s.id === j.siteId) ?? null,
  sourceQuoteRevision: j.sourceQuoteRevision,
  lines: j.lines,
});
const customerDetail = (c: CustomerDto): CustomerDetailDto => ({
  ...c,
  sites: db!.sites.filter((s) => s.customerId === c.id),
  contacts: db!.contacts.filter((p) => p.customerId === c.id),
  quotes: db!.quotes
    .filter((q) => q.customerId === c.id)
    .sort(byUpdated)
    .map(quoteSummary),
  jobs: db!.jobs
    .filter((j) => j.customerId === c.id)
    .sort((a, b) => b.seq - a.seq)
    .map(jobSummary),
});
const byUpdated = (a: { updatedAt: string }, b: { updatedAt: string }) =>
  b.updatedAt.localeCompare(a.updatedAt);
const matches = (q: string | null, ...fields: (string | null | undefined)[]) =>
  !q || fields.some((f) => f?.toLowerCase().includes(q.toLowerCase()));

/* -------------------------------- routes ------------------------------- */

function checkSite(siteId: string | null | undefined, customerId: string) {
  if (!siteId) return;
  const s = db!.sites.find((x) => x.id === siteId);
  if (!s) notFound('Site');
  if (s!.customerId !== customerId)
    fail(422, 'validation_failed', 'That site belongs to a different customer', {
      fields: { siteId: 'Pick one of this customer’s sites' },
    });
}
const normalise = (lines: LineIn[]) =>
  lines.map((l) => ({
    ...l,
    id: uid(),
    ...(l.kind === 'labour' && l.unitPricePence == null && l.unitCostPence == null
      ? { unitPricePence: TENANT.labourRatePence }
      : {}),
  }));
const getQuote = (id: string) => db!.quotes.find((q) => q.id === id) ?? notFound('Quote');
const getJob = (id: string) => db!.jobs.find((j) => j.id === id) ?? notFound('Job');
const touch = (x: { updatedAt: string }) => (x.updatedAt = now());

function route(method: string, path: string, query: URLSearchParams, body: unknown): unknown {
  const seg = path.split('/').filter(Boolean);
  const [a, id, sub] = seg;
  const q = query.get('q');

  if (method === 'GET' && a === 'me')
    return {
      user: { id: 'demo-user', name: 'Joe', email: 'owner@lse.example' },
      tenant: TENANT,
      role: 'owner',
    };

  if (a === 'customers') {
    if (method === 'GET' && !id) {
      const items = db!.customers
        .filter((c) => matches(q, c.name, c.email, c.phone))
        .sort((x, y) => x.name.localeCompare(y.name, 'en', { sensitivity: 'base' }));
      return { items, total: items.length };
    }
    if (method === 'POST' && !id) {
      const input = parse(customerCreate, body);
      const c: CustomerDto = {
        id: uid(),
        name: input.name,
        email: input.email,
        phone: input.phone,
        billingAddress: input.billingAddress,
        notes: input.notes,
        markupBp: input.markupBp,
        createdAt: now(),
        updatedAt: now(),
      };
      db!.customers.push(c);
      const ids = input.sites.map((s) => {
        const site = {
          id: uid(),
          customerId: c.id,
          label: s.label,
          address: s.address,
          notes: s.notes,
        };
        db!.sites.push(site);
        return site.id;
      });
      for (const p of input.contacts)
        db!.contacts.push({
          id: uid(),
          customerId: c.id,
          siteId: p.siteIndex == null ? null : (ids[p.siteIndex] ?? null),
          name: p.name,
          role: p.role,
          email: p.email,
          phone: p.phone,
          notes: p.notes,
        });
      return customerDetail(c);
    }
    const c = db!.customers.find((x) => x.id === id) ?? notFound('Customer');
    if (method === 'GET' && !sub) return customerDetail(c);
    if (method === 'PATCH' && !sub) {
      Object.assign(
        c,
        Object.fromEntries(
          Object.entries(parse(customerUpdate, body)).filter(([, v]) => v !== undefined),
        ),
      );
      touch(c);
      return customerDetail(c);
    }
    if (method === 'POST' && sub === 'sites') {
      const s = parse(siteInput, body);
      const site = {
        id: uid(),
        customerId: c.id,
        label: s.label,
        address: s.address,
        notes: s.notes,
      };
      db!.sites.push(site);
      return site;
    }
    if (method === 'POST' && sub === 'contacts') {
      const p = parse(contactInput, body);
      checkSite(p.siteId, c.id);
      const contact = { id: uid(), customerId: c.id, ...p };
      db!.contacts.push(contact);
      return contact;
    }
  }

  if (a === 'quotes') {
    if (method === 'GET' && !id) {
      const status = query.get('status');
      const items = db!.quotes
        .filter((x) => !status || x.status === status)
        .map(quoteSummary)
        .filter((x) => matches(q, x.number, x.title, x.customerName))
        .sort(byUpdated);
      return { items, total: items.length };
    }
    if (method === 'POST' && !id) {
      const input = parse(quoteCreate, body);
      const customer =
        db!.customers.find((x) => x.id === input.customerId) ??
        fail(422, 'validation_failed', 'Pick a customer for this quote', {
          fields: { customerId: 'Customer not found' },
        });
      checkSite(input.siteId, input.customerId);
      const number = formatDocNumber('Q-', 4, db!.seq.quote++);
      const quote: Quote = {
        id: uid(),
        number,
        status: 'draft',
        customerId: input.customerId,
        siteId: input.siteId,
        currentRevision: 1,
        acceptedRevision: null,
        convertedJobId: null,
        createdAt: now(),
        updatedAt: now(),
        revisions: [
          {
            id: uid(),
            revision: 1,
            title: input.title,
            notes: input.notes,
            validDays: input.validDays,
            defaultMarkupBp: customer.markupBp ?? TENANT.defaultMarkupBp,
            acceptedOptions: [],
            sentAt: null,
            supersededAt: null,
            lines: normalise(input.lines),
          },
        ],
      };
      db!.quotes.push(quote);
      return quoteDetail(quote);
    }
    const quote = getQuote(id!);
    const r = cur(quote);
    if (method === 'GET' && !sub) return quoteDetail(quote);
    if (method === 'PATCH' && !sub) {
      if (quote.status !== 'draft')
        fail(
          409,
          'quote_locked',
          quote.status === 'sent'
            ? 'This quote has been sent. Make a new revision to change it.'
            : `This quote is ${quote.status} and can no longer be edited.`,
        );
      const p = parse(quoteRevisionUpdate, body);
      if (p.siteId !== undefined) {
        checkSite(p.siteId, quote.customerId);
        quote.siteId = p.siteId ?? null;
      }
      if (p.title !== undefined) r.title = p.title;
      if (p.notes !== undefined) r.notes = p.notes;
      if (p.validDays !== undefined) r.validDays = p.validDays;
      if (p.lines !== undefined) r.lines = normalise(p.lines);
      touch(quote);
      return quoteDetail(quote);
    }
    if (method === 'POST') {
      const transition = (from: QuoteStatus[], msg: string) => {
        if (!from.includes(quote.status)) fail(409, 'invalid_transition', msg);
      };
      if (sub === 'send') {
        transition(['draft'], `Only a draft can be sent; this quote is ${quote.status}.`);
        if (!r.lines.length) fail(422, 'validation_failed', 'Add at least one line before sending');
        if (revTotals({ ...r, acceptedOptions: [] }).corePence <= 0)
          fail(422, 'validation_failed', 'This quote totals £0. Add prices before sending.');
        r.sentAt = now();
        quote.status = 'sent';
      } else if (sub === 'revise') {
        transition(
          ['sent', 'declined', 'expired'],
          quote.status === 'draft'
            ? 'This revision has not been sent yet, so you can edit it directly.'
            : `A ${quote.status} quote cannot be revised.`,
        );
        r.supersededAt = now();
        quote.currentRevision += 1;
        quote.revisions.push({
          ...r,
          id: uid(),
          revision: quote.currentRevision,
          sentAt: null,
          supersededAt: null,
          acceptedOptions: [],
          lines: r.lines.map((l) => ({ ...l, id: uid() })),
        });
        quote.status = 'draft';
      } else if (sub === 'accept') {
        transition(
          ['sent'],
          quote.status === 'draft'
            ? 'Mark the quote as sent before recording acceptance.'
            : `This quote is already ${quote.status}.`,
        );
        const { acceptedOptions } = parse(quoteAccept, body);
        const available = new Set(r.lines.map((l) => l.optionLabel).filter(Boolean));
        const unknown = acceptedOptions.filter((o) => !available.has(o));
        if (unknown.length) fail(422, 'validation_failed', `Unknown option: ${unknown.join(', ')}`);
        r.acceptedOptions = [...new Set(acceptedOptions)];
        quote.status = 'accepted';
        quote.acceptedRevision = quote.currentRevision;
      } else if (sub === 'decline') {
        transition(['sent'], `Only a sent quote can be declined; this one is ${quote.status}.`);
        quote.status = 'declined';
      } else if (sub === 'convert') {
        if (quote.status === 'converted') {
          const job = db!.jobs.find((j) => j.id === quote.convertedJobId);
          fail(409, 'already_converted', `This quote is already job ${job?.number}.`, {
            jobId: job?.id,
            jobNumber: job?.number,
          });
        }
        if (quote.status !== 'accepted')
          fail(409, 'not_accepted', 'Only an accepted quote can be turned into a job.');
        const accepted = new Set(r.acceptedOptions);
        const seq = db!.seq.job++;
        const job: Job = {
          id: uid(),
          number: String(seq),
          seq,
          status: 'open',
          customerId: quote.customerId,
          siteId: quote.siteId,
          title: r.title,
          description: r.notes,
          placeOfWork: 'sark',
          sourceQuoteId: quote.id,
          sourceQuoteRevision: quote.currentRevision,
          createdAt: now(),
          updatedAt: now(),
          lines: r.lines
            .filter((l) => !l.optionLabel || accepted.has(l.optionLabel))
            .map((l, i) => {
              const sell = unitSell(priced(l), { markupBp: r.defaultMarkupBp });
              return {
                id: uid(),
                position: i,
                kind: l.kind,
                description: l.optionLabel ? `${l.description} (${l.optionLabel})` : l.description,
                qtyMilli: l.qtyMilli,
                unitCostPence: l.unitCostPence,
                unitSellPence: sell,
                totalPence: lineTotal(l.qtyMilli, sell),
                source: 'quote' as const,
              };
            }),
        };
        db!.jobs.push(job);
        quote.status = 'converted';
        quote.convertedJobId = job.id;
        touch(quote);
        return jobDetail(job);
      }
      touch(quote);
      return quoteDetail(quote);
    }
  }

  if (a === 'jobs') {
    if (method === 'GET' && !id) {
      const status = query.get('status');
      const active = query.get('active') === 'true';
      const items = db!.jobs
        .filter(
          (j) =>
            (!status || j.status === status) &&
            (!active || !['completed', 'cancelled'].includes(j.status)),
        )
        .sort((x, y) => y.seq - x.seq)
        .map(jobSummary)
        .filter((j) => matches(q, j.number, j.title, j.customerName, j.siteAddress));
      return { items, total: items.length };
    }
    if (method === 'POST' && !id) {
      const input = parse(jobCreate, body);
      if (!db!.customers.some((c) => c.id === input.customerId))
        fail(422, 'validation_failed', 'Pick a customer for this job', {
          fields: { customerId: 'Customer not found' },
        });
      checkSite(input.siteId, input.customerId);
      const seq = db!.seq.job++;
      const job: Job = {
        id: uid(),
        number: String(seq),
        seq,
        status: 'open',
        ...input,
        sourceQuoteId: null,
        sourceQuoteRevision: null,
        lines: [],
        createdAt: now(),
        updatedAt: now(),
      };
      db!.jobs.push(job);
      return jobDetail(job);
    }
    const job = getJob(id!);
    if (method === 'GET') return jobDetail(job);
    if (method === 'PATCH') {
      const p = parse(jobUpdate, body);
      if (p.siteId !== undefined) checkSite(p.siteId, job.customerId);
      Object.assign(job, Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)));
      touch(job);
      return jobDetail(job);
    }
  }
  return fail(404, 'not_found', 'No such endpoint');
}

function fresh(): Db {
  return {
    version: 1,
    seq: { quote: 1, job: 122 },
    customers: [],
    sites: [],
    contacts: [],
    quotes: [],
    jobs: [],
  };
}

async function ready() {
  if (db) return;
  const stored = localStorage.getItem(KEY);
  if (stored) {
    db = JSON.parse(stored) as Db;
    return;
  }
  seeding ??= (async () => {
    db = fresh();
    const call = (m: string) => async (p: string, b?: unknown) =>
      structuredClone(route(m, p, new URLSearchParams(), b));
    await runDemoScript(call('POST'), call('PATCH'));
    save();
  })();
  await seeding;
}

/** Same contract as the real fetch: returns JSON-shaped data or throws ApiError. */
export async function handle(method: string, fullPath: string, body: unknown): Promise<unknown> {
  await ready();
  await new Promise((r) => setTimeout(r, 120)); // a touch of latency so loading states are honest
  const url = new URL(fullPath, 'http://demo');
  const result = route(method, url.pathname, url.searchParams, body);
  save();
  return structuredClone(result);
}

export function resetDemo() {
  localStorage.removeItem(KEY);
  db = null;
  seeding = null;
}
