/**
 * Demo (preview) version of the price list, kits and invoices API. Same rules as the server
 * (apps/api/src/services/pricelist.ts and invoices.ts), kept small; state lives in the demo db.
 */
import {
  DEFAULT_INVOICE_TERMS,
  addDaysIso,
  creditBlocker,
  creditNoteCreate,
  displayStatus,
  formatPence,
  invoiceCreate,
  invoiceNumber,
  invoiceTotals,
  invoiceUpdate,
  itemSell,
  kitInput,
  kitTotals,
  kitUpdate,
  paymentCreate,
  percentOf,
  priceImportInput,
  priceItemInput,
  priceItemKey,
  priceItemUpdate,
  priceRowsFromCsv,
  importChanges,
  statusAfterPayment,
  type CreditNoteDto,
  type InvoiceDetailDto,
  type InvoiceLineKind,
  type InvoiceStatus,
  type InvoiceSummaryDto,
  type JobLineDto,
  type KitChangeSummary,
  type KitCostChangeDto,
  type KitDetailDto,
  type KitLineDto,
  type KitSummaryDto,
  type PaymentMethod,
  type PriceHistoryDto,
  type PriceImportResultDto,
  type PriceItem,
  type PriceItemDetailDto,
  type PriceItemDto,
  type PriceSource,
  type QuoteInvoiceMode,
  type ReadinessDto,
} from '@lse/shared';
import type { z } from 'zod';
import type { DemoBill, DemoSupplier } from './mockBills';

interface Item extends PriceItem {
  id: string;
  updatedAt: string;
}
interface Kit {
  id: string;
  name: string;
  description: string | null;
  lines: { itemId: string; qtyMilli: number }[];
}
interface Invoice {
  id: string;
  jobId: string;
  number: string | null;
  status: InvoiceStatus;
  source: 'job' | 'quote';
  quoteMode: QuoteInvoiceMode | null;
  quoteId: string | null;
  quoteAmountPence: number | null;
  issueDate: string | null;
  dueDate: string | null;
  termsDays: number;
  notes: string | null;
  lines: {
    kind: InvoiceLineKind;
    description: string;
    qtyMilli: number;
    unitPricePence: number;
    taxRateBp: number;
  }[];
  payments: {
    id: string;
    amountPence: number;
    paidOn: string;
    method: PaymentMethod;
    reference: string | null;
    createdAt: string;
  }[];
  approvedAt: string | null;
  sentAt: string | null;
  createdAt: string;
  version: number;
  /** Customer credit notes against this invoice. */
  credits?: DemoCredit[];
}
export interface DemoCredit {
  id: string;
  number: string | null;
  status: 'draft' | 'approved';
  issueDate: string | null;
  reason: string;
  amountPence: number;
  approvedAt: string | null;
  createdAt: string;
  version: number;
}
export interface BillingDb {
  items: Item[];
  history: (PriceHistoryDto & { itemId: string })[];
  kits: Kit[];
  kitChanges: (KitCostChangeDto & { kitId: string })[];
  invoices: Invoice[];
  /** timesheet id -> invoice id */
  billed: Record<string, string>;
  invoiceCount: Record<string, number>;
  suppliers?: DemoSupplier[];
  bills?: DemoBill[];
}
export const freshBilling = (): BillingDb => ({
  items: [],
  history: [],
  kits: [],
  kitChanges: [],
  invoices: [],
  billed: {},
  invoiceCount: {},
});

export interface BillingCtx {
  b: BillingDb;
  fail: (status: number, code: string, message: string, details?: unknown) => never;
  parse: <S extends z.ZodType>(schema: S, data: unknown) => z.output<S>;
  uid: () => string;
  now: () => string;
  userName: string;
  settings: () => {
    defaultMarkupBp: number;
    labourRatePence: number;
    paymentTermsDays: number;
    taxRateBp: number;
    invoiceTerms: string | null;
  };
  readiness: () => ReadinessDto;
  job: (id: string) => {
    id: string;
    number: string;
    title: string;
    customerId: string;
    sourceQuoteId: string | null;
    lines: JobLineDto[];
  };
  jobIds: () => string[];
  quote: (id: string) => { number: string; totalPence: number } | null;
  customer: (id: string) => { name: string; email: string | null; billingAddress: string | null };
  billPayer: (customerId: string) => { name: string; email: string | null } | null;
  timesheets: (jobId: string) => { id: string; startedAt: string; endedAt: string }[];
  completeJob: (jobId: string) => void;
  /** The next credit note number; `take` uses it up (gap-free, on approval only). */
  creditNumber: (take: boolean) => string;
  ifMatch: () => number | undefined;
}

