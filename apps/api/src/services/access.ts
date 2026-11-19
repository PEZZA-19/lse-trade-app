import {
  ACCESS_AREAS,
  canSee,
  defaultAccess,
  presetOf,
  type Access,
  type AccessArea,
  type MemberAccessDto,
  type accessUpdate,
} from '@lse/shared';
import type { z } from 'zod';
import type { Tx } from '../db/client';
import { AppError, invalid, notFound } from '../lib/errors';
import { isUuid } from '../lib/validate';
import type { Auth } from '../lib/types';
import { audit } from './audit';

const order = (areas: string[]) => ACCESS_AREAS.filter((a) => areas.includes(a)) as AccessArea[];

/** This person's access: what an admin chose, else the default for their role. Owners are always admins. */
export async function accessFor(tx: Tx, userId: string, role: string): Promise<Access> {
  if (role === 'owner') return defaultAccess('owner');
  const [row] = await tx<{ isAdmin: boolean; areas: string[] }[]>`
    SELECT is_admin, areas FROM member_access WHERE user_id = ${userId}`;
  if (!row) return defaultAccess(role);
  return row.isAdmin
    ? { isAdmin: true, areas: [...ACCESS_AREAS] }
    : { isAdmin: false, areas: order(row.areas) };
}

export const accessOf = (auth: Auth): Access => auth.access ?? defaultAccess(auth.role);

/** Area grants do not widen job scope. Only an explicit admin promotion does. */
export const assignmentScoped = (auth: Auth) =>
  auth.role === 'subcontractor' && !accessOf(auth).isAdmin;

/** Use transaction identity for guards/replays too, not a role loaded before a concurrent demotion. */
export async function assignmentScopedIn(tx: Tx): Promise<boolean> {
  const [row] = await tx<{ scoped: boolean }[]>`SELECT app_assignment_scoped() AS scoped`;
  return row?.scoped ?? true;
}

/** RLS supplies the live assignment predicate as well as tenant isolation. */
export async function assertJobVisible(tx: Tx, jobId: string) {
  const [job] = await tx`SELECT 1 FROM jobs WHERE id = ${jobId}`;
  if (!job) throw notFound('Job');
}

/** Runs inside the route transaction, before service work and before cached responses. */
export async function assertScopedRequest(tx: Tx, method: string, path: string) {
  const job = /^\/api\/jobs\/([^/]+)(?:\/|$)/.exec(path);
  if (job) {
    if (!isUuid(job[1]!)) throw notFound('Job');
    await assertJobVisible(tx, job[1]!);
  }
  if (!(await assignmentScopedIn(tx))) return;
  if (path === '/api/supplier-bills/read')
    throw new AppError(403, 'no_access', 'The business-wide AI inbox is not available to you.');
  const child =
    /^\/api\/(appointments|timesheets|job-lines|notes|photos|invoices|credit-notes|supplier-bills|quotes)\/([^/]+)(?:\/|$)/.exec(
      path,
    );
  if (child) {
    const tables: Record<string, string> = {
      appointments: 'appointments',
      timesheets: 'timesheets',
      'job-lines': 'job_lines',
      notes: 'job_notes',
      photos: 'job_photos',
      invoices: 'invoices',
      'credit-notes': 'credit_notes',
      'supplier-bills': 'supplier_bills',
      quotes: 'quotes',
    };
    if (!isUuid(child[2]!)) throw notFound('Record');
    const [record] = await tx`SELECT 1 FROM ${tx(tables[child[1]!]!)} WHERE id = ${child[2]!}`;
    if (!record) throw notFound('Record');
  }
  if (
    (method === 'POST' && path === '/api/jobs') ||
    /\/(assignees)(\/|$)/.test(path) ||
    /^\/api\/quotes\/[^/]+\/convert$/.test(path) ||
    /^\/api\/(enquiries|proposals|bank)(\/|$)/.test(path) ||
    (method !== 'GET' && /^\/api\/job-stages(?:\/|$)/.test(path)) ||
    /^\/api\/supplier-bills\/[^/]+\/suggest-prices$/.test(path)
  )
    throw new AppError(
      403,
      'no_access',
      'This action needs business-wide job access. Ask an admin.',
    );
}

async function assertRecordVisible(tx: Tx, table: string, id: string) {
  const [record] = await tx`SELECT 1 FROM ${tx(table)} WHERE id = ${id}`;
  if (!record) throw notFound('Record');
}

