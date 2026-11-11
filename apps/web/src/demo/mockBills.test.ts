import type {
  BillApplyResultDto,
  BillDetailDto,
  BillSummaryDto,
  BusinessDocument,
  CreditNoteDto,
  InvoiceDetailDto,
  InvoiceSummaryDto,
  JobDetailDto,
  SupplierDto,
} from '@lse/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { handle, resetDemo } from './mockApi';

const get = <T>(p: string) => handle('GET', p, undefined) as Promise<T>;
const post = <T>(p: string, b?: unknown) => handle('POST', p, b) as Promise<T>;

describe('demo supplier bills (mirrors the server rules)', () => {
  beforeEach(() => {
    localStorage.clear();
    resetDemo();
  });

  it('seeds suppliers, an applied bill, a credit note and a draft bill to check', async () => {
    const suppliers = await get<SupplierDto[]>('/suppliers');
    const island = suppliers.find((s) => s.name === 'Island Electrical (demo)')!;
    expect(island.email).toBe('trade@island-electrical.example');
    expect(island.billCount).toBe(2);
    expect(island.spendPence).toBe(11190); // only the applied bill counts
    const drafts = await get<BillSummaryDto[]>('/supplier-bills?status=draft');
    expect(drafts.map((b) => b.reference)).toEqual(['IE-40388']);
    const credit = (await get<BillSummaryDto[]>('/supplier-bills?status=applied')).find(
      (b) => b.kind === 'credit_note',
    )!;
    expect(credit.reference).toBe('SW-CN-0907');
  });

  it('previews without changing anything, then applies: prices, kits and job materials', async () => {
    const [draft] = await get<BillSummaryDto[]>('/supplier-bills?status=draft');
    const bill = await get<BillDetailDto>(`/supplier-bills/${draft!.id}`);
    expect(bill.lines.filter((l) => l.item).length).toBe(2);
    expect(bill.lines.find((l) => l.code === 'CT300')!.item).toBeNull();

    const preview = await post<BillApplyResultDto>(`/supplier-bills/${bill.id}/apply`, {
      dryRun: true,
    });
    expect(preview.applied).toBe(false);
    const te = preview.priceChanges.find((c) => c.description.startsWith('2.5mm'))!;
    expect([te.oldCostPence, te.newCostPence]).toEqual([112, 124]);
    expect(preview.kits.length).toBeGreaterThan(0);
    expect(preview.notOnPriceList).toBe(1);
    expect((await get<BillDetailDto>(`/supplier-bills/${bill.id}`)).status).toBe('draft');

    const done = await post<BillApplyResultDto>(`/supplier-bills/${bill.id}/apply`, {
      dryRun: false,
    });
    expect(done.applied).toBe(true);
    const job = await get<JobDetailDto>(`/jobs/${bill.jobId}`);
    const fromBill = job.lines.filter((l) => l.source === 'supplier_bill');
    expect(fromBill).toHaveLength(3);
    await expect(post(`/supplier-bills/${bill.id}/apply`, { dryRun: false })).rejects.toMatchObject(
      { status: 409 },
    );
  });
});

describe('demo customer credit notes', () => {
  beforeEach(() => {
    localStorage.clear();
    resetDemo();
  });

  it('seeds CN-0001 on the PAT invoice; a new draft changes nothing until approved', async () => {
    const invs = await get<InvoiceSummaryDto[]>('/invoices?filter=all');
    const pat = invs.find((i) => i.customerName.startsWith('Coupée'))!;
    expect(pat.creditedPence).toBe(1500);
    expect(pat.balancePence).toBe(pat.totalPence - pat.paidPence - 1500);
    const draft = await post<CreditNoteDto>(`/invoices/${pat.id}/credit-notes`, {
      amountPence: 1000,
      reason: 'Goodwill',
    });
    expect(draft).toMatchObject({ status: 'draft', nextNumber: 'CN-0002' });
    expect((await get<InvoiceDetailDto>(`/invoices/${pat.id}`)).balancePence).toBe(
      pat.balancePence,
    );
    await expect(
      post(`/invoices/${pat.id}/credit-notes`, { amountPence: pat.balancePence, reason: 'x' }),
    ).rejects.toMatchObject({ status: 422 });
    const ok = await post<CreditNoteDto>(`/credit-notes/${draft.id}/approve`);
    expect(ok.number).toBe('CN-0002');
    const after = await get<InvoiceDetailDto>(`/invoices/${pat.id}`);
    expect(after.balancePence).toBe(pat.balancePence - 1000);
    expect(after.creditNotes.map((c) => c.number)).toEqual(['CN-0001', 'CN-0002']);
    const doc = await get<BusinessDocument>(`/credit-notes/${draft.id}/document`);
    expect(doc).toMatchObject({ kind: 'credit_note', number: 'CN-0002', payment: null });
  });
});
