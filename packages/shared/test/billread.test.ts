import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { billCreate, billTotal } from '../src/bills';
import { readBillToCreate, suggestJob } from '../src/billread/import';
import { reconcileStatement } from '../src/billread/reconcile';
import { expectedLineTotal, parseDate, parsePence, readPdfPages } from '../src/billread/parse';
import { extractPdfPages } from '../src/pdftext';
import {
  CEF_INVOICES,
  CI_STATEMENT,
  cefPdf,
  ciStatementPdf,
  DOCI_INVOICE,
  dociPdf,
} from './fixtures/bill-pdfs';

const read = async (bytes: Uint8Array) => readPdfPages(await extractPdfPages(bytes));

describe('number and date reading', () => {
  it('reads pence without floats and dates in each merchant style', () => {
    expect(parsePence('£1,234.56')).toBe(123456);
    expect(parsePence('0.07')).toBe(7);
    expect(parsePence('-3.10')).toBe(-310);
    expect(parsePence('12.5')).toBeNull();
    expect(parseDate('07 Nov 2026')).toBe('2026-11-07');
    expect(parseDate('30/12/2026')).toBe('2026-12-30');
    expect(parseDate('30/10/26')).toBe('2026-10-30');
    expect(parseDate('31/02/2026')).toBeNull();
  });
  it('rounds discounted lines half up like the merchants', () => {
    expect(expectedLineTotal(10_000, 70, 3500)).toBe(455);
    expect(expectedLineTotal(10_000, 67, 3500)).toBe(436); // 4.355
    expect(expectedLineTotal(2000, 5904, 0)).toBe(11808);
  });
});

describe('CEF reader (synthetic copy of the layout)', () => {
  it('splits one invoice per page and pulls every field', async () => {
    const r = await read(await cefPdf());
    if (r.kind !== 'bills') throw new Error(r.kind);
    expect(
      r.bills.map((b) => [b.reference, b.billDate, b.dueDate, b.orderNumber, b.totalPence, b.adds]),
    ).toEqual([
      ['GUR/900101', '2026-11-07', '2026-12-07', 'DEMO HALL', 2625, true],
      ['GUR/900102', '2026-11-07', '2026-12-07', 'STOCK', 1690, true],
      ['GUR/900151', '2026-11-09', '2026-12-09', 'OLD BAKERY REWIRE', 612, true],
      ['GUR/900152', '2026-11-09', '2026-12-09', 'GENERATOR LINK', 3980, true],
    ]);
    const [first, second] = r.bills;
    expect(first!.supplier).toBe('CEF');
    expect(first!.lines).toEqual([
      {
        qtyMilli: 1000,
        code: 'DEMOLITE LIGHTING WL.6W.BLK',
        description: 'Demo 6W Led Wall Lantern Black',
        unit: 'each',
        unitPricePence: 2625,
        discountBp: 0,
        totalPence: 2625,
        rrpPence: null,
      },
    ]);
    expect(
      second!.lines.map((l) => [l.code, l.qtyMilli, l.unitPricePence, l.discountBp, l.totalPence]),
    ).toEqual([
      ['F4P 40001', 1000, 799, 0, 799],
      ['F4P AA1000', 10000, 70, 3500, 455],
      ['F4P AAA1000', 10000, 67, 3500, 436],
    ]);
    expect(r.bills[2]!.lines[0]!.description).toBe('4.7W Led Dimmable Demo Candle Opal');
    expect(first!.dueDateNote).toMatch(/thirty days/);
    expect(first!.pages).toEqual([1]);
  });

  it('flags an invoice whose lines do not add up', async () => {
    const bad = structuredClone(CEF_INVOICES[1]!);
    bad.goods = '17.90';
    bad.lines[2]!.goods = '5.36';
    const r = await read(await cefPdf([bad]));
    if (r.kind !== 'bills') throw new Error(r.kind);
    const b = r.bills[0]!;
    expect(b.adds).toBe(false);
    // The goods total matches the (wrong) line, so only the line itself is flagged.
    expect(b.problems).toEqual([
      'Line 3 (F4P AAA1000): qty × price gives £4.36 but the line says £5.36',
    ]);
  });

  it('flags a total that is not the sum of the lines', async () => {
    const bad = structuredClone(CEF_INVOICES[3]!);
    bad.goods = '40.80';
    const r = await read(await cefPdf([bad]));
    if (r.kind !== 'bills') throw new Error(r.kind);
    expect(r.bills[0]!.problems).toEqual(['Lines add up to £39.80 but the goods total is £40.80']);
  });
});

