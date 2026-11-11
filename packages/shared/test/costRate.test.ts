import { describe, expect, it } from 'vitest';
import {
  costRate,
  formatPercentBp,
  memberCostUpdate,
  onCostFromPercent,
  parsePercentBp,
  resolveOnCost,
} from '../src';

describe('tax and on-costs as a percentage', () => {
  it('£20 + 22.5% = £24.50', () => {
    const on = onCostFromPercent(2000, 2250);
    expect(on).toBe(450);
    expect(costRate(2000, on)).toBe(2450);
  });

  it('rounds half up to the penny', () => {
    expect(onCostFromPercent(1000, 5)).toBe(1); // 0.5p → 1p
    expect(onCostFromPercent(1000, 4)).toBe(0); // 0.4p → 0p
    expect(onCostFromPercent(1999, 2250)).toBe(450); // 449.775p → 450p
    expect(onCostFromPercent(2002, 2250)).toBe(450); // 450.45p → 450p
    expect(onCostFromPercent(1850, 1380)).toBe(255); // 255.3p → 255p
    expect(onCostFromPercent(0, 2250)).toBe(0);
  });

  it('parses and shows percentages exactly (no floating point)', () => {
    expect(parsePercentBp('22.5')).toBe(2250);
    expect(parsePercentBp(' 22.50 % ')).toBe(2250);
    expect(parsePercentBp('7.25')).toBe(725);
    expect(parsePercentBp('0')).toBe(0);
    expect(parsePercentBp('200')).toBe(20000);
    for (const bad of ['', 'abc', '-5', '22.555', '201', '1e2'])
      expect(parsePercentBp(bad)).toBeNull();
    expect(formatPercentBp(2250)).toBe('22.5');
    expect(formatPercentBp(2000)).toBe('20');
    expect(formatPercentBp(725)).toBe('7.25');
    expect(formatPercentBp(5)).toBe('0.05');
    for (const bp of [0, 5, 50, 725, 1380, 2250, 20000])
      expect(parsePercentBp(formatPercentBp(bp))).toBe(bp);
  });

  it('switching modes: each resolves from its own input; old fixed-only input still works', () => {
    const pct = memberCostUpdate.parse({
      baseCostPence: 2000,
      onCostMode: 'percent',
      onCostBp: 2250,
    })!;
    expect(resolveOnCost(pct)).toEqual({ mode: 'percent', bp: 2250, pence: 450 });
    // A fixed amount left over in the request is ignored in percent mode.
    const pctWithStale = memberCostUpdate.parse({
      baseCostPence: 2000,
      onCostMode: 'percent',
      onCostBp: 1000,
      onCostPence: 999,
    })!;
    expect(resolveOnCost(pctWithStale).pence).toBe(200);
    const fixed = memberCostUpdate.parse({
      baseCostPence: 2000,
      onCostMode: 'fixed',
      onCostPence: 300,
      onCostBp: 2250,
    })!;
    expect(resolveOnCost(fixed)).toEqual({ mode: 'fixed', bp: null, pence: 300 });
    const legacy = memberCostUpdate.parse({ baseCostPence: 2000, onCostPence: 455 })!;
    expect(resolveOnCost(legacy)).toEqual({ mode: 'fixed', bp: null, pence: 455 });
    expect(memberCostUpdate.safeParse({ baseCostPence: 2000, onCostMode: 'percent' }).success).toBe(
      false,
    );
    expect(memberCostUpdate.safeParse({ baseCostPence: 2000, onCostMode: 'fixed' }).success).toBe(
      false,
    );
    expect(
      memberCostUpdate.safeParse({ baseCostPence: 2000, onCostMode: 'percent', onCostBp: 20001 })
        .success,
    ).toBe(false);
  });
});