const notFound = (c: BillingCtx, what: string) => c.fail(404, 'not_found', `${what} not found`);
export const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Guernsey' }).format(new Date());

/* ------------------------------ price list ------------------------------ */

const sell = (c: BillingCtx, i: Item) => itemSell(i, c.settings().defaultMarkupBp);
const kitsUsing = (c: BillingCtx, itemId: string) =>
  c.b.kits.filter((k) => k.lines.some((l) => l.itemId === itemId));

function itemDto(c: BillingCtx, i: Item): PriceItemDto {
  return { ...i, unitSellPence: sell(c, i), kitCount: kitsUsing(c, i.id).length };
}
function itemDetail(c: BillingCtx, i: Item): PriceItemDetailDto {
  return {
    ...itemDto(c, i),
    history: c.b.history
      .filter((h) => h.itemId === i.id)
      .sort((x, y) => y.createdAt.localeCompare(x.createdAt)),
    kits: kitsUsing(c, i.id).map((k) => ({ id: k.id, name: k.name })),
  };
}
const getItem = (c: BillingCtx, id: string) =>
  c.b.items.find((i) => i.id === id) ?? notFound(c, 'Price list item');

function kitCosts(c: BillingCtx, k: Kit) {
  return kitTotals(
    k.lines.map((l) => {
      const i = getItem(c, l.itemId);
      return { qtyMilli: l.qtyMilli, unitCostPence: i.unitCostPence, unitSellPence: sell(c, i) };
    }),
  );
}

function history(
  c: BillingCtx,
  itemId: string,
  oldCost: number | null,
  newCost: number,
  source: PriceSource,
  reference: string | null,
) {
  c.b.history.push({
    id: c.uid(),
    itemId,
    oldCostPence: oldCost,
    newCostPence: newCost,
    source,
    reference,
    userName: c.userName,
    createdAt: new Date(Date.now() + c.b.history.length).toISOString(),
  });
}

/** Applies item changes, writes history, and records each affected kit's old and new cost. */
export function applyPatches(
  c: BillingCtx,
  patches: { item: Item; next: Partial<PriceItem> }[],
  source: PriceSource,
  reference: string | null,
): KitChangeSummary[] {
  const ids = new Set(patches.map((p) => p.item.id));
  const kits = c.b.kits.filter((k) => k.lines.some((l) => ids.has(l.itemId)));
  const before = new Map(kits.map((k) => [k.id, kitCosts(c, k)]));
  for (const { item, next } of patches) {
    const old = item.unitCostPence;
    if (
      next.code &&
      c.b.items.some((x) => x.id !== item.id && x.code?.toLowerCase() === next.code!.toLowerCase())
    )
      c.fail(422, 'validation_failed', `Code "${next.code}" is already on the price list`, {
        fields: { code: 'Already used' },
      });
    const defined = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined));
    Object.assign(item, defined, { updatedAt: c.now() });
    if (next.unitCostPence !== undefined && next.unitCostPence !== old)
      history(c, item.id, old, next.unitCostPence, source, reference);
  }
  const out: KitChangeSummary[] = [];
  const cause =
    patches.length === 1
      ? patches[0]!.item.description
      : `${patches.length} items${reference ? ` (${reference})` : ''}`;
  for (const k of kits) {
    const b = before.get(k.id)!;
    const a = kitCosts(c, k);
    if (a.costPence === b.costPence && a.sellPence === b.sellPence) continue;
    const ch = {
      kitId: k.id,
      name: k.name,
      oldCostPence: b.costPence,
      newCostPence: a.costPence,
      oldSellPence: b.sellPence,
      newSellPence: a.sellPence,
    };
    out.push(ch);
    c.b.kitChanges.push({ ...ch, id: c.uid(), itemDescription: cause, source, createdAt: c.now() });
  }
  return out;
}

function createItem(c: BillingCtx, input: PriceItem, source: PriceSource = 'created') {
  if (input.code && c.b.items.some((x) => x.code?.toLowerCase() === input.code!.toLowerCase()))
    c.fail(422, 'validation_failed', `Code "${input.code}" is already on the price list`, {
      fields: { code: 'Already used' },
    });
  const item: Item = { ...input, id: c.uid(), updatedAt: c.now() };
  c.b.items.push(item);
  history(c, item.id, null, item.unitCostPence, source, source === 'csv' ? 'CSV import' : null);
  return item;
}

