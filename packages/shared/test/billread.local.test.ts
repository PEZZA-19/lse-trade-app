/**
 * Joe's real merchant PDFs. They hold his account details, so they live outside the repo
 * (/workspace/bill-samples) and this test skips wherever they are missing (CI, other
 * machines). The committed tests use synthetic copies of the same layouts. The expected values
 * (real invoice numbers and order references) live beside the PDFs in expected.json, so nothing
 * from Joe's real paperwork is in the repo.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readPdfPages } from '../src/billread/parse';
import { extractPdfPages } from '../src/pdftext';

const DIR = process.env.BILL_SAMPLES ?? '/workspace/bill-samples';
const has = (f: string) => existsSync(`${DIR}/${f}`);
const ready = has('expected.json');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const E: any = ready ? JSON.parse(readFileSync(`${DIR}/expected.json`, 'utf8')) : {};
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

describe.skipIf(!ready)('real CEF invoices (local only)', () => {
  it('splits the invoices and every one adds up', async () => {
    const r = await read(E.cef.file);
    if (process.env.SHOW) console.log(JSON.stringify(summary(r), null, 1));
    if (r.kind !== 'bills') throw new Error(r.kind);
    expect(r.bills.map((b) => [b.reference, b.totalPence, b.adds])).toEqual(E.cef.bills);
    expect(
      r.bills[1]!.lines.map((l) => [l.qtyMilli, l.unitPricePence, l.discountBp, l.totalPence]),
    ).toEqual(E.cef.secondLines);
    expect(r.bills[0]!.billDate).toBe(E.cef.firstDate);
    expect(r.bills[3]!.orderNumber).toBe(E.cef.fourthOrder);
    for (const b of r.bills) expect(b.problems).toEqual([]);
  });
});

describe.skipIf(!ready)('real DOCI invoices (local only)', () => {
  it('reads both invoices with RRP and due date', async () => {
    const [a, b] = await Promise.all(E.doci.files.map((f: string) => read(f)));
    if (process.env.SHOW) console.log(JSON.stringify([summary(a!), summary(b!)], null, 1));
    if (a!.kind !== 'bills' || b!.kind !== 'bills') throw new Error('not bills');
    expect(a!.bills[0]).toMatchObject(E.doci.a);
    expect(a!.bills[0]!.lines[0]).toMatchObject(E.doci.aLine);
    expect(b!.bills[0]).toMatchObject(E.doci.b);
    expect(b!.bills[0]!.lines).toHaveLength(E.doci.bLines);
  });
});

describe.skipIf(!ready)('real CI Lighting statement (local only)', () => {
  it('reads the left columns and the running balance chains', async () => {
    const r = await read(E.statement.file);
    if (r.kind !== 'statement') throw new Error(r.kind);
    const s = r.statement;
    if (process.env.SHOW) console.log(JSON.stringify(s, null, 1));
    expect(s.chainOk).toBe(true);
    expect(s.closingPence).toBe(E.statement.closingPence);
    expect(s.date).toBe(E.statement.date);
    expect(s.rows).toHaveLength(E.statement.rows);
    expect(s.rows.map((x) => x.type)).toContain('DIS');
    expect(s.rows[10]).toMatchObject(E.statement.row10);
    expect(s.rows[13]).toMatchObject(E.statement.row13);
  });
});