describe('DOCI reader (synthetic copy of the layout)', () => {
  it('reads header columns, lines with RRP, and the printed due date', async () => {
    const r = await read(await dociPdf());
    if (r.kind !== 'bills') throw new Error(r.kind);
    expect(r.bills).toHaveLength(1);
    expect(r.bills[0]).toMatchObject({
      supplier: 'DOCI',
      reference: DOCI_INVOICE.number,
      billDate: '2026-11-07',
      dueDate: '2026-12-30',
      orderNumber: '700543',
      yourReference: 'OLD BAKERY REWIRE',
      totalPence: 8526,
      adds: true,
      problems: [],
    });
    expect(
      r.bills[0]!.lines.map((l) => [
        l.code,
        l.description,
        l.qtyMilli,
        l.rrpPence,
        l.unitPricePence,
        l.totalPence,
      ]),
    ).toEqual([
      ['22999800', 'DEMO ACTUATOR 2 PORT', 1000, 6119, 4662, 4662],
      ['22999100', 'DEMO ROOM THERMOSTAT', 2000, 3013, 1932, 3864],
    ]);
  });
});

describe('CI Lighting statement reader (synthetic copy of the layout)', () => {
  it('reads the left columns of a rotated page and chains the balance', async () => {
    const r = await read(await ciStatementPdf());
    if (r.kind !== 'statement') throw new Error(r.kind);
    const s = r.statement;
    expect(s).toMatchObject({
      supplier: 'CI Lighting',
      account: '900',
      date: '2026-10-30',
      closingPence: 74715,
      chainOk: true,
      problems: [],
    });
    expect(s.rows).toHaveLength(CI_STATEMENT.length);
    expect(s.rows[0]).toEqual({
      date: '2026-07-09',
      type: 'INV',
      reference: '90058:1',
      yourReference: 'DEMO HALL',
      amountPence: 58176,
      flag: 'settled',
      balancePence: 58176,
      chainOk: true,
    });
    expect(s.rows[2]).toMatchObject({ type: 'CAS', reference: 'BACS', yourReference: null });
    expect(s.rows[7]).toMatchObject({ type: 'CRN', amountPence: 4775, flag: 'outstanding' });
    expect(s.rows[9]).toMatchObject({ flag: null, balancePence: 74715 });
  });

  it('says where the running balance breaks', async () => {
    const rows = structuredClone(CI_STATEMENT);
    rows[5]!.balance = '1021.39';
    const r = await read(await ciStatementPdf(rows));
    if (r.kind !== 'statement') throw new Error(r.kind);
    expect(r.statement.chainOk).toBe(false);
    expect(r.statement.rows[5]!.chainOk).toBe(false);
    expect(r.statement.problems[0]).toBe(
      'INV 91588:1: £936.01 + £84.38 should be £1020.39, the statement says £1021.39',
    );
  });
});

describe('unknown layouts', () => {
  it('come back as text for the AI helper', async () => {
    const { PDFDocument, StandardFonts } = await import('pdf-lib');
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf
      .addPage()
      .drawText('Corner Shop Ltd   Invoice 42   Total 9.99', { x: 50, y: 700, size: 10, font });
    const r = await read(await pdf.save());
    expect(r).toEqual({ kind: 'unknown', text: 'Corner Shop Ltd  Invoice 42  Total 9.99' });
  });
});

