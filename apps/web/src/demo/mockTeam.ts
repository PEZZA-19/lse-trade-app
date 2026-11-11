import { costRate, memberCostUpdate, type TeamMemberDto } from '@lse/shared';
import type { z } from 'zod';

export type TeamDb = Record<string, { base: number; on: number; placeholder: boolean }>;

/** Demo cost rates: obvious placeholders until the owner types real ones. */
export const freshTeam = (ids: string[]): TeamDb =>
  Object.fromEntries(ids.map((id) => [id, { base: 2000, on: 400, placeholder: true }]));

export interface TeamCtx {
  team: TeamDb;
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
      chargeOutPence: c.labourRatePence,
      baseCostPence: t ? t.base : null,
      onCostPence: t ? t.on : null,
      costRatePence: t ? costRate(t.base, t.on) : null,
      isPlaceholder: !!t?.placeholder,
    };
  });
}

/** GET /team and PUT /team/:id/cost, same rules as the server (the demo user is the owner). */
export function teamRoute(c: TeamCtx, method: string, seg: string[], body: unknown): unknown {
  if (seg[0] !== 'team') return undefined;
  if (method === 'GET' && seg.length === 1) return teamList(c);
  if (method === 'PUT' && seg[2] === 'cost') {
    const id = seg[1]!;
    if (!c.members.some((m) => m.userId === id))
      c.fail(422, 'validation', 'That person is not part of this business');
    const input = c.parse(memberCostUpdate, body ?? null);
    if (input === null) delete c.team[id];
    else c.team[id] = { base: input.baseCostPence, on: input.onCostPence, placeholder: false };
    return teamList(c).find((t) => t.userId === id);
  }
  return undefined;
}
