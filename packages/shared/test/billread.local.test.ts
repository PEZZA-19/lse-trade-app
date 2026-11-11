/**
 * Joe's real merchant PDFs. They hold his account details, so they live outside the repo
 * (/workspace/bill-samples) and this test skips wherever they are missing (CI, other
 * machines). The committed tests use synthetic copies of the same layouts.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readPdfPages } from '../src/billread/parse';
import { extractPdfPages } from '../src/pdftext';

const DIR = process.env.BILL_SAMPLES ?? '/workspace/bill-samples';
const has = (f: string) => existsSync(`${DIR}/${f}`);
const read = async (f: string) =>
  readPdfPages(await extractPdfPages(new Uint8Array(readFileSync(`${DIR}/${f}`))));
const summary = (r: Awaited<ReturnType<typeof read>>) =>
  r.kind === 'bills'
    ? r.bills.map((b) => ({
        supplier: b.supplier,
        kind: b.kind,
        ref: b.reference,
        date: b.billDate,
        due: b.dueDate,
        order: b.orderNumber,
        yourRef: b.yourReference,
        total: b.totalPence,
        adds: b.adds,
        problems: b.problems,
        lines: b.lines.map((l) => [
          l.qtyMilli / 1000,
          l.code,
          l.description,
          l.unit,
          l.unitPricePence,
          l.discountBp / 100,
          l.totalPence,
          l.rrpPence,
        ]),
      }))
    : r;

describe.skipIf(!has('cef-2026-11-09.pdf'))('real CEF invoices (local only)', () => {
  it('splits four invoices and every one adds up', async () => {
    const r = await read('cef-2026-11-09.pdf');
    if (process.env.SHOW) console.log(JSON.stringify(summary(r), null, 1));
    expect(r.kind).toBe('bills');
    if (r.kind !== 'bills') return;
    expect(r.bills.map((b) => [b.reference, b.totalPence, b.adds])).toEqual([
      ['GUR/338984', 2625, true],
      ['GUR/338985', 1690, true],
      ['GUR/339035', 612, true],
      ['GUR/339036', 3980, true],
    ]);
    const b = r.bills[1]!;
    expect(b.lines.map((l) => [l.qtyMilli, l.unitPricePence, l.discountBp, l.totalPence])).toEqual([
      [1000, 799, 0, 799],
      [10000, 70, 3500, 455],
      [10000, 67, 3500, 436],
    ]);
    expect(r.bills[0]!.billDate).toBe('2026-11-07');
    expect(r.bills[3]!.orderNumber).toBe('GENERATOR LINK');
  });
});

describe.skipIf(!has('doci-107529.pdf'))('real DOCI invoices (local only)', () => {
  it('reads both invoices with RRP and due date', async () => {
    const a = await read('doci-107529.pdf');
    const b = await read('doci-107530.pdf');
    if (process.env.SHOW) console.log(JSON.stringify([summary(a), summary(b)], null, 1));
    if (a.kind !== 'bills' || b.kind !== 'bills') throw new Error('not bills');
    expect(a.bills[0]).toMatchObject({
      reference: '107529',
      billDate: '2026-11-07',
      dueDate: '2026-12-30',
      totalPence: 11808,
      adds: true,
    });
    expect(a.bills[0]!.lines[0]).toMatchObject({
      qtyMilli: 2000,
      code: '22000300',
      unitPricePence: 5904,
      rrpPence: 9640,
      totalPence: 11808,
    });
    expect(b.bills[0]).toMatchObject({
      reference: '107530',
      totalPence: 6594,
      adds: true,
      yourReference: 'REDACTED REF',
    });
    expect(b.bills[0]!.lines).toHaveLength(2);
  });
});

describe.skipIf(!has('cilighting-statement-2026-11-01.pdf'))(
  'real CI Lighting statement (local only)',
  () => {
    it('reads the left columns and the balance chains to £975.14', async () => {
      const r = await read('cilighting-statement-2026-11-01.pdf');
      if (r.kind !== 'statement') throw new Error(r.kind);
      const s = r.statement;
      if (process.env.SHOW)
        console.log(
          JSON.stringify(
            {
              ...s,
              rows: s.rows.map((x) => [
                x.date,
                x.type,
                x.reference,
                x.yourReference,
                x.amountPence,
                x.flag,
                x.balancePence,
                x.chainOk,
              ]),
            },
            null,
            1,
          ),
        );
      expect(s.chainOk).toBe(true);
      expect(s.closingPence).toBe(97514);
      expect(s.date).toBe('2026-10-30');
      expect(s.rows).toHaveLength(14);
      expect(s.rows.map((x) => x.type)).toContain('DIS');
      expect(s.rows[10]).toMatchObject({
        type: 'CRN',
        reference: 'C3042:1',
        amountPence: 4775,
        flag: 'outstanding',
      });
      expect(s.rows[13]).toMatchObject({ type: 'CAS', flag: null, balancePence: 97514 });
    });
  },
);
