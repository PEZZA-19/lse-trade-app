/**
 * In-browser stand-in for the API, used ONLY by the static preview build (VITE_DEMO=1).
 * It applies the same shared validation and pricing rules as the real server, keeps data
 * in this browser (localStorage), and is clearly labelled as a demo in the UI.
 * The real rules (numbering in Postgres, RLS, idempotency) live in apps/api.
 */
import {
  reportQuery,
  costRate,
  creditNoteDocument,
  invoiceDocument,
  quoteDocument,
  type BusinessDocument,
  type CreditNoteDto,
  type InvoiceDetailDto,
  contactInput,
  customerCreate,
  customerUpdate,
  jobCreate,
  jobUpdate,
  appointmentRange,
  appointmentUpdate,
  timerAction,
  minutesBetween,
  TIMER_MAX_AHEAD_MS,
  TIMER_MAX_BACKDATE_MS,
  type AppointmentListItemDto,
  type MemberDto,
  appointmentCreate,
  autoStage,
  canRenameStage,
  jobStageCreate,
  jobStageUpdate,
  SYSTEM_STAGE_DEFAULTS,
  EDITABLE_SYSTEM_STAGES,
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
  readiness,
  settingsUpdate,
  type ContactDto,
  type SequenceDto,
  type SettingsDto,
  type CustomerDetailDto,
  type CustomerDto,
  type JobDetailDto,
  type JobLineDto,
  type JobHistoryDto,
  type JobStageDto,
  type JobStageRef,
  type StageCause,
  type StageEvent,
  type SystemStageKey,
  type JobSummaryDto,
  type QuoteDetailDto,
  type QuoteLineDto,
  type QuoteStatus,
  type QuoteSummaryDto,
  type SiteDto,
} from '@lse/shared';
import type { z } from 'zod';
import { ApiError } from '../api/client';
import { billsRoute } from './mockBills';
import { freshInbox, inboxRoute, type InboxDb } from './mockInbox';
import {
  billingRoute,
  freshBilling,
  today as billingToday,
  type BillingCtx,
  type BillingDb,
} from './mockBilling';
import { demoJobCosting, demoReports, type ReportsCtx } from './mockReports';
import { freshTeam, teamRoute, type TeamDb } from './mockTeam';
import { freshJobDetail, jobDetailRoute, type JobDetailDb } from './mockJobDetail';
// Joe's own logo (his choice to show it in the preview); cleaned by tools/logo.py.
import demoLogo from '../../../../assets/lse-logo.png?inline';

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
  version?: number;
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
  version?: number;
  id: string;
  number: string;
  seq: number;
  stageId: string;
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
interface StageRow {
  id: string;
  systemKey: SystemStageKey | null;
  name: string;
  colour: JobStageRef['colour'];
  isActive: boolean;
  sortOrder: number;
}
interface Db {
  version: 1;
  seq: { quote: number; job: number };
  customers: CustomerDto[];
  sites: SiteDto[];
  contacts: ContactDto[];
  quotes: Quote[];
  jobs: Job[];
  stages: StageRow[];
  history: (Omit<JobHistoryDto, 'toColour'> & { jobId: string; toStageId: string | null })[];
  appointments: {
    id: string;
    jobId: string;
    startsAt: string;
    endsAt: string;
    userId: string | null;
  }[];
  assignees: { jobId: string; userId: string; name: string }[];
  timers: { id: string; jobId: string; startedAt: string; stoppedAt: string | null }[];
  timesheets: {
    id: string;
    jobId: string;
    startedAt: string;
    endedAt: string;
    /** Added in chunk 7; older demo data is the demo owner's timer time. */
    userId?: string;
    source?: 'timer' | 'manual';
    note?: string | null;
    invoiced?: boolean;
  }[];
  /** Added after v1 shipped; filled in on load if missing. */
  settings?: DemoSettings;
  billing?: BillingDb;
  inbox?: InboxDb;
  team?: TeamDb;
  jobDetail?: JobDetailDb;
}
type DemoSettings = Omit<SettingsDto, 'sequences'> & {
  numbering: Record<SequenceDto['kind'], { prefix: string; padding: number }>;
  seqExtra: { invoice: number; credit_note: number };
};
const defaultSettings = (): DemoSettings => ({
  logoDataUrl: demoLogo,
  name: 'Little Sark Electric',
  legalName: null,
  address: 'Demo Workshop, Little Sark (fictional)',
  phone: '01481 000000',
  email: 'owner@lse.example',
  labourRatePence: 4500,
  defaultMarkupBp: 13000,
  quoteValidDays: 30,
  paymentTermsDays: 14,
  taxRateBp: 0,
  yearStart: '01-01',
  yearEffectiveFrom: '2027-01-01',
  quoteTerms: null,
  invoiceTerms: null,
  bankAccountName: null,
  bankSortCode: null,
  bankAccountNumber: null,
  currency: 'GBP',
  timezone: 'Europe/Guernsey',
  numbering: {
    quote: { prefix: 'Q-', padding: 4 },
    job: { prefix: '', padding: 0 },
    invoice: { prefix: '', padding: 0 },
    credit_note: { prefix: 'CN-', padding: 4 },
  },
  seqExtra: { invoice: 1, credit_note: 1 },
});
const S = () => {
  // Older demo data saved before a setting existed: fill it in with the default.
  db!.settings = { ...defaultSettings(), ...db!.settings };
  return db!.settings;
};
const fmt = (kind: SequenceDto['kind'], value: number) =>
  formatDocNumber(S().numbering[kind].prefix, S().numbering[kind].padding, value);