export function matcher(c: BillingCtx) {
  return (q: { code: string | null; supplier: string | null; description: string }) =>
    (q.code
      ? c.b.items.find((i) => i.code && i.code.toLowerCase() === q.code!.toLowerCase())
      : undefined) ??
    c.b.items.find(
      (i) =>
        priceItemKey({ code: null, supplier: i.supplier, description: i.description }) ===
        priceItemKey({ code: null, supplier: q.supplier, description: q.description }),
    );
}

function importCsv(c: BillingCtx, csv: string, apply: boolean): PriceImportResultDto {
  const { rows, errors, columns } = priceRowsFromCsv(csv);
  if (apply && errors.length && !rows.length)
    c.fail(422, 'validation_failed', errors[0]!.message, { errors });
  const snapshot = apply ? null : JSON.stringify(c.b);
  const find = matcher(c);
  const created: PriceItem[] = [];
  const patches: { item: Item; next: Partial<PriceItem>; row: number }[] = [];
  let unchanged = 0;
  for (const { row, item } of rows) {
    const ex = find(item);
    if (!ex) {
      created.push(item);
      continue;
    }
    const next = importChanges(ex, item, columns);
    if (Object.keys(next).length) patches.push({ item: ex, next, row });
    else unchanged += 1;
  }
  const updated = patches.map((p) => ({
    row: p.row,
    itemId: p.item.id,
    description: p.next.description ?? p.item.description,
    oldCostPence: p.item.unitCostPence,
    newCostPence: p.next.unitCostPence ?? p.item.unitCostPence,
  }));
  for (const item of created) createItem(c, item, 'csv');
  const kits = applyPatches(c, patches, 'csv', 'CSV import');
  if (snapshot) Object.assign(c.b, JSON.parse(snapshot) as BillingDb); // preview: undo
  return { applied: apply, created, updated, unchanged, errors, kits };
}

/* --------------------------------- kits ---------------------------------- */

function kitLines(c: BillingCtx, k: Kit): KitLineDto[] {
  return k.lines.map((l) => {
    const i = getItem(c, l.itemId);
    const s = sell(c, i);
    const t = kitTotals([
      { qtyMilli: l.qtyMilli, unitCostPence: i.unitCostPence, unitSellPence: s },
    ]);
    return {
      itemId: i.id,
      code: i.code,
      description: i.description,
      unit: i.unit,
      qtyMilli: l.qtyMilli,
      unitCostPence: i.unitCostPence,
      unitSellPence: s,
      lineCostPence: t.costPence,
      lineSellPence: t.sellPence,
      isActive: i.isActive,
    };
  });
}
const changesOf = (c: BillingCtx, kitId: string) =>
  c.b.kitChanges
    .filter((x) => x.kitId === kitId)
    .sort((x, y) => y.createdAt.localeCompare(x.createdAt))
    .map(({ kitId: _k, ...rest }) => rest);
function kitSummary(c: BillingCtx, k: Kit): KitSummaryDto {
  return {
    id: k.id,
    name: k.name,
    description: k.description,
    lineCount: k.lines.length,
    ...kitCosts(c, k),
    lastChange: changesOf(c, k.id)[0] ?? null,
  };
}
const kitDetail = (c: BillingCtx, k: Kit): KitDetailDto => ({
  ...kitSummary(c, k),
  lines: kitLines(c, k),
  changes: changesOf(c, k.id),
});
const getKit = (c: BillingCtx, id: string) =>
  c.b.kits.find((k) => k.id === id) ?? notFound(c, 'Kit');
function checkKit(
  c: BillingCtx,
  name: string | undefined,
  lines: Kit['lines'] | undefined,
  selfId?: string,
) {
  if (name && c.b.kits.some((k) => k.id !== selfId && k.name.toLowerCase() === name.toLowerCase()))
    c.fail(422, 'validation_failed', `There is already a kit called "${name}"`, {
      fields: { name: 'Already used' },
    });
  for (const l of lines ?? []) getItem(c, l.itemId);
}

/* ------------------------------- invoices -------------------------------- */

const getInvoice = (c: BillingCtx, id: string) =>
  c.b.invoices.find((i) => i.id === id) ?? notFound(c, 'Invoice');
