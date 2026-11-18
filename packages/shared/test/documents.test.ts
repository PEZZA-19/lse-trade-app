import { readFileSync, writeFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import type { QuoteDetailDto } from '../src/dto';
import {
  formatDocDate,
  initialsOf,
  invoiceDocument,
  quoteDocument,
  splitLines,
} from '../src/documents';
import type { InvoiceDetailDto, InvoiceLineDto } from '../src/invoices';
import { pdfSafe, renderPdf } from '../src/pdf';

const business = {
  name: 'Little Sark Electric',
  legalName: null,
  address: 'Demo Workshop\nLittle Sark (fictional)',
  email: 'office@lse.example',
  phone: '07700 900000',
  bankAccountName: 'Little Sark Electric (demo)',
  bankSortCode: '11-22-33',
  bankAccountNumber: '12345678',
  quoteTerms: null,
  invoiceTerms: null,
};

let n = 0;
function line(p: Partial<InvoiceLineDto>): InvoiceLineDto {
  n += 1;
  return {
    id: `l${n}`,
    position: n,
    kind: 'material',
    description: 'Item',
    qtyMilli: 1000,
    unitPricePence: 100,
    totalPence: 100,
    taxRateBp: 0,
    ...p,
  };
}

function invoice(p: Partial<InvoiceDetailDto> = {}): InvoiceDetailDto {
  const lines = p.lines ?? [
    line({
      kind: 'labour',
      description: '27/10/26 08:30-12:00',
      qtyMilli: 3500,
      unitPricePence: 4500,
      totalPence: 15750,
    }),
    line({ description: 'Junction box', qtyMilli: 1000, unitPricePence: 582, totalPence: 582 }),
    line({ kind: 'carriage', description: 'Carriage', unitPricePence: 0, totalPence: 0 }),
  ];
  const total = lines.reduce((t, l) => t + l.totalPence, 0);
  return {
    id: 'i1',
    number: '122-2',
    jobId: 'j1',
    jobNumber: '122',
    jobTitle: 'Board upgrade',
    customerName: 'Alex Example',
    status: 'approved',
    displayStatus: 'approved',
    source: 'job',
    quoteMode: null,
    issueDate: '2026-11-11',
    dueDate: '2026-11-25',
    totalPence: total,
    paidPence: 0,
    creditedPence: 0,
    balancePence: total,
    createdAt: '2026-11-11T10:00:00Z',
    version: 1,
    quoteNumber: null,
    termsDays: 14,
    termsText: 'Payment is due within 14 days.',
    notes: null,
    subtotalPence: total,
    taxPence: 0,
    billTo: {
      name: 'Alex Example',
      email: 'alex@example.test',
      address: 'Demo Farm, Rue du Demo, Sark',
    },
    approvedByName: 'Owner',
    approvedAt: '2026-11-11T10:00:00Z',
    sentByName: null,
    sentAt: null,
    lines,
    payments: [],
    creditNotes: [],
    creditsApplied: [],
    creditUses: [],
    creditToUsePence: 0,
    nextNumber: null,
    approvalBlockers: [],
    ...p,
  };
}

describe('document helpers', () => {
  it('makes initials for the logo', () => {
    expect(initialsOf('Little Sark Electric')).toBe('LSE');
    expect(initialsOf('Sparks')).toBe('SP');
    expect(initialsOf('Smith & Sons (Guernsey) Ltd')).toBe('SSL');
  });
  it('splits addresses on new lines and commas', () => {
    expect(splitLines('Demo Farm, Rue du Demo\nSark')).toEqual([
      'Demo Farm',
      'Rue du Demo',
      'Sark',
    ]);
    expect(splitLines(null)).toEqual([]);
  });
  it('formats calendar dates without time zone drift', () => {
    expect(formatDocDate('2026-03-29')).toBe('29 Mar 2026');
  });
  it('keeps only characters the PDF fonts can draw', () => {
    expect(pdfSafe('£12 – Coupée → done ✓\u0007')).toBe('£12 – Coupée -> done v');
    expect(pdfSafe('日本')).toBe('??');
  });
});

describe('invoiceDocument', () => {
  it('itemises labour then materials, hides zero carriage and has no tax wording', () => {
    const d = invoiceDocument(invoice(), business);
    expect(d.title).toBe('Invoice');
    expect(d.number).toBe('122-2');
    expect(d.sections.map((s) => s.title)).toEqual(['Labour', 'Materials']);
    expect(d.sections[0]!.rows[0]).toMatchObject({
      qty: '3.5 h',
      rate: '£45.00',
      amount: '£157.50',
    });
    expect(d.totals.map((t) => t.label)).toEqual(['Subtotal', 'Total']);
    expect(d.totals.at(-1)!.value).toBe('£163.32');
    expect(JSON.stringify(d)).not.toMatch(/VAT|Tax/);
    expect(d.payment).toEqual({
      accountName: 'Little Sark Electric (demo)',
      sortCode: '11-22-33',
      accountNumber: '12345678',
      reference: 'INV 122-2',
    });
    expect(d.terms).toBe('Payment is due within 14 days.');
    expect(d.business.addressLines).toEqual(['Demo Workshop', 'Little Sark (fictional)']);
    expect(d.fileName).toBe('Invoice 122-2.pdf');
    expect(d.meta).toEqual([
      { label: 'Invoice date', value: '11 Nov 2026' },
      { label: 'Due date', value: '25 Nov 2026' },
      { label: 'Job', value: '122' },
    ]);
  });

  it('shows carriage when it is not zero, tax only when charged, and paid/balance', () => {
    const lines = [
      line({ description: 'Cable', totalPence: 1000, unitPricePence: 1000 }),
      line({ kind: 'carriage', description: 'Carriage', totalPence: 943, unitPricePence: 943 }),
    ];
    const d = invoiceDocument(
      invoice({
        lines,
        subtotalPence: 1943,
        taxPence: 97,
        totalPence: 2040,
        paidPence: 1000,
        balancePence: 1040,
      }),
      business,
    );
    expect(d.totals.map((t) => [t.label, t.value])).toEqual([
      ['Subtotal', '£10.00'],
      ['Carriage', '£9.43'],
      ['Tax', '£0.97'],
      ['Total', '£20.40'],
      ['Paid', '-£10.00'],
      ['Balance due', '£10.40'],
    ]);
  });

  it('marks drafts and never prints a number they do not have yet', () => {
    const d = invoiceDocument(
      invoice({ status: 'draft', number: null, issueDate: null, dueDate: null }),
      business,
    );
    expect(d.number).toBe('Draft');
    expect(d.draftLabel).toMatch(/Draft/);
    expect(d.fileName).toBe('Invoice draft (job 122).pdf');
    expect(d.payment?.reference).toBe('INV Draft');
  });

  it('leaves out bank details that are not set', () => {
    expect(invoiceDocument(invoice(), { ...business, bankAccountNumber: null }).payment).toBeNull();
  });
});

function quote(): QuoteDetailDto {
  const base = {
    qtyMilli: 1000,
    unitCostPence: null,
    markupBp: null,
    unitPricePence: null,
    taxRateBp: 0,
    kit: null,
    optionLabel: null,
  };
  return {
    id: 'q1',
    number: 'Q-0012',
    displayNumber: 'Q-0012 rev B',
    status: 'draft',
    customerId: 'c1',
    customerName: 'Alex Example',
    siteId: null,
    title: 'Kitchen sockets',
    currentRevision: 2,
    totalPence: 0,
    convertedJobId: null,
    convertedJobNumber: null,
    createdAt: '',
    updatedAt: '',
    version: 1,
    site: { id: 's', customerId: 'c1', label: null, address: 'Demo Farm, Sark', notes: null },
    revisions: [],
    current: {
      id: 'r2',
      revision: 2,
      revisionLetter: 'B',
      title: 'Kitchen sockets',
      notes: null,
      validDays: 30,
      defaultMarkupBp: 13000,
      sentAt: null,
      supersededAt: null,
      acceptedOptions: [],
      lines: [
        {
          ...base,
          id: 'a',
          position: 0,
          kind: 'labour',
          description: 'Fit sockets',
          qtyMilli: 5000,
          unitSellPence: 4500,
          totalPence: 22500,
        },
        {
          ...base,
          id: 'b',
          position: 1,
          kind: 'material',
          description: 'Double socket on new radial',
          qtyMilli: 4000,
          unitSellPence: 2282,
          totalPence: 9128,
          kit: {
            kitId: '00000000-0000-4000-8000-000000000001',
            name: 'Double socket on new radial',
            costPence: 1755,
            sellPence: 2282,
            components: [
              {
                itemId: '00000000-0000-4000-8000-000000000002',
                code: 'TE25',
                description: 'cable',
                unit: 'm',
                qtyMilli: 3000,
                unitCostPence: 98,
                unitSellPence: 128,
              },
              {
                itemId: '00000000-0000-4000-8000-000000000003',
                code: 'SKT2',
                description: 'Double socket',
                unit: 'each',
                qtyMilli: 1000,
                unitCostPence: 310,
                unitSellPence: 465,
              },
            ],
          },
        },
        {
          ...base,
          id: 'c',
          position: 2,
          kind: 'pc_sum',
          description: 'Light fittings',
          unitSellPence: 20000,
          totalPence: 20000,
        },
        {
          ...base,
          id: 'd',
          position: 3,
          kind: 'carriage',
          description: 'Carriage',
          unitSellPence: 0,
          totalPence: 0,
        },
        {
          ...base,
          id: 'e',
          position: 4,
          kind: 'material',
          description: 'Outdoor socket',
          optionLabel: 'Garden',
          unitSellPence: 3500,
          totalPence: 3500,
        },
      ],
      totals: { corePence: 51628, options: { Garden: 3500 }, totalPence: 51628, costPence: 0 },
    },
  };
}

const to = { name: 'Alex Example', address: 'Demo Farm, Sark', email: null };

describe('quoteDocument', () => {
  it('prints the revision, validity, kit parts, allowances and optional extras apart', () => {
    const d = quoteDocument(quote(), business, to, '2026-11-11');
    expect(d.number).toBe('Q-0012 rev B');
    expect(d.meta).toEqual([
      { label: 'Date', value: '11 Nov 2026' },
      { label: 'Valid until', value: '11 Dec 2026' },
    ]);
    expect(d.sections.map((s) => [s.title, s.optional])).toEqual([
      ['Labour', false],
      ['Materials', false],
      ['Allowances', false],
      ['Optional extra: Garden', true],
    ]);
    expect(d.sections[1]!.rows[0]!.detail).toBe('3 m cable · 1 Double socket');
    expect(d.sections[2]!.rows[0]!.description).toBe('Allowance: Light fittings');
    expect(d.totals.map((t) => t.label)).toEqual(['Subtotal', 'Total (without extras)']);
    expect(d.payment).toBeNull();
    expect(d.terms).toContain('valid for 30 days');
    expect(d.fileName).toBe('Quote Q-0012 rev B.pdf');
  });
});

describe('renderPdf', () => {
  it('produces a valid one-page A4 PDF with the title set', async () => {
    const bytes = await renderPdf(invoiceDocument(invoice(), business));
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(1);
    expect(pdf.getTitle()).toBe('Invoice 122-2');
    expect(Math.round(pdf.getPage(0).getWidth())).toBe(595);
    if (process.env.PDF_OUT) writeFileSync(`${process.env.PDF_OUT}/invoice.pdf`, bytes);
  });

  it('flows long invoices onto more pages and copes with unusual text', async () => {
    const lines = Array.from({ length: 70 }, (_, i) =>
      line({
        description: `Line ${i + 1}: ${'very long description with a supercalifragilisticexpialidociouswordthatdoesnotfit '.repeat(i % 3 === 0 ? 2 : 1)} → 日本`,
        totalPence: 100,
      }),
    );
    const total = 7000;
    const bytes = await renderPdf(
      invoiceDocument(
        invoice({
          lines,
          subtotalPence: total,
          totalPence: total,
          balancePence: total,
          status: 'draft',
          number: null,
        }),
        business,
      ),
    );
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBeGreaterThan(1);
    if (process.env.PDF_OUT) writeFileSync(`${process.env.PDF_OUT}/long.pdf`, bytes);
  });

  it('renders a quote', async () => {
    const bytes = await renderPdf(quoteDocument(quote(), business, to, '2026-11-11'));
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
    if (process.env.PDF_OUT) writeFileSync(`${process.env.PDF_OUT}/quote.pdf`, bytes);
  });
});

describe('logo on documents', () => {
  const logo = `data:image/png;base64,${readFileSync(new URL('../../../assets/lse-logo.png', import.meta.url)).toString('base64')}`;

  it('uses the uploaded logo instead of the initials, and survives a broken one', async () => {
    const doc = invoiceDocument(invoice(), { ...business, logoDataUrl: logo });
    expect(doc.business.logoDataUrl).toBe(logo);
    const bytes = await renderPdf(doc);
    if (process.env.PDF_OUT) writeFileSync(`${process.env.PDF_OUT}/logo.pdf`, bytes);
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(1);
    // An image XObject is embedded.
    expect(new TextDecoder('latin1').decode(bytes)).toContain('/Subtype /Image');
    const broken = await renderPdf(
      invoiceDocument(invoice(), { ...business, logoDataUrl: 'data:image/png;base64,AAAA' }),
    );
    expect((await PDFDocument.load(broken)).getPageCount()).toBe(1);
  });
});