const KEY = 'lse-demo-db-v6'; // v6: logo, credit notes
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
    version: q.version ?? 1,
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
const DEMO_USER = { id: '00000000-0000-4000-8000-00000000d0e0', name: 'Joe' };
/** Fictional staff member so assigning and the scheduler have more than one person. */
const DEMO_STAFF = { id: '00000000-0000-4000-8000-00000000d0e1', name: 'Sam Spark' };
const MEMBERS: MemberDto[] = [
  { userId: DEMO_USER.id, name: DEMO_USER.name, role: 'owner' },
  { userId: DEMO_STAFF.id, name: DEMO_STAFF.name, role: 'staff' },
];
const memberName = (id: string | null) => MEMBERS.find((m) => m.userId === id)?.name ?? null;
const checkMember = (id: string | null | undefined) =>
  id &&
  !memberName(id) &&
  fail(422, 'validation_failed', 'That person is not part of this business', {
    fields: { userId: 'Not a member' },
  });
/** Same limits as the API for a device-reported time. */
function deviceTime(at: string | undefined) {
  const now = Date.now();
  if (!at) return new Date(now).toISOString();
  const t = Date.parse(at);
  if (t > now + TIMER_MAX_AHEAD_MS)
    fail(422, 'validation_failed', 'That time is in the future. Check the clock on this device.');
  if (t < now - TIMER_MAX_BACKDATE_MS)
    fail(422, 'validation_failed', 'That time is more than 7 days ago.');
  return new Date(Math.min(t, now)).toISOString();
}
function finishTimer(t: Db['timers'][number], at: string) {
  t.stoppedAt = at < t.startedAt ? t.startedAt : at;
  db!.timesheets.push({ id: uid(), jobId: t.jobId, startedAt: t.startedAt, endedAt: t.stoppedAt });
}
function apptItem(x: Db['appointments'][number]): AppointmentListItemDto {
  const j = getJob(x.jobId);
  const sum = jobSummary(j);
  return {
    id: x.id,
    jobId: j.id,
    jobNumber: j.number,
    jobTitle: j.title,
    customerName: sum.customerName,
    siteAddress: sum.siteAddress,
    stage: sum.stage,
    startsAt: x.startsAt,
    endsAt: x.endsAt,
    userId: x.userId,
    userName: memberName(x.userId),
  };
}
const stageRow = (id: string) => db!.stages.find((s) => s.id === id) ?? notFound('Stage');
const stageRef = (id: string): JobStageRef => {
  const { sortOrder: _sortOrder, ...ref } = stageRow(id);
  return ref;
};
const stageByKey = (k: SystemStageKey) =>
  db!.stages.find((s) => s.systemKey === k) ??
  fail(409, 'stage_missing', 'That stage has been removed in Settings.');
const sortedStages = () =>
  [...db!.stages].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