const totalsOf = (i: Invoice) => invoiceTotals(i.lines);
function summary(c: BillingCtx, i: Invoice): InvoiceSummaryDto {
  const j = c.job(i.jobId);
  const t = totalsOf(i).totalPence;
  const paid = i.payments.reduce((a, p) => a + p.amountPence, 0);
  const credited = (i.credits ?? [])
    .filter((x) => x.status === 'approved')
    .reduce((a, x) => a + x.amountPence, 0);
  return {
    id: i.id,
    number: i.number,
    jobId: j.id,
    jobNumber: j.number,
    jobTitle: j.title,
    customerName: c.customer(j.customerId).name,
    status: i.status,
    displayStatus: displayStatus(i, today()),
    source: i.source,
    quoteMode: i.quoteMode,
    issueDate: i.issueDate,
    dueDate: i.dueDate,
    totalPence: t,
    paidPence: paid,
    creditedPence: credited,
    balancePence: t - paid - credited,
    createdAt: i.createdAt,
    version: i.version,
  };
}
function billTo(c: BillingCtx, customerId: string) {
  const cu = c.customer(customerId);
  const bp = c.billPayer(customerId);
  return bp?.email
    ? { name: `${bp.name} (${cu.name})`, email: bp.email, address: cu.billingAddress }
    : { name: cu.name, email: cu.email, address: cu.billingAddress };
}
function detail(c: BillingCtx, i: Invoice): InvoiceDetailDto {
  const j = c.job(i.jobId);
  const t = totalsOf(i);
  const to = billTo(c, j.customerId);
  const blockers: string[] = [];
  if (i.status === 'draft') {
    for (const m of c.readiness().invoice.missing) blockers.push(m.label);
    if (!to.email) blockers.push('Bill payer email');
    if (t.totalPence <= 0) blockers.push('An amount to invoice');
  }
  return {
    ...summary(c, i),
    quoteNumber: i.quoteId ? (c.quote(i.quoteId)?.number ?? null) : null,
    termsDays: i.termsDays,
    termsText: c.settings().invoiceTerms?.trim() || DEFAULT_INVOICE_TERMS(i.termsDays),
    notes: i.notes,
    subtotalPence: t.subtotalPence,
    taxPence: t.taxPence,
    billTo: to,
    approvedByName: i.approvedAt ? c.userName : null,
    approvedAt: i.approvedAt,
    sentByName: i.sentAt ? c.userName : null,
    sentAt: i.sentAt,
    lines: i.lines.map((l, n) => ({
      ...l,
      id: `${i.id}-${n}`,
      position: n,
      totalPence: t.lineTotals[n]!,
    })),
    payments: i.payments.map((p) => ({ ...p, recordedByName: c.userName })),
    creditNotes: (i.credits ?? []).map((x) => ({
      id: x.id,
      number: x.number,
      status: x.status,
      issueDate: x.issueDate,
      reason: x.reason,
      amountPence: x.amountPence,
    })),
    nextNumber:
      i.status === 'draft' ? invoiceNumber(j.number, (c.b.invoiceCount[i.jobId] ?? 0) + 1) : null,
    approvalBlockers: blockers,
  };
}
function quoteState(c: BillingCtx, jobId: string) {
  const j = c.job(jobId);
  const q = j.sourceQuoteId ? c.quote(j.sourceQuoteId) : null;
  if (!q) return null;
  const mine = c.b.invoices.filter((i) => i.jobId === jobId && i.source === 'quote');
  const invoiced = mine.reduce((a, i) => a + (i.quoteAmountPence ?? 0), 0);
  return {
    id: j.sourceQuoteId!,
    number: q.number,
    totalPence: q.totalPence,
    invoicedPence: invoiced,
    remainingPence: q.totalPence - invoiced,
    numbers: mine.map((i) => i.number ?? 'draft'),
  };
}
const minutesOf = (t: { startedAt: string; endedAt: string }) =>
  Math.max(1, Math.round((Date.parse(t.endedAt) - Date.parse(t.startedAt)) / 60000));
/** Job lines that aren't from the quote (materials from supplier bills) and not yet invoiced. */
const unbilledLines = (c: BillingCtx, lines: JobLineDto[]) =>
  lines.filter((l) => l.source !== 'quote' && !c.b.billed[l.id]);
const unbilled = (c: BillingCtx, jobId: string) =>
  c.timesheets(jobId).filter((t) => !c.b.billed[t.id]);
