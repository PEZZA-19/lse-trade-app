import { describe, expect, it } from 'vitest';
import {
  itemSell,
  kitTotals,
  kitLabourIndex,
  kitLabourLine,
  kitLabourMinutes,
  kitUpdate,
  quoteKitSnapshot,
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

import { expandKitLine, kitPriceChanged, kitQuoteLine, snapshotFromKit } from '../src/pricelist';

describe('kits on quotes', () => {
  const kit = {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Double socket on new radial',
    costPence: 1829,
    sellPence: 2418,
    lines: [
      {
        itemId: '00000000-0000-4000-8000-0000000000a1',
        code: 'TE25',
        description: 'Cable',
        unit: 'm',
        qtyMilli: 12000,
        unitCostPence: 112,
        unitSellPence: 146,
      },
      {
        itemId: '00000000-0000-4000-8000-0000000000a2',
        code: null,
        description: 'Socket',
        unit: 'each',
        qtyMilli: 1000,
        unitCostPence: 310,
        unitSellPence: 465,
      },
    ],
  };
  it('freezes the kit as one costed block', () => {
    const line = kitQuoteLine(snapshotFromKit(kit), 4000);
    expect(line).toMatchObject({
      kind: 'material',
      description: kit.name,
      qtyMilli: 4000,
      unitCostPence: 1829,
      unitPricePence: 2418,
    });
    expect(line.kit.components).toHaveLength(2);
  });
  it('expands into components multiplied by the number of kits', () => {
    const lines = expandKitLine(kitQuoteLine(snapshotFromKit(kit), 2500, 'Kitchen'));
    expect(lines.map((l) => [l.description, l.qtyMilli, l.unitPricePence, l.optionLabel])).toEqual([
      ['Cable', 30000, 146, 'Kitchen'],
      ['Socket', 2500, 465, 'Kitchen'],
    ]);
    expect(lines.every((l) => l.kit === null)).toBe(true);
  });
  it('spots a price change', () => {
    expect(kitPriceChanged({ costPence: 1, sellPence: 2 }, { costPence: 1, sellPence: 2 })).toBe(
      false,
    );
    expect(kitPriceChanged({ costPence: 1, sellPence: 2 }, { costPence: 1, sellPence: 3 })).toBe(
      true,
    );
    expect(kitPriceChanged({ costPence: 1, sellPence: 2 }, undefined)).toBe(false);
  });
});

import { importChanges, priceItemUpdate } from '../src/pricelist';

describe('updates never blank what was not sent', () => {
  it('priceItemUpdate leaves absent fields undefined', () => {
    expect(priceItemUpdate.parse({ unitCostPence: 112 })).toEqual({ unitCostPence: 112 });
    expect(priceItemUpdate.parse({ code: '', supplier: null })).toEqual({
      code: null,
      supplier: null,
    });
  });
  it('an import only changes the columns the file has', () => {
    const existing = {
      code: 'SKT2',
      description: 'Double socket',
      unit: 'each',
      supplier: 'Island',
      unitCostPence: 310,
      markupBp: 15000,
      sellPricePence: null,
      isActive: true,
    };
    const row = { ...existing, unit: 'each', supplier: null, unitCostPence: 345, markupBp: null };
    expect(importChanges(existing, row, ['code', 'description', 'cost'])).toEqual({
      unitCostPence: 345,
    });
    expect(importChanges(existing, row, ['code', 'description', 'cost', 'markup'])).toEqual({
      unitCostPence: 345,
      markupBp: null,
    });
  });
});

describe('labour on kits', () => {
  it('adds kit time to per-item time x quantity', () => {
    expect(
      kitLabourMinutes(30, [
        { qtyMilli: 10000, labourMinutes: 2 },
        { qtyMilli: 1500, labourMinutes: 15 },
        { qtyMilli: 1000 },
      ]),
    ).toBe(30 + 20 + 23);
  });

  it('makes an ordinary labour line: hours per kit x kits at the rate', () => {
    const l = kitLabourLine('Double socket', 90, 3000, 5500, 'Option A');
    expect(l).toMatchObject({
      kind: 'labour',
      description: 'Labour: Double socket',
      qtyMilli: 4500,
      unitPricePence: 5500,
      unitCostPence: null,
      optionLabel: 'Option A',
      kit: null,
    });
    expect(kitLabourLine('x', 0, 1000, 5500).qtyMilli).toBe(1);
  });

  it('finds the labour line straight after its kit block', () => {
    const lines = [
      { kind: 'material', description: 'Kit A', kit: {} },
      { kind: 'labour', description: 'Labour: Kit A', kit: null },
      { kind: 'material', description: 'Kit B', kit: {} },
    ];
    expect(kitLabourIndex(lines, 0, 'Kit A')).toBe(1);
    expect(kitLabourIndex(lines, 2, 'Kit B')).toBeNull();
  });

  it('snapshots total fitting minutes', () => {
    const snap = snapshotFromKit({
      id: '00000000-0000-4000-8000-000000000001',
      name: 'K',
      costPence: 100,
      sellPence: 130,
      kitLabourMinutes: 10,
      lines: [
        {
          itemId: '00000000-0000-4000-8000-000000000002',
          code: null,
          description: 'Socket',
          unit: 'each',
          qtyMilli: 2000,
          unitCostPence: 50,
          unitSellPence: 65,
          labourMinutes: 15,
        },
      ],
    });
    expect(snap.labourMinutes).toBe(40);
    expect(quoteKitSnapshot.parse(snap).labourMinutes).toBe(40);
  });
});

describe('kitUpdate', () => {
  it('a name-only edit leaves lines out (so they are not emptied)', () => {
    expect(kitUpdate.parse({ name: 'New name' })).toEqual({ name: 'New name' });
  });
});
