import { describe, expect, it } from 'vitest';
import { quoteTotals, unitSell, type PricedLineInput } from '../src';

const base: PricedLineInput = {
  kind: 'material',
  qtyMilli: 1000,
  unitCostPence: null,
  markupBp: null,
  unitPricePence: null,
  optionLabel: null,
};
const defaults = { markupBp: 13000 };

describe('unitSell', () => {
  it('prefers an explicit price', () => {
    expect(unitSell({ ...base, unitCostPence: 1000, unitPricePence: 999 }, defaults)).toBe(999);
  });
  it('uses the default markup, then a line markup', () => {
    expect(unitSell({ ...base, unitCostPence: 1000 }, defaults)).toBe(1300);
    expect(unitSell({ ...base, unitCostPence: 1000, markupBp: 11000 }, defaults)).toBe(1100);
  });
  it('passes PC sums through at cost by default', () => {
    expect(unitSell({ ...base, kind: 'pc_sum', unitCostPence: 50000 }, defaults)).toBe(50000);
  });
  it('is zero with no price or cost', () => {
    expect(unitSell(base, defaults)).toBe(0);
  });
});

describe('quoteTotals', () => {
  const lines: PricedLineInput[] = [
    { ...base, kind: 'labour', qtyMilli: 8000, unitPricePence: 4500, unitCostPence: 2000 },
    { ...base, qtyMilli: 3000, unitCostPence: 1234 }, // 1604.2 -> 1605 each, x3 = 4815
    { ...base, kind: 'carriage', unitPricePence: 2500 },
    { ...base, optionLabel: 'Outside light', unitCostPence: 4000 }, // 5200
    { ...base, optionLabel: 'EV charger', unitPricePence: 95000 },
  ];

  it('separates core scope from options', () => {
    const t = quoteTotals(lines, defaults);
    expect(t.corePence).toBe(36000 + 4815 + 2500);
    expect(t.options).toEqual({ 'Outside light': 5200, 'EV charger': 95000 });
    expect(t.totalPence).toBe(t.corePence);
  });
  it('adds accepted options only', () => {
    const t = quoteTotals(lines, defaults, ['Outside light']);
    expect(t.totalPence).toBe(36000 + 4815 + 2500 + 5200);
    expect(t.costPence).toBe(16000 + 3702 + 4000);
  });
});
