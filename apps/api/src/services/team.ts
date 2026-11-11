import {
  costRate,
  type JobCostingDto,
  type memberCostUpdate,
  resolveOnCost,
  type TeamMemberDto,
} from '@lse/shared';
import type { z } from 'zod';
import type { Tx } from '../db/client';
import { invalid, notFound } from '../lib/errors';
import type { Auth } from '../lib/types';
import { audit } from './audit';
import { assertAdmin } from './access';
import { jobProfits } from './reports';

const n = (v: unknown) => Number(v ?? 0);

async function labourRate(tx: Tx) {
  const [t] = await tx<{ labourRatePence: string }[]>`
    SELECT labour_rate_pence FROM tenants WHERE id = app_current_tenant()`;
  return n(t?.labourRatePence);
}

/** Settings › Team: each person's charge-out rate beside what they cost. Owner only. */
export async function listTeam(tx: Tx, auth: Auth): Promise<TeamMemberDto[]> {
  // Cost rates area: checked for the route (areaForPath).
  void auth;
  const rate = await labourRate(tx);
  const rows = await tx<
    {
      userId: string;
      name: string;
      role: string;
      baseCostPence: string | null;
      onCostPence: string | null;
      onCostMode: 'fixed' | 'percent' | null;
      onCostBp: number | null;
      chargeOut: string | null;
      isPlaceholder: boolean | null;
    }[]
  >`
    SELECT m.user_id, u.name, m.role, mc.base_cost_pence, mc.on_cost_pence, mc.on_cost_mode,
           mc.on_cost_bp, mc.is_placeholder, co.charge_out_pence AS charge_out
      FROM memberships m
      JOIN users u ON u.id = m.user_id
      LEFT JOIN member_costs mc ON mc.user_id = m.user_id AND mc.tenant_id = m.tenant_id
      LEFT JOIN member_charge_out co ON co.user_id = m.user_id AND co.tenant_id = m.tenant_id
     WHERE m.tenant_id = app_current_tenant()
     ORDER BY (m.role = 'owner') DESC, u.name`;
  return rows.map((r) => {
    const set = r.baseCostPence !== null;
    return {
      userId: r.userId,
      name: r.name,
      role: r.role,
      chargeOutPence: r.chargeOut === null ? rate : n(r.chargeOut),
      chargeOutIsDefault: r.chargeOut === null,
      baseCostPence: set ? n(r.baseCostPence) : null,
      onCostPence: set ? n(r.onCostPence) : null,
      onCostMode: set ? r.onCostMode : null,
      onCostBp: set && r.onCostMode === 'percent' ? r.onCostBp : null,
      costRatePence: set ? costRate(n(r.baseCostPence), n(r.onCostPence)) : null,
      isPlaceholder: !!r.isPlaceholder,
    };
  });
}

/** Owner sets (or clears, with null) a person's cost rate. Saving confirms it: no longer a placeholder. */
export async function setMemberCost(
  tx: Tx,
  auth: Auth,
  userId: string,
  input: z.output<typeof memberCostUpdate>,
  opts: { placeholder?: boolean } = {},
): Promise<TeamMemberDto> {
  assertAdmin(auth, 'set what people cost');
  const [m] =
    await tx`SELECT 1 FROM memberships WHERE user_id = ${userId} AND tenant_id = ${auth.tenantId}`;
  if (!m) throw invalid('That person is not part of this business');
  if (input === null) {
    await tx`DELETE FROM member_costs WHERE user_id = ${userId}`;
  } else {
    const on = resolveOnCost(input);
    if (input.baseCostPence + on.pence > 200_000 || on.pence > 100_000)
      throw invalid('That cost per hour is too high', { fields: { onCostBp: 'Too high' } });
    await tx`
      INSERT INTO member_costs (tenant_id, user_id, base_cost_pence, on_cost_pence, on_cost_mode,
                                on_cost_bp, is_placeholder, updated_by)
      VALUES (${auth.tenantId}, ${userId}, ${input.baseCostPence}, ${on.pence}, ${on.mode}, ${on.bp},
              ${opts.placeholder ?? false}, ${auth.userId})
      ON CONFLICT (tenant_id, user_id) DO UPDATE
        SET base_cost_pence = EXCLUDED.base_cost_pence, on_cost_pence = EXCLUDED.on_cost_pence,
            on_cost_mode = EXCLUDED.on_cost_mode, on_cost_bp = EXCLUDED.on_cost_bp,
            is_placeholder = EXCLUDED.is_placeholder, updated_by = EXCLUDED.updated_by, updated_at = now()`;
  }
  await audit(tx, auth, 'member_cost_set', 'user', userId, { cost: input });
  const team = await listTeam(tx, auth);
  return team.find((t) => t.userId === userId)!;
}

