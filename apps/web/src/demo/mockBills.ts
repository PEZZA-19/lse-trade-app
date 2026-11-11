/**
 * Demo (preview) version of the suppliers and supplier bills API. Same rules as the server
 * (apps/api/src/services/bills.ts): matching, preview-then-apply by the owner, price updates with
 * history and kit recalculation, job materials, credit notes that never change list prices.
 */
import {
  billApply,
  billCreate,
  billLineTotal,
  billTotal,
  billUpdate,
  itemSell,
  sellFromCost,
  signedLineTotal,
  supplierInput,
  supplierUpdate,
  type Allocation,
  type BillApplyResultDto,
  type BillDetailDto,
  type BillKind,
  type BillLineInput,
  type BillSource,
  type BillSummaryDto,
  type PriceChangeDto,
  type SupplierDto,
} from '@lse/shared';
import type { z } from 'zod';
import { applyPatches, matcher, type BillingCtx } from './mockBilling';

export interface DemoSupplier {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  accountRef: string | null;
  notes: string | null;
  version: number;
}
interface DemoBillLine {
  id: string;
  code: string | null;
  description: string;
  qtyMilli: number;
  unitCostPence: number;
  /** Merchant's printed total, when it differs from qty × unit cost by rounding. */
  totalPence?: number;
  itemId: string | null;
  updatePrice: boolean;
  allocation: Allocation;
  jobLineId: string | null;
}
export interface DemoBill {
  id: string;
  supplierId: string;
  kind: BillKind;
  reference: string;
  billDate: string;
  dueDate?: string | null;
  jobId: string | null;
  status: 'draft' | 'applied';
  source: BillSource;
  fileName: string | null;
  notes: string | null;
  lines: DemoBillLine[];
  appliedAt: string | null;
  createdAt: string;
  version: number;
}

const suppliersOf = (c: BillingCtx) => (c.b.suppliers ??= []);
const billsOf = (c: BillingCtx) => (c.b.bills ??= []);

function supplierDto(c: BillingCtx, s: DemoSupplier): SupplierDto {
  const mine = billsOf(c).filter((b) => b.supplierId === s.id);
  return {
    ...s,
    billCount: mine.length,
    spendPence: mine
      .filter((b) => b.status === 'applied')
      .reduce((t, b) => t + (b.kind === 'credit_note' ? -1 : 1) * billTotal(b.lines), 0),
    priceItemCount: c.b.items.filter((i) => i.supplier?.toLowerCase() === s.name.toLowerCase())
      .length,
    lastBillDate:
      mine
        .map((b) => b.billDate)
        .sort()
        .at(-1) ?? null,
  };
}
const getSupplier = (c: BillingCtx, id: string) =>
  suppliersOf(c).find((s) => s.id === id) ?? c.fail(404, 'not_found', 'Supplier not found');

function supplierFor(c: BillingCtx, name: string): DemoSupplier {
  const found = suppliersOf(c).find((s) => s.name.toLowerCase() === name.toLowerCase());
  if (found) return found;
  const listed = c.b.items.find((i) => i.supplier?.toLowerCase() === name.toLowerCase());
  const s: DemoSupplier = {
    id: c.uid(),
    name: listed?.supplier ?? name,
    email: null,
    phone: null,
    accountRef: null,
    notes: null,
    version: 1,
  };
  suppliersOf(c).push(s);
  return s;
}

function summary(c: BillingCtx, b: DemoBill): BillSummaryDto {
  const job = b.jobId ? c.job(b.jobId) : null;
  return {
    id: b.id,
    supplierId: b.supplierId,
    supplierName: getSupplier(c, b.supplierId).name,
    kind: b.kind,
    reference: b.reference,
    billDate: b.billDate,
    dueDate: b.dueDate ?? null,
    jobId: b.jobId,
    jobNumber: job?.number ?? null,
    jobTitle: job?.title ?? null,
    status: b.status,
    source: b.source,
    totalPence: billTotal(b.lines),
    lineCount: b.lines.length,
    unmatchedCount: b.lines.filter((l) => !l.itemId).length,
    createdAt: b.createdAt,
    version: b.version,
  };
}
function detail(c: BillingCtx, b: DemoBill): BillDetailDto {
  return {
    ...summary(c, b),
    fileName: b.fileName,
    notes: b.notes,
    appliedByName: b.appliedAt ? c.userName : null,
    appliedAt: b.appliedAt,
    lines: b.lines.map((l, position) => {
      const item = l.itemId ? c.b.items.find((i) => i.id === l.itemId) : undefined;
      return {
        id: l.id,
        position,
        code: l.code,
        description: l.description,
        qtyMilli: l.qtyMilli,
        unitCostPence: l.unitCostPence,
        totalPence: billLineTotal(l),
        updatePrice: l.updatePrice,
        allocation: l.allocation,
        jobLineId: l.jobLineId,
        item: item
          ? {
              id: item.id,
              code: item.code,
              description: item.description,
              unitCostPence: item.unitCostPence,
              unit: item.unit,
            }
          : null,
      };
    }),
  };
}
const getBill = (c: BillingCtx, id: string) =>
  billsOf(c).find((b) => b.id === id) ?? c.fail(404, 'not_found', 'Bill not found');

