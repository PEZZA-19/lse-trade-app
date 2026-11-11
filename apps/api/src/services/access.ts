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
import { AppError, invalid } from '../lib/errors';
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
