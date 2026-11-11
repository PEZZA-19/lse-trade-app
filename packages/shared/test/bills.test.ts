import { describe, expect, it } from 'vitest';
import { billCreate, billLinesFromCsv, billTotal, supplierInput } from '../src/bills';

describe('billLinesFromCsv', () => {
  it('reads forgiving headers in any order, with quoted fields', () => {
    const r = billLinesFromCsv(
      [
        'Qty,Stock Code,Description,Unit Price',
        '100,TE25,"2.5mm T&E, grey",£1.12',
        '4,,Double socket,3.20',
      ].join('\n'),
    );
    expect(r.errors).toEqual([]);
    expect(r.lines).toEqual([
      { code: 'TE25', description: '2.5mm T&E, grey', qtyMilli: 100000, unitCostPence: 112 },
      { code: null, description: 'Double socket', qtyMilli: 4000, unitCostPence: 320 },
    ]);
  });

  it('works out the unit cost from a line total, and defaults the quantity to 1', () => {
    const r = billLinesFromCsv('Description,Qty,Net\nCable ties,3,10.00\nCarriage,,9.43');
    expect(r.lines).toEqual([
      { code: null, description: 'Cable ties', qtyMilli: 3000, unitCostPence: 333 },
      { code: null, description: 'Carriage', qtyMilli: 1000, unitCostPence: 943 },
    ]);
  });

  it('reports bad rows by line number and keeps the good ones', () => {
    const r = billLinesFromCsv('Description,Qty,Cost\n,1,1\nTies,0,1\nBox,2,abc\nGood,1,2.50');
    expect(r.errors.map((e) => e.row)).toEqual([2, 3, 4]);
    expect(r.lines).toHaveLength(1);
  });

  it('explains missing columns and empty files', () => {
    expect(billLinesFromCsv('').errors[0]!.message).toMatch(/empty/);
    expect(billLinesFromCsv('Qty,Cost\n1,2').errors[0]!.message).toMatch(/Description/);
    expect(billLinesFromCsv('Description,Qty\nA,1').errors[0]!.message).toMatch(/cost|Total/i);
  });
});

describe('bill schemas', () => {
  it('totals lines rounding each up to the penny', () => {
    expect(
      billTotal([
        { qtyMilli: 1500, unitCostPence: 333 },
        { qtyMilli: 1000, unitCostPence: 1 },
      ]),
    ).toBe(501);
  });
  it('needs a supplier, reference and date; lines need a quantity above 0', () => {
    const bad = billCreate.safeParse({
      supplier: '',
      reference: '',
      billDate: 'x',
      lines: [{ description: 'a', qtyMilli: 0, unitCostPence: 1 }],
    });
    expect(bad.success).toBe(false);
    const ok = billCreate.parse({ supplier: 'S', reference: 'R', billDate: '2026-11-10' });
    expect(ok).toMatchObject({ kind: 'bill', source: 'manual', jobId: null, lines: [] });
  });
  it('lower-cases supplier emails and blanks empty fields', () => {
    expect(supplierInput.parse({ name: 'X', email: 'A@B.test', phone: '' })).toMatchObject({
      email: 'a@b.test',
      phone: null,
    });
  });
});