function toLines(
  c: BillingCtx,
  supplierName: string,
  hasJob: boolean,
  lines: z.output<typeof billCreate>['lines'],
): DemoBillLine[] {
  const find = matcher(c);
  return lines.map((l: z.output<typeof billCreate>['lines'][number] & BillLineInput, i) => {
    if (l.allocation === 'job' && !hasJob)
      c.fail(422, 'validation_failed', 'Pick the job first, then put lines on it', {
        fields: { [`lines.${i}.allocation`]: 'This bill has no job' },
      });
    const itemId =
      l.itemId === undefined
        ? (find({ code: l.code, supplier: supplierName, description: l.description })?.id ?? null)
        : l.itemId;
    return {
      id: c.uid(),
      code: l.code,
      description: l.description,
      qtyMilli: l.qtyMilli,
      unitCostPence: l.unitCostPence,
      ...(l.totalPence !== undefined ? { totalPence: l.totalPence } : {}),
      itemId,
      updatePrice: l.updatePrice,
      allocation: l.allocation ?? (hasJob ? 'job' : 'stock'),
      jobLineId: null,
    };
  });
}

function draftOf(c: BillingCtx, id: string): DemoBill {
  const b = getBill(c, id);
  const expected = c.ifMatch();
  if (expected !== undefined && expected !== b.version)
    c.fail(409, 'version_conflict', 'This was changed on another device since you edited it.', {
      currentVersion: b.version,
      current: detail(c, b),
    });
  if (b.status !== 'draft')
    c.fail(409, 'bill_applied', 'This bill has been applied, so it can no longer be changed.');
  return b;
}

function apply(c: BillingCtx, b: DemoBill, dryRun: boolean): BillApplyResultDto {
  if (!b.lines.length) c.fail(422, 'validation_failed', 'Add the bill lines first');
  const credit = b.kind === 'credit_note';
  const supplier = getSupplier(c, b.supplierId);
  const snapshot = dryRun ? JSON.stringify(c.b) : null;
  const priceChanges: PriceChangeDto[] = [];
  let unchangedPrices = 0;
  const patches: Parameters<typeof applyPatches>[1] = [];
  if (!credit)
    for (const l of b.lines) {
      const item = l.itemId && l.updatePrice ? c.b.items.find((i) => i.id === l.itemId) : undefined;
      if (!item) continue;
      if (item.unitCostPence === l.unitCostPence) {
        unchangedPrices += 1;
        continue;
      }
      priceChanges.push({
        itemId: item.id,
        description: item.description,
        oldCostPence: item.unitCostPence,
        newCostPence: l.unitCostPence,
      });
      patches.push({ item, next: { unitCostPence: l.unitCostPence } });
    }
  const kits = patches.length
    ? applyPatches(c, patches, 'supplier_bill', `${supplier.name} ${b.reference}`)
    : [];
  const forJob = b.lines.filter((l) => l.allocation === 'job');
  const jobLines: BillApplyResultDto['jobLines'] = [];
  const job = b.jobId ? c.job(b.jobId) : null;
  if (forJob.length && !job)
    c.fail(422, 'validation_failed', 'Pick the job these materials are for');
  const markup = c.settings().defaultMarkupBp;
  for (const l of forJob) {
    const item = l.itemId ? c.b.items.find((i) => i.id === l.itemId) : undefined;
    const sell = item
      ? itemSell(
          { unitCostPence: l.unitCostPence, markupBp: item.markupBp, sellPricePence: null },
          markup,
        )
      : sellFromCost(l.unitCostPence, markup);
    const qty = credit ? -l.qtyMilli : l.qtyMilli;
    const total = signedLineTotal(qty, sell);
    const description = credit ? `Credit: ${l.description}` : l.description;
    jobLines.push({
      description,
      qtyMilli: qty,
      unitCostPence: l.unitCostPence,
      unitSellPence: sell,
      totalPence: total,
    });
    if (!dryRun && job) {
      const id = c.uid();
      job.lines.push({
        id,
        position: job.lines.length,
        kind: 'material',
        description,
        qtyMilli: qty,
        unitCostPence: l.unitCostPence,
        unitSellPence: sell,
        totalPence: total,
        source: 'supplier_bill',
      });
      l.jobLineId = id;
    }
  }
  if (snapshot) Object.assign(c.b, JSON.parse(snapshot) as typeof c.b);
  else {
    b.status = 'applied';
    b.appliedAt = c.now();
    b.version += 1;
  }
  return {
    applied: !dryRun,
    priceChanges,
    unchangedPrices,
    kits,
    jobLines,
    jobNumber: job?.number ?? null,
    notOnPriceList: b.lines.filter((l) => !l.itemId).length,
  };
}