const stageDto = (s: StageRow): JobStageDto => ({
  ...s,
  isSystem: s.systemKey !== null,
  canRename: canRenameStage(s.systemKey),
  canDelete: s.systemKey === null || EDITABLE_SYSTEM_STAGES.includes(s.systemKey),
  jobCount: db!.jobs.filter((j) => j.stageId === s.id).length,
});
/** Same as the API's moveJob: no-op if already there, otherwise move and write history. */
function moveJob(j: Job, toId: string, cause: StageCause) {
  if (j.stageId === toId) return;
  const from = stageRow(j.stageId);
  const to = stageRow(toId);
  db!.history.push({
    id: uid(),
    jobId: j.id,
    fromName: from.name,
    toName: to.name,
    toStageId: to.id,
    cause,
    userName: DEMO_USER.name,
    createdAt: now(),
  });
  j.stageId = toId;
  touch(j);
}
function recordCreated(j: Job, cause: 'created' | 'created_from_quote') {
  const to = stageRow(j.stageId);
  db!.history.push({
    id: uid(),
    jobId: j.id,
    fromName: null,
    toName: to.name,
    toStageId: to.id,
    cause,
    userName: DEMO_USER.name,
    createdAt: now(),
  });
}
function applyEvent(j: Job, event: StageEvent) {
  const next = autoStage(event, stageRow(j.stageId).systemKey, {
    hasAssignees: db!.assignees.some((a) => a.jobId === j.id),
    appointmentsLeft: db!.appointments.filter((a) => a.jobId === j.id).length,
  });
  if (next) moveJob(j, stageByKey(next).id, event);
}
function jobSummary(j: Job): JobSummaryDto {
  const site = db!.sites.find((s) => s.id === j.siteId);
  return {
    id: j.id,
    number: j.number,
    stage: stageRef(j.stageId),
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
    version: j.version ?? 1,
  };
}
const jobDetail = (j: Job): JobDetailDto => ({
  ...jobSummary(j),
  description: j.description,
  placeOfWork: j.placeOfWork,
  site: db!.sites.find((s) => s.id === j.siteId) ?? null,
  sourceQuoteRevision: j.sourceQuoteRevision,
  lines: j.lines,
  history: db!.history
    .filter((h) => h.jobId === j.id)
    .map(({ jobId: _jobId, toStageId, ...h }) => ({
      ...h,
      toColour: db!.stages.find((s) => s.id === toStageId)?.colour ?? null,
    })),
  assignees: db!.assignees
    .filter((a) => a.jobId === j.id)
    .map(({ userId, name }) => ({ userId, name })),
  appointments: db!.appointments
    .filter((a) => a.jobId === j.id)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
    .map(({ jobId: _jobId, ...a }) => a),
  timerRunning: db!.timers.some((t) => t.jobId === j.id && !t.stoppedAt),
  timerStartedAt: db!.timers.find((t) => t.jobId === j.id && !t.stoppedAt)?.startedAt ?? null,
  timesheets: db!.timesheets
    .filter((t) => t.jobId === j.id)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .map((t) => ({
      id: t.id,
      userId: t.userId ?? DEMO_USER.id,
      userName:
        MEMBERS.find((m) => m.userId === (t.userId ?? DEMO_USER.id))?.name ?? DEMO_USER.name,
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      minutes: minutesBetween(t.startedAt, t.endedAt),
      source: t.source ?? ('timer' as const),
      note: t.note ?? null,
      invoiced: !!t.invoiced,
    })),
  totalMinutes: db!.timesheets
    .filter((t) => t.jobId === j.id)
    .reduce((n, t) => n + minutesBetween(t.startedAt, t.endedAt), 0),
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
      ? { unitPricePence: S().labourRatePence }
      : {}),
  }));
