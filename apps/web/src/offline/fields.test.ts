import { describe, expect, it } from 'vitest';
import { sameValue } from './fields';

describe('sameValue', () => {
  it('treats blank, undefined and null alike', () => {
    expect(sameValue('', null)).toBe(true);
    expect(sameValue(undefined, null)).toBe(true);
    expect(sameValue('a', null)).toBe(false);
  });
  it('a freshly typed line equals its saved copy (server fills defaults and ids)', () => {
    const typed = [{ kind: 'labour', description: 'Fit sockets', unitPricePence: 4500 }];
    const saved = [
      {
        id: 'x',
        position: 0,
        kind: 'labour',
        description: 'Fit sockets',
        qtyMilli: 1000,
        unitCostPence: null,
        markupBp: null,
        unitPricePence: 4500,
        optionLabel: null,
        taxRateBp: 0,
        unitSellPence: 4500,
      },
    ];
    expect(sameValue(typed, saved)).toBe(true);
    expect(sameValue(typed, [{ ...saved[0], description: 'Fit 2 sockets' }])).toBe(false);
  });
});
