import {
  quoteDisplayNumber,
  quoteTotals,
  revisionLetter,
  unitSell,
  signedLineTotal,
  type Page,
  type PricedLineInput,
  type QuoteKitSnapshot,
  type QuoteDetailDto,
  type QuoteLineDto,
  type QuoteRevisionDto,
  type QuoteStatus,
  type QuoteSummaryDto,
  type quoteCreate,
  type quoteLineInput,
  type quoteRevisionUpdate,
} from '@lse/shared';
import type { z } from 'zod';
import type { Tx } from '../db/client';
import { assertVersion, conflict, invalid, notFound } from '../lib/errors';
import { iso, isoNN, type Auth } from '../lib/types';
import { audit } from './audit';
import { assertReadyToSendQuote } from './settings';
import { recordCreated, stageByKey } from './stages';
import { assertSiteOfCustomer, toSite } from './customers';

type LineIn = z.output<typeof quoteLineInput>;

interface QuoteRow {
  id: string;
  number: string;
  status: QuoteStatus;
  customerId: string;
  customerName: string;
  siteId: string | null;
  currentRevision: number;
  acceptedRevision: number | null;
  convertedJobId: string | null;
  convertedJobNumber: string | null;
  title: string;
  totalPence: number;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

interface LineRow {
  id: string;
  position: number;
  kind: LineIn['kind'];
  description: string;
  qtyMilli: number;
  unitCostPence: number | null;
  markupBp: number | null;
  unitPricePence: number | null;
  optionLabel: string | null;
  taxRateBp: number;
  kit: QuoteKitSnapshot | null;
}

interface RevisionRow {
  id: string;
  revision: number;
  title: string;
  notes: string | null;
  validDays: number;
  defaultMarkupBp: number;
  acceptedOptions: string[];
  sentAt: Date | null;
  supersededAt: Date | null;
}

const toSummary = (r: QuoteRow): QuoteSummaryDto => ({
  id: r.id,
  number: r.number,
  displayNumber: quoteDisplayNumber(r.number, r.currentRevision),
  status: r.status,
  customerId: r.customerId,
  customerName: r.customerName,
  siteId: r.siteId,
  title: r.title,
  currentRevision: r.currentRevision,
  totalPence: r.totalPence,
  convertedJobId: r.convertedJobId,
  convertedJobNumber: r.convertedJobNumber,
  createdAt: isoNN(r.createdAt),
  updatedAt: isoNN(r.updatedAt),
  version: r.version,
});

const SUMMARY_SELECT = `
  SELECT q.id, q.number, q.status, q.customer_id, c.name AS customer_name, q.site_id, q.current_revision,
         q.accepted_revision, q.converted_job_id, j.number AS converted_job_number,
         r.title, r.total_pence, q.created_at, q.updated_at, q.version
    FROM quotes q
    JOIN customers c ON c.id = q.customer_id
    JOIN quote_revisions r ON r.quote_id = q.id AND r.revision = q.current_revision
    LEFT JOIN jobs j ON j.id = q.converted_job_id`;

export interface QuoteListQuery {
  q?: string | undefined;
  status?: QuoteStatus | undefined;
  customerId?: string | undefined;
  limit: number;
  offset: number;
}

export async function listQuotes(tx: Tx, query: QuoteListQuery): Promise<Page<QuoteSummaryDto>> {
  const conds = [tx`TRUE`];
  if (query.status) conds.push(tx`q.status = ${query.status}`);
  if (query.customerId) conds.push(tx`q.customer_id = ${query.customerId}`);
  if (query.q) {
    const p = `%${query.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    conds.push(tx`(q.number ILIKE ${p} OR r.title ILIKE ${p} OR c.name ILIKE ${p})`);
  }
  const where = conds.reduce((acc, c) => tx`${acc} AND ${c}`);
  const rows = await tx<(QuoteRow & { total: number })[]>`
    ${tx.unsafe(SUMMARY_SELECT)}
    WHERE ${where}
    ORDER BY q.updated_at DESC, q.id
    LIMIT ${query.limit} OFFSET ${query.offset}`;
  // Window count would be skewed by LIMIT on an empty page; a separate count is clearer.
  const [{ count } = { count: 0 }] = await tx<{ count: number }[]>`
    SELECT count(*)::int AS count FROM quotes q
      JOIN customers c ON c.id = q.customer_id
      JOIN quote_revisions r ON r.quote_id = q.id AND r.revision = q.current_revision
     WHERE ${where}`;
  return { items: rows.map(toSummary), total: count };
}

async function loadQuoteRow(tx: Tx, id: string, lock = false): Promise<QuoteRow> {
  if (lock) {
    // Lock the quote row first so status transitions and conversion are serialised.
    const [locked] = await tx`SELECT 1 FROM quotes WHERE id = ${id} FOR UPDATE`;
    if (!locked) throw notFound('Quote');
  }
  const [row] = await tx<QuoteRow[]>`${tx.unsafe(SUMMARY_SELECT)} WHERE q.id = ${id}`;
  if (!row) throw notFound('Quote');
  return row;
}

async function loadRevision(tx: Tx, quoteId: string, revision: number) {
  const [rev] = await tx<RevisionRow[]>`
    SELECT id, revision, title, notes, valid_days, default_markup_bp, accepted_options, sent_at, superseded_at
      FROM quote_revisions WHERE quote_id = ${quoteId} AND revision = ${revision}`;
  if (!rev) throw notFound('Quote revision');
  const lines = await tx<LineRow[]>`
    SELECT id, position, kind, description, qty_milli, unit_cost_pence, markup_bp, unit_price_pence, option_label, tax_rate_bp, kit
      FROM quote_lines WHERE revision_id = ${rev.id} ORDER BY position`;
  return { rev, lines };
}

const priced = (
  l: Pick<
    LineRow,
    'kind' | 'qtyMilli' | 'unitCostPence' | 'markupBp' | 'unitPricePence' | 'optionLabel'
  >,
): PricedLineInput => ({
  kind: l.kind,
  qtyMilli: l.qtyMilli,
  unitCostPence: l.unitCostPence,
  markupBp: l.markupBp,
  unitPricePence: l.unitPricePence,
  optionLabel: l.optionLabel,
});

function toRevisionDto(rev: RevisionRow, lines: LineRow[]): QuoteRevisionDto {
  const defaults = { markupBp: rev.defaultMarkupBp };
  const lineDtos: QuoteLineDto[] = lines.map((l) => {
    const sell = unitSell(priced(l), defaults);
    return { ...l, unitSellPence: sell, totalPence: signedLineTotal(l.qtyMilli, sell) };
  });
  return {
    id: rev.id,
    revision: rev.revision,
    revisionLetter: revisionLetter(rev.revision),
    title: rev.title,
    notes: rev.notes,
    validDays: rev.validDays,
    defaultMarkupBp: rev.defaultMarkupBp,
    sentAt: iso(rev.sentAt),
    supersededAt: iso(rev.supersededAt),
    acceptedOptions: rev.acceptedOptions,
    lines: lineDtos,
    totals: quoteTotals(lines.map(priced), defaults, rev.acceptedOptions),
  };
}

export async function getQuote(tx: Tx, id: string): Promise<QuoteDetailDto> {
  const row = await loadQuoteRow(tx, id);
  const { rev, lines } = await loadRevision(tx, id, row.currentRevision);
  const revisions = await tx<RevisionRow[]>`
    SELECT id, revision, sent_at, superseded_at FROM quote_revisions WHERE quote_id = ${id} ORDER BY revision`;
  const [site] = row.siteId
    ? await tx<
        {
          id: string;
          customerId: string;
          label: string | null;
          address: string;
          notes: string | null;
        }[]
      >`
        SELECT id, customer_id, label, address, notes FROM sites WHERE id = ${row.siteId}`
    : [];
  return {
    ...toSummary(row),
    site: site ? toSite(site) : null,
    revisions: revisions.map((r) => ({
      id: r.id,
      revision: r.revision,
      revisionLetter: revisionLetter(r.revision),
      sentAt: iso(r.sentAt),
      supersededAt: iso(r.supersededAt),
    })),
    current: toRevisionDto(rev, lines),
  };
}

interface TenantDefaults {
  defaultMarkupBp: number;
  labourRatePence: number;
  quoteValidDays: number;
}

export async function tenantDefaults(tx: Tx): Promise<TenantDefaults> {
  const [t] = await tx<
    TenantDefaults[]
  >`SELECT default_markup_bp, labour_rate_pence, quote_valid_days FROM tenants WHERE id = app_current_tenant()`;
  if (!t) throw notFound('Business');
  return t;
}

/** Fills sensible defaults so callers (people or AI helpers) type as little as possible. */
function normaliseLines(lines: LineIn[], defaults: TenantDefaults): LineIn[] {
  return lines.map((l) =>
    l.kind === 'labour' && l.unitPricePence == null && l.unitCostPence == null
      ? { ...l, unitPricePence: defaults.labourRatePence }
      : l,
  );
}

async function writeLines(tx: Tx, auth: Auth, revisionId: string, lines: LineIn[]): Promise<void> {
  await tx`DELETE FROM quote_lines WHERE revision_id = ${revisionId}`;
  if (!lines.length) return;
  const rows = lines.map((l, i) => ({
    tenant_id: auth.tenantId,
    revision_id: revisionId,
    position: i,
    kind: l.kind,
    description: l.description,
    qty_milli: l.qtyMilli,
    unit_cost_pence: l.unitCostPence,
    markup_bp: l.markupBp,
    unit_price_pence: l.unitPricePence,
    option_label: l.optionLabel,
    tax_rate_bp: l.taxRateBp,
    kit: l.kit ? tx.json(l.kit as never) : null,
  }));
  await tx`INSERT INTO quote_lines ${tx(rows)}`;
}

/** Recomputes and stores the revision totals with the shared pricing rules. */
async function refreshTotals(tx: Tx, quoteId: string, revision: number): Promise<void> {
  const { rev, lines } = await loadRevision(tx, quoteId, revision);
  const t = quoteTotals(lines.map(priced), { markupBp: rev.defaultMarkupBp }, rev.acceptedOptions);
  await tx`UPDATE quote_revisions SET core_total_pence = ${t.corePence}, total_pence = ${t.totalPence} WHERE id = ${rev.id}`;
}

export async function createQuote(
  tx: Tx,
  auth: Auth,
  input: z.output<typeof quoteCreate>,
): Promise<QuoteDetailDto> {
  const [customer] = await tx<
    { markupBp: number | null }[]
  >`SELECT markup_bp FROM customers WHERE id = ${input.customerId}`;
  if (!customer)
    throw invalid('Pick a customer for this quote', {
      fields: { customerId: 'Customer not found' },
    });
  await assertSiteOfCustomer(tx, input.siteId, input.customerId);
  const defaults = await tenantDefaults(tx);
  const [num] = await tx<
    { value: number; formatted: string }[]
  >`SELECT * FROM allocate_number('quote')`;
  const [quote] = await tx<{ id: string }[]>`
    INSERT INTO quotes (tenant_id, number, seq_value, customer_id, site_id, created_by)
    VALUES (${auth.tenantId}, ${num!.formatted}, ${num!.value}, ${input.customerId}, ${input.siteId}, ${auth.userId})
    RETURNING id`;
  const [rev] = await tx<{ id: string }[]>`
    INSERT INTO quote_revisions (tenant_id, quote_id, revision, title, notes, valid_days, default_markup_bp)
    VALUES (${auth.tenantId}, ${quote!.id}, 1, ${input.title}, ${input.notes}, ${input.validDays},
            ${customer.markupBp ?? defaults.defaultMarkupBp})
    RETURNING id`;
  await writeLines(tx, auth, rev!.id, normaliseLines(input.lines, defaults));
  await refreshTotals(tx, quote!.id, 1);
  await audit(tx, auth, 'create', 'quote', quote!.id, { number: num!.formatted });
  return getQuote(tx, quote!.id);
}

export async function updateQuote(
  tx: Tx,
  auth: Auth,
  id: string,
  input: z.output<typeof quoteRevisionUpdate>,
  expectedVersion?: number,
): Promise<QuoteDetailDto> {
  const q = await loadQuoteRow(tx, id, true);
  await assertVersion(expectedVersion, q.version, () => getQuote(tx, id));
  if (q.status !== 'draft') {
    throw conflict(
      'quote_locked',
      q.status === 'sent'
        ? 'This quote has been sent. Make a new revision to change it.'
        : `This quote is ${q.status} and can no longer be edited.`,
    );
  }
  const { rev } = await loadRevision(tx, id, q.currentRevision);
  if (input.siteId !== undefined) {
    await assertSiteOfCustomer(tx, input.siteId ?? null, q.customerId);
    await tx`UPDATE quotes SET site_id = ${input.siteId ?? null} WHERE id = ${id}`;
  }
  const patch: Record<string, unknown> = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.notes !== undefined) patch.notes = input.notes;
  if (input.validDays !== undefined) patch.valid_days = input.validDays;
  if (Object.keys(patch).length)
    await tx`UPDATE quote_revisions SET ${tx(patch)} WHERE id = ${rev.id}`;
  if (input.lines !== undefined) {
    await writeLines(tx, auth, rev.id, normaliseLines(input.lines, await tenantDefaults(tx)));
    await refreshTotals(tx, id, q.currentRevision);
  }
  await tx`UPDATE quotes SET updated_at = now() WHERE id = ${id}`;
  await audit(tx, auth, 'update', 'quote', id, { revision: q.currentRevision });
  return getQuote(tx, id);
}

/** Records that the quote went to the customer. (Emailing it comes with the approval inbox.) */
export async function markSent(tx: Tx, auth: Auth, id: string): Promise<QuoteDetailDto> {
  const q = await loadQuoteRow(tx, id, true);
  if (q.status !== 'draft')
    throw conflict('invalid_transition', `Only a draft can be sent; this quote is ${q.status}.`);
  const { rev, lines } = await loadRevision(tx, id, q.currentRevision);
  if (!lines.length) throw invalid('Add at least one line before sending');
  // Never record a £0 quote as sent (a known trap in other apps: see docs/REQUIREMENTS_FROM_REVIEWS.md, M8/A4).
  const totals = quoteTotals(lines.map(priced), { markupBp: rev.defaultMarkupBp }, []);
  if (totals.corePence <= 0) throw invalid('This quote totals £0. Add prices before sending.');
  // Pre-send completeness check: the customer must be able to see who it's from and how to reply.
  await assertReadyToSendQuote(tx);
  await tx`UPDATE quote_revisions SET sent_at = now() WHERE id = ${rev.id}`;
  await tx`UPDATE quotes SET status = 'sent' WHERE id = ${id}`;
  await audit(tx, auth, 'send', 'quote', id, { revision: q.currentRevision });
  return getQuote(tx, id);
}

/** Starts the next revision (rev B, C...) with the same number, copying the lines. */
export async function revise(tx: Tx, auth: Auth, id: string): Promise<QuoteDetailDto> {
  const q = await loadQuoteRow(tx, id, true);
  if (!['sent', 'declined', 'expired'].includes(q.status)) {
    throw conflict(
      'invalid_transition',
      q.status === 'draft'
        ? 'This revision has not been sent yet, so you can edit it directly.'
        : `A ${q.status} quote cannot be revised.`,
    );
  }
  const { rev, lines } = await loadRevision(tx, id, q.currentRevision);
  const next = q.currentRevision + 1;
  await tx`UPDATE quote_revisions SET superseded_at = now() WHERE id = ${rev.id}`;
  const [newRev] = await tx<{ id: string }[]>`
    INSERT INTO quote_revisions (tenant_id, quote_id, revision, title, notes, valid_days, default_markup_bp)
    VALUES (${auth.tenantId}, ${id}, ${next}, ${rev.title}, ${rev.notes}, ${rev.validDays}, ${rev.defaultMarkupBp})
    RETURNING id`;
  await writeLines(
    tx,
    auth,
    newRev!.id,
    lines.map((l) => ({ ...l })),
  );
  await tx`UPDATE quotes SET current_revision = ${next}, status = 'draft' WHERE id = ${id}`;
  await refreshTotals(tx, id, next);
  await audit(tx, auth, 'revise', 'quote', id, { from: q.currentRevision, to: next });
  return getQuote(tx, id);
}

export async function accept(
  tx: Tx,
  auth: Auth,
  id: string,
  acceptedOptions: string[],
): Promise<QuoteDetailDto> {
  const q = await loadQuoteRow(tx, id, true);
  if (q.status !== 'sent') {
    throw conflict(
      'invalid_transition',
      q.status === 'draft'
        ? 'Mark the quote as sent before recording acceptance.'
        : `This quote is already ${q.status}.`,
    );
  }
  const { rev, lines } = await loadRevision(tx, id, q.currentRevision);
  const available = new Set(lines.map((l) => l.optionLabel).filter((x): x is string => !!x));
  const unique = [...new Set(acceptedOptions)];
  const unknown = unique.filter((o) => !available.has(o));
  if (unknown.length)
    throw invalid(`Unknown option: ${unknown.join(', ')}`, {
      fields: { acceptedOptions: 'Not an option on this quote' },
    });
  await tx`UPDATE quote_revisions SET accepted_options = ${unique} WHERE id = ${rev.id}`;
  await tx`UPDATE quotes SET status = 'accepted', accepted_revision = ${q.currentRevision}, accepted_at = now() WHERE id = ${id}`;
  await refreshTotals(tx, id, q.currentRevision);
  await audit(tx, auth, 'accept', 'quote', id, {
    revision: q.currentRevision,
    acceptedOptions: unique,
  });
  return getQuote(tx, id);
}

export async function decline(tx: Tx, auth: Auth, id: string): Promise<QuoteDetailDto> {
  const q = await loadQuoteRow(tx, id, true);
  if (q.status !== 'sent')
    throw conflict(
      'invalid_transition',
      `Only a sent quote can be declined; this one is ${q.status}.`,
    );
  await tx`UPDATE quotes SET status = 'declined' WHERE id = ${id}`;
  await audit(tx, auth, 'decline', 'quote', id);
  return getQuote(tx, id);
}

/**
 * Convert an accepted quote into a job, exactly once.
 * - The quote row is locked (FOR UPDATE), so concurrent converts queue; the loser sees "converted".
 * - UNIQUE(jobs.source_quote_id) is the database backstop.
 * - Copies customer, site, notes, and the core + accepted-option lines of the accepted revision.
 */
export async function convertToJob(
  tx: Tx,
  auth: Auth,
  id: string,
): Promise<{ jobId: string; jobNumber: string }> {
  const q = await loadQuoteRow(tx, id, true);
  if (q.status === 'converted') {
    throw conflict('already_converted', `This quote is already job ${q.convertedJobNumber}.`, {
      jobId: q.convertedJobId,
      jobNumber: q.convertedJobNumber,
    });
  }
  if (q.status !== 'accepted' || q.acceptedRevision == null) {
    throw conflict('not_accepted', 'Only an accepted quote can be turned into a job.');
  }
  const { rev, lines } = await loadRevision(tx, id, q.acceptedRevision);
  const accepted = new Set(rev.acceptedOptions);
  const chosen = lines.filter((l) => l.optionLabel == null || accepted.has(l.optionLabel));
  const [num] = await tx<
    { value: number; formatted: string }[]
  >`SELECT * FROM allocate_number('job')`;
  const unassigned = await stageByKey(tx, 'unassigned');
  const [job] = await tx<{ id: string }[]>`
    INSERT INTO jobs (tenant_id, number, seq_value, customer_id, site_id, title, description,
                      source_quote_id, source_quote_revision, created_by, stage_id)
    VALUES (${auth.tenantId}, ${num!.formatted}, ${num!.value}, ${q.customerId}, ${q.siteId}, ${rev.title}, ${rev.notes},
            ${id}, ${q.acceptedRevision}, ${auth.userId}, ${unassigned.id})
    RETURNING id`;
  await recordCreated(tx, auth, job!.id, unassigned.id, 'created_from_quote');
  if (chosen.length) {
    const defaults = { markupBp: rev.defaultMarkupBp };
    const rows = chosen.map((l, i) => {
      const sell = unitSell(priced(l), defaults);
      return {
        tenant_id: auth.tenantId,
        job_id: job!.id,
        position: i,
        kind: l.kind,
        description: l.optionLabel ? `${l.description} (${l.optionLabel})` : l.description,
        qty_milli: l.qtyMilli,
        unit_cost_pence: l.unitCostPence,
        unit_sell_pence: sell,
        total_pence: signedLineTotal(l.qtyMilli, sell),
        source: 'quote',
        source_quote_line_id: l.id,
      };
    });
    await tx`INSERT INTO job_lines ${tx(rows)}`;
  }
  await tx`UPDATE quotes SET status = 'converted', converted_job_id = ${job!.id}, converted_at = now() WHERE id = ${id}`;
  await audit(tx, auth, 'convert', 'quote', id, { jobId: job!.id, jobNumber: num!.formatted });
  return { jobId: job!.id, jobNumber: num!.formatted };
}