const getQuote = (id: string) => db!.quotes.find((q) => q.id === id) ?? notFound('Quote');
const getJob = (id: string) => db!.jobs.find((j) => j.id === id) ?? notFound('Job');
const touch = (x: { updatedAt: string; version?: number }) => {
  x.updatedAt = now();
  x.version = (x.version ?? 1) + 1;
};
/** Same rule as the API: an edit made from an older version is refused with the current record. */
function checkVersion(x: { version?: number }, current: () => unknown) {
  const expected = headers['if-match'];
  if (expected && Number(expected.replace(/"/g, '')) !== (x.version ?? 1))
    fail(409, 'version_conflict', 'This was changed on another device since you edited it.', {
      currentVersion: x.version ?? 1,
      current: current(),
    });
}
let headers: Record<string, string> = {};

function lastUsed(kind: SequenceDto['kind']): number | null {
  if (kind === 'quote') return db!.seq.quote > 1 ? db!.seq.quote - 1 : null;
  if (kind === 'job') return db!.jobs.length ? Math.max(...db!.jobs.map((j) => j.seq)) : null;
  return null;
}
function settingsDto(): SettingsDto {
  const { numbering, seqExtra, ...rest } = S();
  const next = (k: SequenceDto['kind']) =>
    k === 'quote' || k === 'job' ? db!.seq[k] : seqExtra[k];
  return {
    ...rest,
    sequences: (['quote', 'job', 'invoice', 'credit_note'] as const).map((kind) => ({
      kind,
      ...numbering[kind],
      nextValue: next(kind),
      gapsAllowed: kind === 'quote' || kind === 'job',
      lastUsed: lastUsed(kind),
    })),
  };
}

function billingCtx(): BillingCtx {
  return {
    b: (db!.billing ??= freshBilling()),
    fail,
    parse,
    uid,
    now,
    userName: DEMO_USER.name,
    settings: () => S(),
    readiness: () => readiness(settingsDto()),
    job: (id) => {
      const j = getJob(id);
      return {
        id: j.id,
        number: j.number,
        title: j.title,
        customerId: j.customerId,
        sourceQuoteId: j.sourceQuoteId,
        lines: j.lines,
      };
    },
    jobIds: () => db!.jobs.map((j) => j.id),
    quote: (id) => {
      const qt = db!.quotes.find((x) => x.id === id);
      if (!qt) return null;
      const rev =
        qt.revisions.find((r) => r.revision === (qt.acceptedRevision ?? qt.currentRevision)) ??
        cur(qt);
      return { number: qt.number, totalPence: revTotals(rev).totalPence };
    },
    customer: (id) => {
      const c = db!.customers.find((x) => x.id === id) ?? notFound('Customer');
      return { name: c.name, email: c.email, billingAddress: c.billingAddress };
    },
    billPayer: (customerId) =>
      db!.contacts
        .filter((x) => x.customerId === customerId && x.role === 'bill_payer')
        .sort((x, y) => Number(!x.email) - Number(!y.email))[0] ?? null,
    timesheets: (jobId) => db!.timesheets.filter((t) => t.jobId === jobId),
    creditNumber: (take) => {
      const v = S().seqExtra.credit_note;
      if (take) S().seqExtra.credit_note = v + 1;
      return fmt('credit_note', v);
    },
    completeJob: (jobId) => {
      const j = getJob(jobId);
      applyEvent(j, 'invoiced_and_paid');
      touch(j);
    },
    ifMatch: () => {
      const v = headers['if-match'];
      return v ? Number(v.replace(/"/g, '')) : undefined;
    },
  };
}

/** Same layout model as GET /api/{quotes|invoices}/:id/document, built from demo data. */
function documentFor(kind: 'quotes' | 'invoices' | 'credit-notes', id: string): BusinessDocument {
  const settings = settingsDto();
  if (kind === 'credit-notes') {
    const cn = billingRoute(
      billingCtx(),
      'GET',
      ['credit-notes', id],
      new URLSearchParams(),
      undefined,
    ) as CreditNoteDto;
    const job = getJob(cn.jobId);
    const site = db!.sites.find((s) => s.id === job.siteId);
    return creditNoteDocument(cn, settings, { siteAddress: site?.address ?? null });
  }
  if (kind === 'invoices') {
    const ctx = billingCtx();
    const inv = billingRoute(
      ctx,
      'GET',
      ['invoices', id],
      new URLSearchParams(),
      undefined,
    ) as InvoiceDetailDto;
    const job = getJob(inv.jobId);
    const site = db!.sites.find((s) => s.id === job.siteId);
    return invoiceDocument(inv, settings, { siteAddress: site?.address ?? null });
  }
  const qt = getQuote(id);
  const ctx = billingCtx();
  const cu = ctx.customer(qt.customerId);
  const bp = ctx.billPayer(qt.customerId);
  const to = bp?.email
    ? { name: `${bp.name} (${cu.name})`, email: bp.email, address: cu.billingAddress }
    : { name: cu.name, email: cu.email, address: cu.billingAddress };
  const todayIso = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Guernsey' }).format(
    new Date(),
  );
  return quoteDocument(quoteDetail(qt), settings, to, todayIso);
}

function route(method: string, path: string, query: URLSearchParams, body: unknown): unknown {
  const seg = path.split('/').filter(Boolean);
  const [a, id, sub] = seg;
  const q = query.get('q');

  const user = { ...DEMO_USER, email: 'owner@lse.example' };
  if (
    method === 'GET' &&
    sub === 'document' &&
    (a === 'quotes' || a === 'invoices' || a === 'credit-notes')
  )
    return documentFor(a, id!);
  const team = (db!.team ??= freshTeam(MEMBERS.map((m) => m.userId)));
  const reportsCtx = (): ReportsCtx => ({
    call: (m, p) => {
      const u = new URL(p, 'http://demo');
      return route(m, u.pathname, u.searchParams, undefined);
    },
    jobIds: db!.jobs.map((j) => j.id),
    timesheets: db!.timesheets,
    user: DEMO_USER,
    members: MEMBERS,
    costRate: (uid) => {
      const t = team[uid];
      return t ? costRate(t.base, t.on) : null;
    },
    labourRatePence: S().labourRatePence,
    markupBp: S().defaultMarkupBp,
    today: billingToday(),
  });
  if (method === 'GET' && a === 'reports' && !id) {
    const r = parse(reportQuery, { from: query.get('from'), to: query.get('to') });
    return demoReports(reportsCtx(), r.from, r.to);
  }
  if (method === 'GET' && a === 'jobs' && sub === 'costing')
    return demoJobCosting(reportsCtx(), id!);
  const teamResult = teamRoute(
    { team, members: MEMBERS, labourRatePence: S().labourRatePence, parse, fail },
    method,
    seg,
    body,
  );
  if (teamResult !== undefined) return teamResult;
  const detail = jobDetailRoute(
    {
      db: (db!.jobDetail ??= freshJobDetail()),
      timesheets: db!.timesheets,
      jobs: db!.jobs,
      members: MEMBERS,
      userId: DEMO_USER.id,
      markupBp: S().defaultMarkupBp,
      parse,
      fail,
      uid,
      now,
      jobDetail: (jid) => jobDetail(getJob(jid)),
    },
    method,
    seg,
    body,
  );
  if (detail !== undefined) return detail;
  const inbox = inboxRoute(
    {
      db: (db!.inbox ??= freshInbox()),
      call: (m, p, b) => {
        const u = new URL(p, 'http://demo');
        return route(m, u.pathname, u.searchParams, b);
      },
      fail,
      parse,
      uid,
      now,
      userName: DEMO_USER.name,
      ifMatch: () => {
        const v = headers['if-match'];
        return v ? Number(v.replace(/"/g, '')) : undefined;
      },
    },
    method,
    seg,
    query,
    body,
  );
  if (inbox !== undefined) return inbox;
  const bills = billsRoute(billingCtx(), method, seg, query, body);
  if (bills !== undefined) return bills;
  const billed = billingRoute(billingCtx(), method, seg, query, body);
  if (billed !== undefined) return billed;
  if (method === 'GET' && a === 'me')
    return {
      user,
      tenant: {
        id: 'demo-tenant',
        name: S().name,
        defaultMarkupBp: S().defaultMarkupBp,
        labourRatePence: S().labourRatePence,
        quoteValidDays: S().quoteValidDays,
      },
      role: 'owner',
    };

  // The preview has no real sign-in: it is always "signed in" as the demo owner.
  if (a === 'auth') {
    if (id === 'session')
      return {
        user,
        memberships: [{ tenantId: 'demo-tenant', tenantName: S().name, role: 'owner' }],
        tenantId: 'demo-tenant',
        role: 'owner',
        csrfToken: 'demo',
      };
    if (id === 'logout') return undefined;
    if (id === 'request-link' || id === 'verify')
      fail(400, 'demo', 'Sign-in is switched off in the preview.');
  }

  if (a === 'settings') {
    if (method === 'GET' && id === 'readiness') return readiness(settingsDto());
    if (method === 'GET') return settingsDto();
    if (method === 'PATCH') {
      const input = parse(settingsUpdate, body);
      const { sequences, ...rest } = input;
      for (const seq of sequences ?? []) {
        const last = lastUsed(seq.kind);
        if (last !== null && seq.nextValue <= last)
          fail(
            422,
            'validation_failed',
            `The next ${seq.kind.replace('_', ' ')} number must be above ${last}, which is already used.`,
          );
      }
      Object.assign(
        S(),
        Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)),
      );
      for (const seq of sequences ?? []) {
        S().numbering[seq.kind] = { prefix: seq.prefix, padding: seq.padding };
        if (seq.kind === 'quote' || seq.kind === 'job') db!.seq[seq.kind] = seq.nextValue;
        else S().seqExtra[seq.kind] = seq.nextValue;
      }
      return settingsDto();
    }
  }

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
        version: 1,
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
      const number = fmt('quote', db!.seq.quote++);
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
            defaultMarkupBp: customer.markupBp ?? S().defaultMarkupBp,
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
      checkVersion(quote, () => quoteDetail(quote));
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
        const ready = readiness(settingsDto()).quote;
        if (!ready.ready)
          fail(
            422,
            'business_details_missing',
            `Add your ${ready.missing.map((m) => m.label.toLowerCase()).join(', ')} in Settings before sending.`,
          );
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
          number: fmt('job', seq),
          seq,
          stageId: stageByKey('unassigned').id,
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
                invoiced: false,
              };
            }),
        };
        db!.jobs.push(job);
        recordCreated(job, 'created_from_quote');
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
      const stageId = query.get('stageId');
      const active = query.get('active') === 'true';
      const items = db!.jobs
        .filter(
          (j) => (!stageId || j.stageId === stageId) && (!active || stageRow(j.stageId).isActive),
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
        number: fmt('job', seq),
        seq,
        stageId: stageByKey('unassigned').id,
        ...input,
        sourceQuoteId: null,
        sourceQuoteRevision: null,
        lines: [],
        createdAt: now(),
        updatedAt: now(),
      };
      db!.jobs.push(job);
      recordCreated(job, 'created');
      return jobDetail(job);
    }
    const job = getJob(id!);
    if (method === 'GET' && !sub) return jobDetail(job);
    if (method === 'PATCH' && !sub) {
      checkVersion(job, () => jobDetail(job));
      const { stageId, stageKey, ...p } = parse(jobUpdate, body);
      if (p.siteId !== undefined) checkSite(p.siteId, job.customerId);
      const target = stageId ? stageRow(stageId).id : stageKey ? stageByKey(stageKey).id : null;
      Object.assign(job, Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)));
      touch(job);
      if (target) moveJob(job, target, 'manual');
      return jobDetail(job);
    }
    if (method === 'POST' && sub === 'assignees') {
      const { userId } = (body ?? {}) as { userId?: string };
      if (!userId) fail(422, 'validation_failed', 'Pick someone');
      checkMember(userId);
      if (!db!.assignees.some((a) => a.jobId === job.id && a.userId === userId))
        db!.assignees.push({ jobId: job.id, userId: userId!, name: memberName(userId!)! });
      applyEvent(job, 'assigned');
      return jobDetail(job);
    }
    if (method === 'DELETE' && sub === 'assignees') {
      db!.assignees = db!.assignees.filter((x) => !(x.jobId === job.id && x.userId === seg[3]));
      return jobDetail(job);
    }
    if (method === 'POST' && sub === 'appointments') {
      const p = parse(appointmentCreate, body);
      checkMember(p.userId);
      db!.appointments.push({
        id: uid(),
        jobId: job.id,
        startsAt: new Date(p.startsAt).toISOString(),
        endsAt: new Date(p.endsAt).toISOString(),
        userId: p.userId ?? null,
      });
      applyEvent(job, 'appointment_created');
      return jobDetail(job);
    }
    if (method === 'POST' && sub === 'timer') {
      const action = seg[3];
      const input = parse(timerAction, body ?? {});
      const at = deviceTime(input.at);
      const running = db!.timers.find((t) => !t.stoppedAt);
      if (action === 'start') {
        if (running && running.jobId !== job.id) {
          if (!input.switch)
            fail(
              409,
              'timer_running',
              `Your timer is running on job ${getJob(running.jobId).number}. Stop it first.`,
              { jobId: running.jobId, jobNumber: getJob(running.jobId).number },
            );
          finishTimer(running, at);
        }
        if (!running || running.jobId !== job.id)
          db!.timers.push({ id: uid(), jobId: job.id, startedAt: at, stoppedAt: null });
        applyEvent(job, 'timer_started');
      } else if (running?.jobId === job.id) finishTimer(running, at);
      return jobDetail(job);
    }
  }

  if (a === 'members' && method === 'GET') return MEMBERS;
  if (a === 'timer' && method === 'GET') {
    const t = db!.timers.find((x) => !x.stoppedAt);
    if (!t) return null;
    const j = getJob(t.jobId);
    return { jobId: j.id, jobNumber: j.number, jobTitle: j.title, startedAt: t.startedAt };
  }
  if (a === 'appointments' && method === 'GET' && !id) {
    const r = parse(appointmentRange, { from: query.get('from'), to: query.get('to') });
    return db!.appointments
      .filter(
        (x) =>
          x.startsAt < new Date(r.to).toISOString() && x.endsAt > new Date(r.from).toISOString(),
      )
      .sort((x, y) => x.startsAt.localeCompare(y.startsAt))
      .map(apptItem);
  }
  if (a === 'appointments' && method === 'PATCH') {
    const appt = db!.appointments.find((x) => x.id === id) ?? notFound('Appointment');
    const p = parse(appointmentUpdate, body);
    if (p.userId !== undefined) checkMember(p.userId);
    appt.startsAt = new Date(p.startsAt).toISOString();
    appt.endsAt = new Date(p.endsAt).toISOString();
    if (p.userId !== undefined) appt.userId = p.userId;
    return apptItem(appt);
  }
  if (a === 'appointments' && method === 'DELETE') {
    const appt = db!.appointments.find((x) => x.id === id) ?? notFound('Appointment');
    db!.appointments = db!.appointments.filter((x) => x !== appt);
    const job = getJob(appt.jobId);
    applyEvent(job, 'appointment_deleted');
    return jobDetail(job);
  }

  if (a === 'job-stages') {
    if (method === 'GET') return sortedStages().map(stageDto);
    const nameTaken = (name: string, except?: string) =>
      db!.stages.some((s) => s.id !== except && s.name.toLowerCase() === name.toLowerCase()) &&
      fail(422, 'validation_failed', 'There is already a stage with that name', {
        fields: { name: 'Already used' },
      });
    if (method === 'POST') {
      const p = parse(jobStageCreate, body);
      nameTaken(p.name);
      const row: StageRow = {
        id: uid(),
        systemKey: null,
        name: p.name,
        colour: p.colour,
        isActive: p.isActive,
        sortOrder: p.sortOrder ?? Math.max(0, ...db!.stages.map((s) => s.sortOrder)) + 10,
      };
      db!.stages.push(row);
      return stageDto(row);
    }
    const row = stageRow(id!);
    if (method === 'PATCH') {
      const p = parse(jobStageUpdate, body);
      if (p.name !== undefined && p.name !== row.name && !canRenameStage(row.systemKey))
        fail(409, 'stage_locked', `“${row.name}” is a system stage and can’t be renamed.`);
      if (p.isActive !== undefined && p.isActive !== row.isActive && row.systemKey)
        fail(409, 'stage_locked', `Whether “${row.name}” counts as active is fixed.`);
      if (p.name) nameTaken(p.name, row.id);
      Object.assign(row, Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)));
      return stageDto(row);
    }
    if (method === 'DELETE') {
      const dto = stageDto(row);
      if (!dto.canDelete)
        fail(409, 'stage_locked', `“${row.name}” is a system stage and can’t be deleted.`);
      if (dto.jobCount > 0)
        fail(
          409,
          'stage_in_use',
          `${dto.jobCount} ${dto.jobCount === 1 ? 'job is' : 'jobs are'} in "${row.name}". Move them first.`,
        );
      db!.stages = db!.stages.filter((s) => s !== row);
      for (const h of db!.history) if (h.toStageId === row.id) h.toStageId = null;
      return null;
    }
  }
  return fail(404, 'not_found', 'No such endpoint', { method, path });
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
    stages: SYSTEM_STAGE_DEFAULTS.map((s) => ({ ...s, id: uid() })),
    history: [],
    appointments: [],
    assignees: [],
    timers: [],
    timesheets: [],
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
    const call = (m: string) => async (p: string, b?: unknown) => {
      const u = new URL(p, 'http://demo');
      return structuredClone(route(m, u.pathname, u.searchParams, b));
    };
    await runDemoScript(call('POST'), call('PATCH'), call('GET'));
    save();
  })();
  await seeding;
}

/** Same contract as the real fetch: returns JSON-shaped data or throws ApiError. */
export async function handle(
  method: string,
  fullPath: string,
  body: unknown,
  reqHeaders: Record<string, string> = {},
): Promise<unknown> {
  await ready();
  headers = reqHeaders;
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