/** Cached responses can outlive an assignment; never replay their old job identifiers blindly. */
export async function assertVisibleJobReferences(tx: Tx, value: unknown): Promise<void> {
  if (Array.isArray(value)) {
    for (const item of value) await assertVisibleJobReferences(tx, item);
  } else if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    for (const key of ['jobId', 'convertedJobId'])
      if (typeof row[key] === 'string' && isUuid(row[key])) await assertJobVisible(tx, row[key]);
    const parents: Record<string, string> = {
      invoiceId: 'invoices',
      creditId: 'invoices',
      creditInvoiceId: 'invoices',
      billId: 'supplier_bills',
      quoteId: 'quotes',
      jobLineId: 'job_lines',
    };
    for (const [key, table] of Object.entries(parents))
      if (typeof row[key] === 'string' && isUuid(row[key]))
        await assertRecordVisible(tx, table, row[key]);
    // A bill may have been moved to another job since its creation response was cached.
    if (typeof row.id === 'string' && isUuid(row.id)) {
      if ('supplierId' in row && 'billDate' in row)
        await assertRecordVisible(tx, 'supplier_bills', row.id);
      if ('remainingPence' in row && 'issueDate' in row)
        await assertRecordVisible(tx, 'invoices', row.id);
    }
    // Job summaries/details use `id`, rather than `jobId`.
    if (typeof row.id === 'string' && isUuid(row.id) && 'stage' in row && 'customerId' in row)
      await assertJobVisible(tx, row.id);
    for (const item of Object.values(row)) await assertVisibleJobReferences(tx, item);
  }
}

export function assertArea(auth: Auth, area: AccessArea) {
  if (!canSee(accessOf(auth), area))
    throw new AppError(403, 'no_access', 'You don’t have access to this. Ask an admin.', { area });
}

export function assertAdmin(auth: Auth, what: string) {
  if (!accessOf(auth).isAdmin) throw new AppError(403, 'admin_only', `Only an admin can ${what}.`);
}

export async function listAccess(tx: Tx, auth: Auth): Promise<MemberAccessDto[]> {
  assertAdmin(auth, 'see who can access what');
  const rows = await tx<{ userId: string; name: string; role: string }[]>`
    SELECT m.user_id, u.name, m.role FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.tenant_id = app_current_tenant()
     ORDER BY (m.role = 'owner') DESC, u.name`;
  const out: MemberAccessDto[] = [];
  for (const r of rows) {
    const a = await accessFor(tx, r.userId, r.role);
    out.push({
      ...r,
      ...a,
      preset:
        r.role === 'subcontractor' && !a.isAdmin && !a.areas.length ? 'subcontractor' : presetOf(a),
    });
  }
  return out;
}

/** An admin sets someone's access. Owners stay admins; there is always at least one admin. */
export async function setAccess(
  tx: Tx,
  auth: Auth,
  userId: string,
  input: z.output<typeof accessUpdate>,
): Promise<MemberAccessDto> {
  assertAdmin(auth, 'change who can access what');
  // Changes are serialised by the advisory lock below (memberships is read-only to the API).
  await tx`SELECT pg_advisory_xact_lock(hashtext('member_access:' || ${auth.tenantId}))`;
  const [m] = await tx<{ role: string }[]>`
    SELECT role FROM memberships WHERE user_id = ${userId} AND tenant_id = ${auth.tenantId}`;
  if (!m) throw invalid('That person is not part of this business');
  if (m.role === 'owner' && !input.isAdmin)
    throw invalid('The owner is always an admin.', {
      fields: { isAdmin: 'Always on for the owner' },
    });
  if (!input.isAdmin) {
    // Make sure an admin would remain.
    const others = await tx<{ n: string }[]>`
      SELECT count(*) AS n FROM memberships m
        LEFT JOIN member_access a ON a.user_id = m.user_id AND a.tenant_id = m.tenant_id
       WHERE m.tenant_id = ${auth.tenantId} AND m.user_id <> ${userId}
         AND (m.role = 'owner' OR a.is_admin)`;
    if (Number(others[0]!.n) === 0)
      throw invalid('There must always be at least one admin.', {
        fields: { isAdmin: 'Last admin' },
      });
  }
  const areas = input.isAdmin ? [...ACCESS_AREAS] : order(input.areas);
  await tx`
    INSERT INTO member_access (tenant_id, user_id, is_admin, areas, updated_by)
    VALUES (${auth.tenantId}, ${userId}, ${input.isAdmin}, ${areas}, ${auth.userId})
    ON CONFLICT (tenant_id, user_id) DO UPDATE
      SET is_admin = EXCLUDED.is_admin, areas = EXCLUDED.areas, updated_by = EXCLUDED.updated_by,
          updated_at = now()`;
  await audit(tx, auth, 'member_access_set', 'user', userId, { isAdmin: input.isAdmin, areas });
  return (await listAccess(tx, auth)).find((x) => x.userId === userId)!;
}
