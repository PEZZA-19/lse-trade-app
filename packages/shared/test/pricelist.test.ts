import { describe, expect, it } from 'vitest';
import {
  itemSell,
  kitTotals,
  parseCsv,
  parseMarkup,
  priceItemKey,
  priceItemsToCsv,
  priceRowsFromCsv,
} from '../src/pricelist';

describe('parseCsv', () => {
  it('handles quotes, doubled quotes, commas, CRLF, BOM and blank lines', () => {
    const csv = '\uFEFFa,b,c\r\n"x, y","say ""hi""",3\r\n\r\n"multi\nline",,\n';
    expect(parseCsv(csv)).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'say "hi"', '3'],
      ['multi\nline', '', ''],
    ]);
  });
  it('keeps a last row with no trailing newline', () => {
    expect(parseCsv('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});

describe('parseMarkup', () => {
  it('reads percentages and multipliers', () => {
    expect(parseMarkup('30')).toBe(13000);
    expect(parseMarkup('30%')).toBe(13000);
    expect(parseMarkup('12.5%')).toBe(11250);
    expect(parseMarkup('1.3x')).toBe(13000);
    expect(parseMarkup('')).toBeNull();
    expect(parseMarkup('lots')).toBeNull();
  });
});

describe('itemSell', () => {
  it('uses the override, else cost x markup (rounded up), else the default markup', () => {
    expect(itemSell({ unitCostPence: 1000, markupBp: null, sellPricePence: 1999 }, 13000)).toBe(
      1999,
    );
    expect(itemSell({ unitCostPence: 333, markupBp: 15000, sellPricePence: null }, 13000)).toBe(
      500,
    );
    expect(itemSell({ unitCostPence: 1001, markupBp: null, sellPricePence: null }, 13000)).toBe(
      1302,
    );
  });
});

describe('kitTotals', () => {
  it('sums each line rounded up', () => {
    expect(
      kitTotals([
        { qtyMilli: 2500, unitCostPence: 333, unitSellPence: 433 }, // 832.5 -> 833 ; 1082.5 -> 1083
        { qtyMilli: 1000, unitCostPence: 100, unitSellPence: 130 },
      ]),
    ).toEqual({ costPence: 933, sellPence: 1213 });
    expect(kitTotals([])).toEqual({ costPence: 0, sellPence: 0 });
  });
});

describe('priceRowsFromCsv', () => {
  it('maps forgiving headers in any order and reports bad rows by line number', () => {
    const csv = [
      'SKU,Supplier,Item,Unit Cost,Markup %,UOM,Sell',
      'CAB-25,Island Electrical,2.5mm T&E cable,£1.12,40,m,',
      ',Island Electrical,"Socket, double",3.20,,each,6.00',
      'X1,,Broken,abc,,,',
      'X2,,Too much markup,1,1000,,',
      'CAB-25,,Duplicate,1,,,',
    ].join('\n');
    const { rows, errors } = priceRowsFromCsv(csv);
    expect(rows).toEqual([
      {
        row: 2,
        item: {
          code: 'CAB-25',
          description: '2.5mm T&E cable',
          unit: 'm',
          supplier: 'Island Electrical',
          unitCostPence: 112,
          markupBp: 14000,
          sellPricePence: null,
          isActive: true,
        },
      },
      {
        row: 3,
        item: {
          code: null,
          description: 'Socket, double',
          unit: 'each',
          supplier: 'Island Electrical',
          unitCostPence: 320,
          markupBp: null,
          sellPricePence: 600,
          isActive: true,
        },
      },
    ]);
    expect(errors.map((e) => e.row)).toEqual([4, 5, 6]);
    expect(errors[0]!.message).toMatch(/Cost/);
  });
  it('needs description and cost columns', () => {
    expect(priceRowsFromCsv('code,unit\nA,m').errors[0]!.message).toMatch(/Description/);
    expect(priceRowsFromCsv('').errors[0]!.message).toMatch(/empty/);
  });
  it('round-trips through priceItemsToCsv', () => {
    const { rows } = priceRowsFromCsv(
      'Code,Description,Unit,Supplier,Cost,Markup,Sell\nA1,"Gland, 20mm ""stuffing""",each,Sarnia Supplies,0.45,25%,\n',
    );
    const again = priceRowsFromCsv(priceItemsToCsv(rows.map((r) => r.item)));
    expect(again.rows.map((r) => r.item)).toEqual(rows.map((r) => r.item));
  });
});

describe('priceItemKey', () => {
  it('matches on code first, else supplier + description, ignoring case', () => {
    expect(priceItemKey({ code: 'AbC', supplier: 'x', description: 'y' })).toBe('code:abc');
    expect(priceItemKey({ code: null, supplier: 'Island', description: 'Cable' })).toBe(
      'desc:island|cable',
    );
  });
});