/** Owner sets (or clears, with null) a person's own charge-out rate. */
export async function setChargeOut(
  tx: Tx,
  auth: Auth,
  userId: string,
  chargeOutPence: number | null,
): Promise<TeamMemberDto> {
  assertAdmin(auth, 'set charge-out rates');
  const [m] =
    await tx`SELECT 1 FROM memberships WHERE user_id = ${userId} AND tenant_id = ${auth.tenantId}`;
  if (!m) throw invalid('That person is not part of this business');
  if (chargeOutPence === null) await tx`DELETE FROM member_charge_out WHERE user_id = ${userId}`;
  else
    await tx`
      INSERT INTO member_charge_out (tenant_id, user_id, charge_out_pence, updated_by)
      VALUES (${auth.tenantId}, ${userId}, ${chargeOutPence}, ${auth.userId})
      ON CONFLICT (tenant_id, user_id) DO UPDATE
        SET charge_out_pence = EXCLUDED.charge_out_pence, updated_by = EXCLUDED.updated_by,
            updated_at = now()`;
  await audit(tx, auth, 'member_charge_out_set', 'user', userId, { chargeOutPence });
  return (await listTeam(tx, auth)).find((t) => t.userId === userId)!;
}

/** Quote against actual for one job: owner only (it shows what people cost). */
export async function jobCosting(tx: Tx, auth: Auth, jobId: string): Promise<JobCostingDto> {
  // Reports and profit area: checked for the route (areaForPath).
  void auth;
  const rate = await labourRate(tx);
  const { jobs, labour } = await jobProfits(tx, rate, jobId);
  const profit = jobs[0];
  if (!profit) throw notFound('Job');
  const [q] = await tx<
    { labourMilli: string; labour: string; materials: string; other: string; extraSell: string }[]
  >`
    SELECT COALESCE(SUM(qty_milli) FILTER (WHERE kind = 'labour' AND source = 'quote'), 0) AS labour_milli,
           COALESCE(SUM(total_pence) FILTER (WHERE kind = 'labour' AND source = 'quote'), 0) AS labour,
           COALESCE(SUM(total_pence) FILTER (WHERE kind = 'material' AND source = 'quote'), 0) AS materials,
           COALESCE(SUM(total_pence) FILTER (WHERE kind NOT IN ('labour', 'material') AND source = 'quote'), 0) AS other,
           COALESCE(SUM(total_pence) FILTER (WHERE kind = 'material' AND source <> 'quote'), 0) AS extra_sell
      FROM job_lines WHERE job_id = ${jobId}`;
  const rows = labour.get(jobId) ?? [];
  return {
    profit,
    quoted: {
      labourMinutes: Math.round((n(q?.labourMilli) * 60) / 1000),
      labourPence: n(q?.labour),
      materialsPence: n(q?.materials),
      otherPence: n(q?.other),
    },
    labour: rows,
    extraMaterialsSellPence: n(q?.extraSell),
    allRatesSet: rows.every((r) => !r.rateIsDefault),
  };
}