const dayLabel = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'Europe/Guernsey',
  }).format(new Date(iso));

function createInvoice(c: BillingCtx, jobId: string, input: z.output<typeof invoiceCreate>) {
  const j = c.job(jobId);
  const s = c.settings();
  const tax = s.taxRateBp;
  let lines: Invoice['lines'] = [];
  let quoteAmount: number | null = null;
  let mode: QuoteInvoiceMode | null = null;
  const reserve: string[] = [];
  if (input.source === 'job') {
    const ts = unbilled(c, jobId);
    const materials = unbilledLines(c, j.lines);
    if (!ts.length && !materials.length)
      c.fail(422, 'validation_failed', 'There is no unbilled time or materials on this job yet.');
    for (const t of ts) {
      const m = minutesOf(t);
      lines.push({
        kind: 'labour',
        description: `Labour ${dayLabel(t.startedAt)} – ${c.userName} (${Math.floor(m / 60) ? `${Math.floor(m / 60)} h ` : ''}${m % 60} min)`,
        qtyMilli: Math.round((m * 1000) / 60),
        unitPricePence: s.labourRatePence,
        taxRateBp: tax,
      });
      reserve.push(t.id);
    }
    for (const l of materials) {
      lines.push({
        kind: l.kind,
        description: l.description,
        qtyMilli: l.qtyMilli,
        unitPricePence: l.unitSellPence,
        taxRateBp: tax,
      });
      reserve.push(l.id);
    }
  } else {
    const q =
      quoteState(c, jobId) ??
      c.fail(
        422,
        'validation_failed',
        'This job did not come from a quote, so invoice its time and materials instead.',
      );
    mode = input.mode;
    if (q.remainingPence <= 0)
      c.fail(422, 'validation_failed', `Quote ${q.number} is already fully invoiced.`);
    const quoteLines = () =>
      j.lines
        .filter((l) => l.source === 'quote' && !(l.kind === 'carriage' && l.totalPence === 0))
        .map((l) => ({
          kind: l.kind,
          description: l.description,
          qtyMilli: l.qtyMilli,
          unitPricePence: l.unitSellPence,
          taxRateBp: tax,
        }));
    if (input.mode === 'whole') {
      if (q.invoicedPence > 0)
        c.fail(
          422,
          'validation_failed',
          `Part of quote ${q.number} is already invoiced. Use "Remainder" instead.`,
        );
      lines = quoteLines();
      quoteAmount = q.totalPence;
    } else if (input.mode === 'remainder') {
      lines = quoteLines();
      if (q.invoicedPence > 0)
        lines.push({
          kind: 'adjustment',
          description: `Less already invoiced (${q.numbers.join(', ')})`,
          qtyMilli: 1000,
          unitPricePence: -q.invoicedPence,
          taxRateBp: tax,
        });
      quoteAmount = q.remainingPence;
    } else {
      const amount =
        input.mode === 'deposit' ? input.amountPence : percentOf(q.totalPence, input.percentBp);
      if (amount > q.remainingPence)
        c.fail(
          422,
          'validation_failed',
          `That is more than the ${formatPence(q.remainingPence)} left to invoice on quote ${q.number}.`,
        );
      const label =
        input.mode === 'deposit'
          ? `Deposit for quote ${q.number}: ${j.title}`
          : `${(input.percentBp / 100).toFixed(2).replace(/\.?0+$/, '')}% of quote ${q.number}: ${j.title}`;
      lines = [
        {
          kind: 'deposit',
          description: label,
          qtyMilli: 1000,
          unitPricePence: amount,
          taxRateBp: tax,
        },
      ];
      quoteAmount = amount;
    }
  }
  const inv: Invoice = {
    id: c.uid(),
    jobId,
    number: null,
    status: 'draft',
    source: input.source,
    quoteMode: mode,
    quoteId: j.sourceQuoteId && input.source === 'quote' ? j.sourceQuoteId : null,
    quoteAmountPence: quoteAmount,
    issueDate: null,
    dueDate: null,
    termsDays: s.paymentTermsDays,
    notes: null,
    lines,
    payments: [],
    approvedAt: null,
    sentAt: null,
    createdAt: c.now(),
    version: 1,
  };
  c.b.invoices.push(inv);
  for (const id of reserve) c.b.billed[id] = inv.id;
  return inv;
}