/** Handles /suppliers and /supplier-bills; returns undefined for anything else. */
export function billsRoute(
  c: BillingCtx,
  method: string,
  seg: string[],
  query: URLSearchParams,
  body: unknown,
): unknown {
  const [a, id, sub] = seg;
  if (a === 'suppliers') {
    if (method === 'GET' && !id)
      return suppliersOf(c)
        .slice()
        .sort((x, y) => x.name.localeCompare(y.name))
        .map((s) => supplierDto(c, s));
    if (method === 'POST' && !id) {
      const input = c.parse(supplierInput, body);
      if (suppliersOf(c).some((s) => s.name.toLowerCase() === input.name.toLowerCase()))
        c.fail(422, 'validation_failed', 'There is already a supplier with that name', {
          fields: { name: 'Already on your list' },
        });
      const s: DemoSupplier = { id: c.uid(), version: 1, ...input };
      suppliersOf(c).push(s);
      return supplierDto(c, s);
    }
    const s = getSupplier(c, id!);
    if (method === 'GET') return supplierDto(c, s);
    if (method === 'PATCH') {
      const input = c.parse(supplierUpdate, body);
      const expected = c.ifMatch();
      if (expected !== undefined && expected !== s.version)
        c.fail(409, 'version_conflict', 'This was changed on another device since you edited it.', {
          currentVersion: s.version,
          current: supplierDto(c, s),
        });
      if (
        input.name &&
        suppliersOf(c).some(
          (x) => x.id !== s.id && x.name.toLowerCase() === input.name!.toLowerCase(),
        )
      )
        c.fail(422, 'validation_failed', 'There is already a supplier with that name', {
          fields: { name: 'Already on your list' },
        });
      if (input.name && input.name !== s.name)
        for (const i of c.b.items)
          if (i.supplier?.toLowerCase() === s.name.toLowerCase()) i.supplier = input.name;
      const defined = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
      Object.assign(s, defined);
      s.version += 1;
      return supplierDto(c, s);
    }
  }
  if (a !== 'supplier-bills') return undefined;
  if (method === 'GET' && !id) {
    const status = query.get('status');
    const supplierId = query.get('supplierId');
    const jobId = query.get('jobId');
    return billsOf(c)
      .filter(
        (b) => (!status || b.status === status) && (!supplierId || b.supplierId === supplierId),
      )
      .filter((b) => !jobId || b.jobId === jobId)
      .sort(
        (x, y) =>
          Number(y.status === 'draft') - Number(x.status === 'draft') ||
          y.billDate.localeCompare(x.billDate) ||
          y.createdAt.localeCompare(x.createdAt),
      )
      .map((b) => summary(c, b));
  }
  if (method === 'POST' && !id) {
    const input = c.parse(billCreate, body);
    if (input.jobId) c.job(input.jobId);
    const s = supplierFor(c, input.supplier);
    if (
      billsOf(c).some(
        (b) =>
          b.supplierId === s.id &&
          b.kind === input.kind &&
          b.reference.toLowerCase() === input.reference.toLowerCase(),
      )
    )
      c.fail(409, 'duplicate_bill', 'This supplier reference has already been entered.', {
        fields: { reference: 'Already entered for this supplier' },
      });
    const b: DemoBill = {
      id: c.uid(),
      supplierId: s.id,
      kind: input.kind,
      reference: input.reference,
      billDate: input.billDate,
      dueDate: input.dueDate,
      jobId: input.jobId,
      status: 'draft',
      source: input.source,
      fileName: input.fileName,
      notes: input.notes,
      lines: toLines(c, s.name, !!input.jobId, input.lines),
      appliedAt: null,
      createdAt: c.now(),
      version: 1,
    };
    billsOf(c).push(b);
    return detail(c, b);
  }
  if (method === 'GET' && !sub) return detail(c, getBill(c, id!));
  if (method === 'PATCH' && !sub) {
    const b = draftOf(c, id!);
    const input = c.parse(billUpdate, body);
    if (input.jobId) c.job(input.jobId);
    if (input.reference !== undefined) b.reference = input.reference;
    if (input.billDate !== undefined) b.billDate = input.billDate;
    if (input.dueDate !== undefined) b.dueDate = input.dueDate;
    if (input.notes !== undefined) b.notes = input.notes;
    if (input.jobId !== undefined) b.jobId = input.jobId;
    if (input.lines)
      b.lines = toLines(c, getSupplier(c, b.supplierId).name, !!b.jobId, input.lines);
    if (!b.jobId) for (const l of b.lines) if (l.allocation === 'job') l.allocation = 'stock';
    b.version += 1;
    return detail(c, b);
  }
  if (method === 'DELETE' && !sub) {
    const b = draftOf(c, id!);
    c.b.bills = billsOf(c).filter((x) => x.id !== b.id);
    return null;
  }
  if (method === 'POST' && sub === 'apply') {
    const b = draftOf(c, id!);
    const input = c.parse(billApply, body ?? {});
    return apply(c, b, input.dryRun);
  }
  return undefined;
}
