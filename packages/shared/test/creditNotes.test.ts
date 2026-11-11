import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { creditBlocker, creditNoteCreate, type CreditNoteDto } from '../src/creditNotes';
import { creditNoteDocument } from '../src/documents';
import { statusAfterPayment } from '../src/invoices';
import { renderPdf } from '../src/pdf';

const business = {
  name: 'Little Sark Electric',
  legalName: null,
  address: 'Demo Workshop\nLittle Sark (fictional)',
  email: 'owner@lse.example',
  phone: '01481 000000',
  bankAccountName: 'Little Sark Electric (demo)',
  bankSortCode: '11-22-33',
  bankAccountNumber: '12345678',
  invoiceTerms: null,
  quoteTerms: null,
  quoteValidDays: 30,
};

function cn(p: Partial<CreditNoteDto> = {}): CreditNoteDto {
  return {
    id: 'c1',
    number: 'CN-0001',
    status: 'approved',
    issueDate: '2026-11-11',
    reason: 'Outside light not fitted',
    amountPence: 4000,
    invoiceId: 'i1',
    invoiceNumber: '125',
    invoiceTotalPence: 13500,
    invoiceBalancePence: 4500,
    jobId: 'j1',
    jobNumber: '125',
    jobTitle: 'Annual PAT testing',
    billTo: { name: 'Coupée View Hotel', email: 'manager@coupee-view.example', address: null },
    approvedByName: 'Joe',
    approvedAt: '2026-11-11T10:00:00Z',
    createdAt: '2026-11-11T09:00:00Z',
    nextNumber: null,
    version: 2,
    ...p,
  };
}

describe('credit notes', () => {
  it('validates the amount and asks for a reason', () => {
    expect(creditNoteCreate.safeParse({ amountPence: 0, reason: 'x' }).success).toBe(false);
    const r = creditNoteCreate.safeParse({ amountPence: 100, reason: '  ' });
    expect(r.success).toBe(false);
  });

  it('only credits issued invoices with something owed', () => {
    expect(creditBlocker({ status: 'draft', balancePence: 100 })).toMatch(/edit or delete/);
    expect(creditBlocker({ status: 'approved', balancePence: 100 })).toMatch(/unsent/);
    expect(creditBlocker({ status: 'paid', balancePence: 0 })).toMatch(/Refunds/);
    expect(creditBlocker({ status: 'part_paid', balancePence: 100 })).toBeNull();
  });

  it('settles an invoice when payments plus credits cover it', () => {
    expect(statusAfterPayment(10000, 6000, 4000)).toBe('paid');
    expect(statusAfterPayment(10000, 0, 4000)).toBe('sent');
    expect(statusAfterPayment(10000, 5000, 1000)).toBe('part_paid');
    expect(statusAfterPayment(10000, 10000)).toBe('paid');
  });

  it('lays out a credit note: no bank details, the effect on the invoice', () => {
    const d = creditNoteDocument(cn(), business);
    expect(d.title).toBe('Credit Note');
    expect(d.payment).toBeNull();
    expect(d.meta.map((m) => m.label)).toEqual(['Date', 'Invoice', 'Job']);
    expect(d.totals.map((t) => `${t.label} ${t.value}`)).toEqual([
      'Total credit £40.00',
      'Invoice 125 total £135.00',
      'Balance now due £45.00',
    ]);
    expect(d.fileName).toBe('Credit note CN-0001.pdf');
  });

  it('a draft shows the balance it would leave and settles wording', () => {
    const d = creditNoteDocument(
      cn({ status: 'draft', number: null, invoiceBalancePence: 4000, issueDate: null }),
      business,
    );
    expect(d.number).toBe('Draft');
    expect(d.draftLabel).toBe('Draft: not approved');
    expect(d.totals.at(-1)!.value).toBe('£0.00');
    expect(d.notes).toMatch(/settles invoice 125/);
  });

  it('renders a one-page PDF', async () => {
    const pdf = await PDFDocument.load(await renderPdf(creditNoteDocument(cn(), business)));
    expect(pdf.getPageCount()).toBe(1);
  });
});
