import {
  ACCESS_AREAS,
  accessUpdate,
  defaultAccess,
  presetOf,
  type Access,
  type MemberAccessDto,
  chargeOutUpdate,
  costRate,
  memberCostUpdate,
  resolveOnCost,
  type TeamMemberDto,
} from '@lse/shared';
import type { z } from 'zod';

/** `on` is always the £/h amount; `bp` is set in percent mode (older saved demos have neither: fixed). */
export type TeamDb = Record<
  string,
  { base: number; on: number; placeholder: boolean; mode?: 'fixed' | 'percent'; bp?: number | null }
>;

/** Demo cost rates: obvious placeholders until the owner types real ones. */
export const freshTeam = (ids: string[]): TeamDb =>
  Object.fromEntries(ids.map((id) => [id, { base: 2000, on: 400, placeholder: true }]));

export interface TeamCtx {
  team: TeamDb;
  /** Own charge-out rates (pence/h); missing = the business labour rate. */
  chargeOut: Record<string, number>;
  /** Access chosen by an admin; missing = the role's default. */
  access: Record<string, Access>;
  members: { userId: string; name: string; role: string }[];
  labourRatePence: number;
  parse: <S extends z.ZodType>(schema: S, data: unknown) => z.output<S>;
  fail: (status: number, code: string, message: string) => never;
}

export function teamList(c: TeamCtx): TeamMemberDto[] {
  return c.members.map((m) => {
    const t = c.team[m.userId];
    return {
      userId: m.userId,
      name: m.name,
      role: m.role,
      chargeOutPence: c.chargeOut[m.userId] ?? c.labourRatePence,
      chargeOutIsDefault: c.chargeOut[m.userId] === undefined,
      baseCostPence: t ? t.base : null,
      onCostPence: t ? t.on : null,
      onCostMode: t ? (t.mode ?? 'fixed') : null,
      onCostBp: t?.mode === 'percent' ? (t.bp ?? null) : null,
      costRatePence: t ? costRate(t.base, t.on) : null,
      isPlaceholder: !!t?.placeholder,
    };
  });
}

/** GET /team and PUT /team/:id/cost, same rules as the server (the demo user is the owner). */
export function teamRoute(c: TeamCtx, method: string, seg: string[], body: unknown): unknown {
  if (seg[0] !== 'team') return undefined;
  if (method === 'GET' && seg.length === 1) return teamList(c);
  if (method === 'GET' && seg[1] === 'access' && seg.length === 2) return accessList(c);
  if (method === 'PUT' && seg[2] === 'access') {
    const id = seg[1]!;
    const m = c.members.find((x) => x.userId === id);
    if (!m) return c.fail(422, 'validation', 'That person is not part of this business');
    const input = c.parse(accessUpdate, body ?? null);
    if (m.role === 'owner' && !input.isAdmin)
      c.fail(422, 'validation_failed', 'The owner is always an admin.');
    if (!input.isAdmin && !accessList(c).some((a) => a.userId !== id && a.isAdmin))
      c.fail(422, 'validation_failed', 'There must always be at least one admin.');
    c.access[id] = {
      isAdmin: input.isAdmin,
      areas: input.isAdmin
        ? [...ACCESS_AREAS]
        : ACCESS_AREAS.filter((a) => input.areas.includes(a)),
    };
    return accessList(c).find((a) => a.userId === id);
  }
  if (method === 'PUT' && seg[2] === 'charge-out') {
    const id = seg[1]!;
    if (!c.members.some((m) => m.userId === id))
      c.fail(422, 'validation', 'That person is not part of this business');
    const { chargeOutPence } = c.parse(chargeOutUpdate, body ?? null);
    if (chargeOutPence === null) delete c.chargeOut[id];
    else c.chargeOut[id] = chargeOutPence;
    return teamList(c).find((t) => t.userId === id);
  }
  if (method === 'PUT' && seg[2] === 'cost') {
    const id = seg[1]!;
    if (!c.members.some((m) => m.userId === id))
      c.fail(422, 'validation', 'That person is not part of this business');
    const input = c.parse(memberCostUpdate, body ?? null);
    if (input === null) delete c.team[id];
    else {
      const on = resolveOnCost(input);
      if (on.pence > 100_000) c.fail(422, 'validation_failed', 'That cost per hour is too high');
      c.team[id] = {
        base: input.baseCostPence,
        on: on.pence,
        mode: on.mode,
        bp: on.bp,
        placeholder: false,
      };
    }
    return teamList(c).find((t) => t.userId === id);
  }
  return undefined;
}

type Role = Parameters<typeof defaultAccess>[0];
export function accessOf(c: Pick<TeamCtx, 'access'>, userId: string, role: string): Access {
  if (role === 'owner') return defaultAccess('owner');
  return c.access[userId] ?? defaultAccess(role as Role);
}

export function accessList(c: TeamCtx): MemberAccessDto[] {
  return c.members.map((m) => {
    const a = accessOf(c, m.userId, m.role);
    return { userId: m.userId, name: m.name, role: m.role, preset: presetOf(a), ...a };
  });
}