function settled(c: BillingCtx, jobId: string) {
  const mine = c.b.invoices.filter((i) => i.jobId === jobId);
  if (!mine.length || mine.some((i) => i.status !== 'paid')) return false;
  const q = quoteState(c, jobId);
  return q ? q.remainingPence <= 0 : unbilled(c, jobId).length === 0;
}

/* -------------------------------- routes --------------------------------- */

export function billingRoute(
  c: BillingCtx,
  method: string,
  seg: string[],
  query: URLSearchParams,
  body: unknown,
): unknown {
  const [a, id, sub] = seg;
  if (a === 'price-list') {
    if (method === 'GET' && !id) {
      const q = (query.get('q') ?? '').toLowerCase();
      const all = query.get('inactive') === 'true';
      return c.b.items
        .filter(
          (i) =>
            (all || i.isActive) &&
            (!q || [i.description, i.code, i.supplier].some((f) => f?.toLowerCase().includes(q))),
        )
        .sort((x, y) => x.description.localeCompare(y.description))
        .map((i) => itemDto(c, i));
    }
    if (method === 'POST' && id === 'import') {
      const input = c.parse(priceImportInput, body);
      return importCsv(c, input.csv, input.apply);
    }
    if (method === 'POST' && !id)
      return itemDetail(c, createItem(c, c.parse(priceItemInput, body)));
    const item = getItem(c, id!);
    if (method === 'GET') return itemDetail(c, item);
    if (method === 'PATCH') {
      const kitChanges = applyPatches(
        c,
        [{ item, next: c.parse(priceItemUpdate, body) }],
        'manual',
        null,
      );
      return { ...itemDetail(c, item), kitChanges };
    }
    if (method === 'DELETE') {
      if (kitsUsing(c, item.id).length)
        c.fail(
          409,
          'item_in_kit',
          'This item is used in a kit. Remove it from the kit first, or switch it off instead.',
        );
      c.b.items = c.b.items.filter((i) => i.id !== item.id);
      return null;
    }
  }
  if (a === 'kits') {
    if (method === 'GET' && !id)
      return [...c.b.kits]
        .sort((x, y) => x.name.localeCompare(y.name))
        .map((k) => kitSummary(c, k));
    if (method === 'POST' && !id) {
      const input = c.parse(kitInput, body);
      checkKit(c, input.name, input.lines);
      const k: Kit = {
        id: c.uid(),
        name: input.name,
        description: input.description,
        lines: input.lines,
      };
      c.b.kits.push(k);
      return kitDetail(c, k);
    }
    const k = getKit(c, id!);
    if (method === 'GET') return kitDetail(c, k);
    if (method === 'PATCH') {
      const input = c.parse(kitUpdate, body);
      checkKit(c, input.name, input.lines, k.id);
      if (input.name !== undefined) k.name = input.name;
      if (input.description !== undefined) k.description = input.description;
      if (input.lines) k.lines = input.lines;
      return kitDetail(c, k);
    }
    if (method === 'DELETE') {
      c.b.kits = c.b.kits.filter((x) => x.id !== k.id);
      return null;
    }
  }
  if (a === 'jobs' && id && sub === 'invoicing' && method === 'GET') {
    const q = quoteState(c, id);
    const ts = unbilled(c, id);
    const minutes = ts.reduce((n, t) => n + minutesOf(t), 0);
    return {
      jobId: id,
      quote: q && {
        id: q.id,
        number: q.number,
        totalPence: q.totalPence,
        invoicedPence: q.invoicedPence,
        remainingPence: q.remainingPence,
      },
      unbilledMinutes: minutes,
      unbilledLabourPence: invoiceTotals(
        ts.map((t) => ({
          qtyMilli: Math.round((minutesOf(t) * 1000) / 60),
          unitPricePence: c.settings().labourRatePence,
          taxRateBp: 0,
        })),
      ).subtotalPence,
      unbilledMaterialsPence: unbilledLines(c, c.job(id).lines).reduce(
        (t, l) => t + l.totalPence,
        0,
      ),
      invoices: c.b.invoices.filter((i) => i.jobId === id).map((i) => summary(c, i)),
    };
  }
  if (a === 'jobs' && id && sub === 'invoices' && method === 'POST') {
    c.job(id);
    return detail(c, createInvoice(c, id, c.parse(invoiceCreate, body)));
  }
  if (a === 'invoices') {
    if (method === 'GET' && !id) {
      const f = query.get('filter') ?? 'all';
      const jobId = query.get('jobId');
      const t = today();
      return c.b.invoices
        .filter((i) => !jobId || i.jobId === jobId)
        .filter((i) =>
          f === 'draft'
            ? i.status === 'draft'
            : f === 'outstanding'
              ? ['approved', 'sent', 'part_paid'].includes(i.status)
              : f === 'overdue'
                ? displayStatus(i, t) === 'overdue'
                : f === 'paid'
                  ? i.status === 'paid'
                  : true,
        )
        .sort(
          (x, y) =>
            (x.status === 'draft' ? 0 : 1) - (y.status === 'draft' ? 0 : 1) ||
            (x.dueDate ?? '').localeCompare(y.dueDate ?? '') ||
            y.createdAt.localeCompare(x.createdAt),
        )
        .map((i) => summary(c, i));
    }
    const inv = getInvoice(c, id!);
    if (method === 'GET' && !sub) return detail(c, inv);
    const expected = c.ifMatch();
    if (expected !== undefined && expected !== inv.version)
      c.fail(409, 'version_conflict', 'This was changed on another device since you edited it.', {
        currentVersion: inv.version,
        current: detail(c, inv),
      });
    if (method === 'PATCH' && !sub) {
      if (inv.status !== 'draft')
        c.fail(409, 'invoice_locked', 'Only a draft invoice can be changed.');
      const input = c.parse(invoiceUpdate, body);
      if (input.notes !== undefined) inv.notes = input.notes;
      if (input.termsDays !== undefined) inv.termsDays = input.termsDays;
      if (input.lines) {
        inv.lines = input.lines;
        if (inv.source === 'quote') inv.quoteAmountPence = invoiceTotals(inv.lines).subtotalPence;
      }
      inv.version += 1;
      return detail(c, inv);
    }
    if (method === 'DELETE' && !sub) {
      if (inv.status !== 'draft')
        c.fail(
          409,
          'invoice_locked',
          'An approved invoice keeps its number and cannot be deleted.',
        );
      c.b.invoices = c.b.invoices.filter((i) => i.id !== inv.id);
      for (const [ts, invId] of Object.entries(c.b.billed))
        if (invId === inv.id) delete c.b.billed[ts];
      return null;
    }
    if (method === 'POST' && sub === 'approve') {
      if (inv.status !== 'draft')
        c.fail(409, 'invoice_not_draft', 'This invoice is already approved.');
      const d = detail(c, inv);
      if (d.approvalBlockers.length)
        c.fail(422, 'not_ready', `Before approving, add: ${d.approvalBlockers.join(', ')}.`, {
          missing: d.approvalBlockers,
        });
      const n = (c.b.invoiceCount[inv.jobId] ?? 0) + 1;
      c.b.invoiceCount[inv.jobId] = n;
      const t = today();
      Object.assign(inv, {
        status: 'approved',
        number: invoiceNumber(c.job(inv.jobId).number, n),
        issueDate: t,
        dueDate: addDaysIso(t, inv.termsDays),
        approvedAt: c.now(),
      });
      inv.version += 1;
      return detail(c, inv);
    }
    if (method === 'POST' && sub === 'mark-sent') {
      if (inv.status !== 'approved')
        c.fail(
          409,
          'invoice_not_approved',
          inv.status === 'draft'
            ? 'Approve the invoice before sending it.'
            : 'This invoice has already been sent.',
        );
      Object.assign(inv, { status: 'sent', sentAt: c.now() });
      inv.version += 1;
      return detail(c, inv);
    }
    if (method === 'POST' && sub === 'payments') {
      if (inv.status !== 'sent' && inv.status !== 'part_paid')
        c.fail(
          409,
          'invoice_not_sent',
          inv.status === 'paid'
            ? 'This invoice is already paid.'
            : 'Mark the invoice as sent before recording a payment.',
        );
      const input = c.parse(paymentCreate, body);
      const s = summary(c, inv);
      if (input.amountPence > s.balancePence)
        c.fail(
          422,
          'validation_failed',
          `That is more than the ${formatPence(s.balancePence)} still owed.`,
          { fields: { amountPence: `At most ${formatPence(s.balancePence)}` } },
        );
      if (input.paidOn > today())
        c.fail(422, 'validation_failed', 'The payment date cannot be in the future.', {
          fields: { paidOn: 'In the future' },
        });
      inv.payments.push({ id: c.uid(), ...input, createdAt: c.now() });
      inv.status = statusAfterPayment(
        s.totalPence,
        s.paidPence + input.amountPence,
        s.creditedPence,
      );
      inv.version += 1;
      let jobCompleted = false;
      if (inv.status === 'paid' && settled(c, inv.jobId)) {
        c.completeJob(inv.jobId);
        jobCompleted = true;
      }
      return { ...detail(c, inv), jobCompleted };
    }
  }
  if (a === 'invoices' && id && sub === 'credit-notes' && method === 'POST') {
    const inv = getInvoice(c, id);
    const input = c.parse(creditNoteCreate, body);
    const s = summary(c, inv);
    const blocked = creditBlocker(s);
    if (blocked) c.fail(409, 'invoice_not_creditable', blocked);
    const drafts = (inv.credits ?? [])
      .filter((x) => x.status === 'draft')
      .reduce((t, x) => t + x.amountPence, 0);
    const room = s.balancePence - drafts;
    if (input.amountPence > room)
      c.fail(
        422,
        'validation_failed',
        drafts
          ? `Another draft credit note already covers part of this invoice; ${formatPence(Math.max(0, room))} is left to credit.`
          : `That is more than the ${formatPence(s.balancePence)} still owed on the invoice.`,
        { fields: { amountPence: `At most ${formatPence(Math.max(0, room))}` } },
      );
    const cn: DemoCredit = {
      id: c.uid(),
      number: null,
      status: 'draft',
      issueDate: null,
      reason: input.reason,
      amountPence: input.amountPence,
      approvedAt: null,
      createdAt: c.now(),
      version: 1,
    };
    (inv.credits ??= []).push(cn);
    return creditDto(c, inv, cn);
  }
  if (a === 'credit-notes' && id) {
    const inv = c.b.invoices.find((i) => i.credits?.some((x) => x.id === id));
    const cn = inv?.credits?.find((x) => x.id === id);
    if (!inv || !cn) return notFound(c, 'Credit note');
    if (method === 'GET' && !sub) return creditDto(c, inv, cn);
    if (method === 'DELETE' && !sub) {
      if (cn.status !== 'draft')
        c.fail(
          409,
          'credit_note_locked',
          'An approved credit note keeps its number and cannot be deleted.',
        );
      inv.credits = inv.credits!.filter((x) => x !== cn);
      return null;
    }
    if (method === 'POST' && sub === 'approve') {
      if (cn.status !== 'draft')
        c.fail(409, 'credit_note_not_draft', 'This credit note is already approved.');
      const s = summary(c, inv);
      const blocked = creditBlocker(s);
      if (blocked) c.fail(409, 'invoice_not_creditable', blocked);
      if (cn.amountPence > s.balancePence)
        c.fail(
          422,
          'validation_failed',
          `That is more than the ${formatPence(s.balancePence)} still owed on the invoice.`,
        );
      Object.assign(cn, {
        status: 'approved',
        number: c.creditNumber(true),
        issueDate: today(),
        approvedAt: c.now(),
        version: cn.version + 1,
      });
      inv.status = statusAfterPayment(s.totalPence, s.paidPence, s.creditedPence + cn.amountPence);
      inv.version += 1;
      let jobCompleted = false;
      if (inv.status === 'paid' && settled(c, inv.jobId)) {
        c.completeJob(inv.jobId);
        jobCompleted = true;
      }
      return { ...creditDto(c, inv, cn), jobCompleted };
    }
  }
  return undefined;
}

function creditDto(c: BillingCtx, inv: Invoice, cn: DemoCredit): CreditNoteDto {
  const d = detail(c, inv);
  return {
    id: cn.id,
    number: cn.number,
    status: cn.status,
    issueDate: cn.issueDate,
    reason: cn.reason,
    amountPence: cn.amountPence,
    invoiceId: inv.id,
    invoiceNumber: inv.number ?? 'Draft',
    invoiceTotalPence: d.totalPence,
    invoiceBalancePence: d.balancePence,
    jobId: d.jobId,
    jobNumber: d.jobNumber,
    jobTitle: d.jobTitle,
    billTo: d.billTo,
    approvedByName: cn.approvedAt ? c.userName : null,
    approvedAt: cn.approvedAt,
    createdAt: cn.createdAt,
    nextNumber: cn.status === 'draft' ? c.creditNumber(false) : null,
    version: cn.version,
  };
}