it.runIf(process.env.WRITE_FIXTURES)(
  'writes the synthetic PDFs for e2e and the preview',
  async () => {
    for (const dir of ['test/fixtures', '../../apps/web/public/samples']) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${dir}/sample-cef-invoices.pdf`, await cefPdf());
      writeFileSync(`${dir}/sample-doci-invoice.pdf`, await dociPdf());
      writeFileSync(`${dir}/sample-cilighting-statement.pdf`, await ciStatementPdf());
    }
  },
);

describe('turning a read bill into a draft', () => {
  it('keeps merchant rounding on discounted lines and notes order refs and checks', async () => {
    const r = await read(await cefPdf());
    if (r.kind !== 'bills') throw new Error(r.kind);
    const draft = readBillToCreate(r.bills[1]!, { fileName: 'sample.pdf' });
    expect(draft).toMatchObject({
      supplier: 'CEF',
      reference: 'GUR/900102',
      billDate: '2026-11-07',
      dueDate: '2026-12-07',
      source: 'pdf',
      fileName: 'sample.pdf',
    });
    expect(draft.lines!.map((l) => [l.qtyMilli, l.unitCostPence, l.totalPence])).toEqual([
      [1000, 799, undefined],
      [10000, 46, 455],
      [10000, 44, 436],
    ]);
    expect(billTotal(billCreate.parse(draft).lines)).toBe(1690);
    expect(draft.notes).toContain('Order number: STOCK');
    expect(draft.notes).toContain('F4P AA1000: list 0.70 less 35%');
  });

  it('suggests the job named in the order box, never for stock or a tie', () => {
    const jobs = [
      { id: 'a', number: '120', title: 'Old Bakery rewire', customerName: 'Sam Example' },
      { id: 'b', number: '121', title: 'Board upgrade', customerName: 'Redacted Demo' },
      { id: 'c', number: '122', title: 'Kitchen lights', customerName: 'Alex Example' },
    ];
    expect(suggestJob(['OLD BAKERY REWIRE'], jobs)).toMatchObject({
      jobId: 'a',
      why: 'The reference mentions bakery, rewire',
    });
    expect(suggestJob(['700543', 'REDACTED REF'], jobs)).toMatchObject({ jobId: 'b' });
    expect(suggestJob(['122'], jobs)).toMatchObject({
      jobId: 'c',
      why: 'The reference is job 122',
    });
    expect(suggestJob(['STOCK'], jobs)).toBeNull();
    expect(suggestJob(['EXAMPLE'], jobs)).toBeNull();
    expect(suggestJob([null], jobs)).toBeNull();
  });
});

describe('statement reconciliation', () => {
  it('matches invoices and credits by reference, flags missing and different, ignores payments', async () => {
    const r = await read(await ciStatementPdf());
    if (r.kind !== 'statement') throw new Error(r.kind);
    const held = [
      {
        id: '1',
        kind: 'bill' as const,
        reference: '90058',
        billDate: '2026-07-09',
        totalPence: 58176,
        status: 'applied' as const,
      },
      {
        id: '2',
        kind: 'bill' as const,
        reference: 'INV 90455:1',
        billDate: '2026-07-23',
        totalPence: 24100,
        status: 'applied' as const,
      },
      {
        id: '3',
        kind: 'credit_note' as const,
        reference: 'C9042',
        billDate: '2026-09-29',
        totalPence: 4775,
        status: 'draft' as const,
      },
      {
        id: '4',
        kind: 'bill' as const,
        reference: '93000',
        billDate: '2026-10-12',
        totalPence: 999,
        status: 'draft' as const,
      },
      {
        id: '5',
        kind: 'bill' as const,
        reference: '80000',
        billDate: '2026-01-01',
        totalPence: 100,
        status: 'applied' as const,
      },
    ];
    const rec = reconcileStatement(r.statement, held);
    expect(rec.rows.map((x) => [x.reference, x.match, x.differencePence])).toEqual([
      ['90058:1', 'matched', null],
      ['90455:1', 'amount_differs', 60],
      ['BACS', 'payment', null],
      ['BACS', 'payment', null],
      ['91585:1', 'missing', null],
      ['91588:1', 'missing', null],
      ['92078:1', 'missing', null],
      ['C9042:1', 'matched', null],
      ['92772:1', 'missing', null],
      ['BACS', 'payment', null],
    ]);
    expect(rec.notOnStatement.map((b) => b.id)).toEqual(['4']);
    expect(rec.counts).toEqual({ matched: 2, amountDiffers: 1, missing: 4 });
    expect(rec.closingPence).toBe(74715);
    // 936.01 + 84.38 + 15.80 − 47.75 + 113.97
    expect(rec.outstandingPence).toBe(110241);
  });
});
