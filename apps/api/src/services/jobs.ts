import type {
  JobDetailDto,
  JobLineDto,
  JobStatus,
  JobSummaryDto,
  Page,
  jobCreate,
  jobUpdate,
} from '@lse/shared';
import type { z } from 'zod';
import type { Tx } from '../db/client';
import { assertVersion, invalid, notFound } from '../lib/errors';
import { isoNN, type Auth } from '../lib/types';
import { audit } from './audit';
import { assertSiteOfCustomer, toSite } from './customers';

interface JobRow {
  id: string;
  number: string;
  status: JobStatus;
  customerId: string;
  customerName: string;
  siteId: string | null;
  siteAddress: string | null;
  title: string;
  sourceQuoteId: string | null;
  sourceQuoteNumber: string | null;
  quotedTotalPence: number;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

const SUMMARY_SELECT = `
  SELECT j.id, j.number, j.status, j.customer_id, c.name AS customer_name, j.site_id, s.address AS site_address,
         j.title, j.source_quote_id, q.number AS source_quote_number,
         coalesce((SELECT sum(total_pence) FROM job_lines jl WHERE jl.job_id = j.id AND jl.source = 'quote'), 0)::bigint
           AS quoted_total_pence,
         j.created_at, j.updated_at, j.version
    FROM jobs j
    JOIN customers c ON c.id = j.customer_id
    LEFT JOIN sites s ON s.id = j.site_id
    LEFT JOIN quotes q ON q.id = j.source_quote_id`;

const toSummary = (r: JobRow): JobSummaryDto => ({
  id: r.id,
  number: r.number,
  status: r.status,
  customerId: r.customerId,
  customerName: r.customerName,
  siteId: r.siteId,
  siteAddress: r.siteAddress,
  title: r.title,
  sourceQuoteId: r.sourceQuoteId,
  sourceQuoteNumber: r.sourceQuoteNumber,
  quotedTotalPence: r.quotedTotalPence,
  createdAt: isoNN(r.createdAt),
  updatedAt: isoNN(r.updatedAt),
  version: r.version,
});

export interface JobListQuery {
  q?: string | undefined;
  status?: JobStatus | undefined;
  /** "active" = everything not completed or cancelled. */
  active?: boolean | undefined;
  customerId?: string | undefined;
  limit: number;
  offset: number;
}

export async function listJobs(tx: Tx, query: JobListQuery): Promise<Page<JobSummaryDto>> {
  const conds = [tx`TRUE`];
  if (query.status) conds.push(tx`j.status = ${query.status}`);
  if (query.active) conds.push(tx`j.status NOT IN ('completed', 'cancelled')`);
  if (query.customerId) conds.push(tx`j.customer_id = ${query.customerId}`);
  if (query.q) {
    const p = `%${query.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    conds.push(
      tx`(j.number ILIKE ${p} OR j.title ILIKE ${p} OR c.name ILIKE ${p} OR s.address ILIKE ${p})`,
    );
  }
  const where = conds.reduce((acc, c) => tx`${acc} AND ${c}`);
  const rows = await tx<JobRow[]>`
    ${tx.unsafe(SUMMARY_SELECT)} WHERE ${where}
    ORDER BY j.seq_value DESC NULLS LAST, j.created_at DESC
    LIMIT ${query.limit} OFFSET ${query.offset}`;
  const [{ count } = { count: 0 }] = await tx<{ count: number }[]>`
    SELECT count(*)::int AS count FROM jobs j
      JOIN customers c ON c.id = j.customer_id LEFT JOIN sites s ON s.id = j.site_id
     WHERE ${where}`;
  return { items: rows.map(toSummary), total: count };
}

export async function getJob(tx: Tx, id: string): Promise<JobDetailDto> {
  const [row] = await tx<JobRow[]>`${tx.unsafe(SUMMARY_SELECT)} WHERE j.id = ${id}`;
  if (!row) throw notFound('Job');
  const [extra] = await tx<
    {
      description: string | null;
      placeOfWork: JobDetailDto['placeOfWork'];
      sourceQuoteRevision: number | null;
    }[]
  >`
    SELECT description, place_of_work, source_quote_revision FROM jobs WHERE id = ${id}`;
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
  const lines = await tx<JobLineDto[]>`
    SELECT id, position, kind, description, qty_milli, unit_cost_pence, unit_sell_pence, total_pence, source
      FROM job_lines WHERE job_id = ${id} ORDER BY position`;
  return {
    ...toSummary(row),
    description: extra!.description,
    placeOfWork: extra!.placeOfWork,
    sourceQuoteRevision: extra!.sourceQuoteRevision,
    site: site ? toSite(site) : null,
    lines: [...lines],
  };
}

/** A job from scratch, for call-outs and small jobs without a quote. */
export async function createJob(
  tx: Tx,
  auth: Auth,
  input: z.output<typeof jobCreate>,
): Promise<JobDetailDto> {
  const [customer] = await tx`SELECT 1 FROM customers WHERE id = ${input.customerId}`;
  if (!customer)
    throw invalid('Pick a customer for this job', { fields: { customerId: 'Customer not found' } });
  await assertSiteOfCustomer(tx, input.siteId, input.customerId);
  const [num] = await tx<
    { value: number; formatted: string }[]
  >`SELECT * FROM allocate_number('job')`;
  const [job] = await tx<{ id: string }[]>`
    INSERT INTO jobs (tenant_id, number, seq_value, customer_id, site_id, title, description, place_of_work, created_by)
    VALUES (${auth.tenantId}, ${num!.formatted}, ${num!.value}, ${input.customerId}, ${input.siteId}, ${input.title},
            ${input.description}, ${input.placeOfWork}, ${auth.userId})
    RETURNING id`;
  await audit(tx, auth, 'create', 'job', job!.id, { number: num!.formatted });
  return getJob(tx, job!.id);
}

export async function updateJob(
  tx: Tx,
  auth: Auth,
  id: string,
  input: z.output<typeof jobUpdate>,
  expectedVersion?: number,
): Promise<JobDetailDto> {
  const [current] = await tx<
    { customerId: string; version: number }[]
  >`SELECT customer_id, version FROM jobs WHERE id = ${id} FOR UPDATE`;
  if (!current) throw notFound('Job');
  await assertVersion(expectedVersion, current.version, () => getJob(tx, id));
  const patch: Record<string, unknown> = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.description !== undefined) patch.description = input.description;
  if (input.status !== undefined) patch.status = input.status;
  if (input.placeOfWork !== undefined) patch.place_of_work = input.placeOfWork;
  if (input.siteId !== undefined) {
    await assertSiteOfCustomer(tx, input.siteId ?? null, current.customerId);
    patch.site_id = input.siteId ?? null;
  }
  if (Object.keys(patch).length) {
    await tx`UPDATE jobs SET ${tx(patch)} WHERE id = ${id}`;
    await audit(tx, auth, 'update', 'job', id, { fields: Object.keys(patch) });
  }
  return getJob(tx, id);
}
