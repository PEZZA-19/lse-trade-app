/**
 * Suppliers, supplier bills and supplier credit notes.
 * A bill is read by a person for now (typed in, a CSV, or typed from a PDF; AI bill reading is
 * Phase 2 and will only ever fill in a draft for Joe to check). Applying a bill is an owner tap
 * after a preview: new costs update the price list (with history and kit recalculation) and lines
 * allocated to a job become that job's materials. Credit notes reduce the job they belong to and
 * never change list prices.
 */
import { z } from 'zod';
import { lineTotal, parsePounds, parseQty, type Pence } from './money';
import {
  parseCsv,
  type CsvRowError,
  type KitChangeSummary,
  type PriceChangeDto,
} from './pricelist';

const text = (max: number) => z.string().trim().max(max);
const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));
const money = z.number().int().min(0).max(100_000_000_00);

export const BILL_KINDS = ['bill', 'credit_note'] as const;
export type BillKind = (typeof BILL_KINDS)[number];
export const BILL_KIND_LABELS: Record<BillKind, string> = {
  bill: 'Bill',
  credit_note: 'Credit note',
};
export const BILL_SOURCES = ['manual', 'csv', 'pdf'] as const;
export type BillSource = (typeof BILL_SOURCES)[number];
export const ALLOCATIONS = ['job', 'stock', 'home'] as const;
export type Allocation = (typeof ALLOCATIONS)[number];
export const ALLOCATION_LABELS: Record<Allocation, string> = {
  job: 'Job',
  stock: 'Stock',
  home: 'Home',
};

export const supplierInput = z.object({
  name: text(100).min(1, 'Supplier name is required'),
  email: z
    .union([z.email('Enter a valid email').trim().toLowerCase().max(254), z.literal('')])
    .nullish()
    .transform((v) => (v ? v : null)),
  phone: optional(40),
  accountRef: optional(60),
  notes: optional(2000),
});
export type SupplierInput = z.input<typeof supplierInput>;
export const supplierUpdate = z.object({
  name: text(100).min(1, 'Supplier name is required').optional(),
  email: z
    .union([z.email('Enter a valid email').trim().toLowerCase().max(254), z.literal('')])
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v || null)),
  phone: optional(40).optional(),
  accountRef: optional(60).optional(),
  notes: optional(2000).optional(),
});
export type SupplierUpdate = z.input<typeof supplierUpdate>;

export const billLineInput = z.object({
  code: optional(60),
  description: text(300).min(1, 'Description is required'),
  qtyMilli: z.number().int().min(1, 'Quantity must be more than 0').max(1_000_000_000),
  unitCostPence: money,
  /**
   * Price-list item this line is. Not sent: matched automatically (code, then supplier and
   * description). null: deliberately not on the price list.
   */
  itemId: z.uuid().nullable().optional(),
  /** Update the item's cost from this line when the bill is applied. */
  updatePrice: z.boolean().default(true),
  /** Not sent: "job" when the bill is for a job, else "stock". */
  allocation: z.enum(ALLOCATIONS).optional(),
});
export type BillLineInput = z.input<typeof billLineInput>;

export const billCreate = z.object({
  supplier: text(100).min(1, 'Supplier is required'),
  kind: z.enum(BILL_KINDS).default('bill'),
  reference: text(100).min(1, 'Bill reference is required'),
  billDate: z.iso.date('Enter the bill date'),
  jobId: z
    .uuid()
    .nullish()
    .transform((v) => v ?? null),
  source: z.enum(BILL_SOURCES).default('manual'),
  fileName: optional(200),
  notes: optional(2000),
  lines: z.array(billLineInput).max(500).default([]),
});
export type BillCreate = z.input<typeof billCreate>;

/** Drafts only. Lines, when sent, replace all lines. */
export const billUpdate = z.object({
  reference: text(100).min(1, 'Bill reference is required').optional(),
  billDate: z.iso.date().optional(),
  jobId: z.uuid().nullable().optional(),
  notes: optional(2000).optional(),
  lines: z.array(billLineInput).max(500).optional(),
});
export type BillUpdate = z.input<typeof billUpdate>;

export const billApply = z.object({
  /** Preview (default): what applying would change, without changing anything. */
  dryRun: z.boolean().default(true),
});

/* --------------------------------- maths -------------------------------- */

export function billTotal(lines: { qtyMilli: number; unitCostPence: Pence }[]): Pence {
  return lines.reduce((t, l) => t + lineTotal(l.qtyMilli, l.unitCostPence), 0);
}

/* ---------------------------------- CSV --------------------------------- */

const BILL_HEADERS: Record<'code' | 'description' | 'qty' | 'cost' | 'total', string[]> = {
  code: ['code', 'sku', 'item code', 'product code', 'part number', 'part no', 'stock code'],
  description: ['description', 'item', 'product', 'details', 'name'],
  qty: ['qty', 'quantity', 'qty shipped', 'qty invoiced', 'units'],
  cost: ['unit cost', 'cost', 'unit price', 'price', 'net price', 'each', 'rate'],
  total: ['total', 'net', 'line total', 'net total', 'amount', 'value', 'goods'],
};

export interface BillCsvLine {
  code: string | null;
  description: string;
  qtyMilli: number;
  unitCostPence: Pence;
}

/**
 * Supplier bill lines from a CSV export (any column order, forgiving header names). If only a
 * line total is given, the unit cost is the total divided by the quantity, rounded to the penny.
 */
export function billLinesFromCsv(text: string): { lines: BillCsvLine[]; errors: CsvRowError[] } {
  const table = parseCsv(text);
  if (!table.length) return { lines: [], errors: [{ row: 1, message: 'The file is empty' }] };
  const header = table[0]!.map((h) => h.trim().toLowerCase().replace(/\s+/g, ' '));
  const col: Partial<Record<keyof typeof BILL_HEADERS, number>> = {};
  for (const [key, names] of Object.entries(BILL_HEADERS) as [
    keyof typeof BILL_HEADERS,
    string[],
  ][]) {
    const i = header.findIndex((h) => names.includes(h));
    if (i >= 0) col[key] = i;
  }
  if (col.description === undefined)
    return { lines: [], errors: [{ row: 1, message: 'No Description column found' }] };
  if (col.cost === undefined && col.total === undefined)
    return { lines: [], errors: [{ row: 1, message: 'No Unit cost or Total column found' }] };
  const lines: BillCsvLine[] = [];
  const errors: CsvRowError[] = [];
  table.slice(1).forEach((cells, i) => {
    const row = i + 2;
    const get = (k: keyof typeof BILL_HEADERS) =>
      col[k] === undefined ? '' : (cells[col[k]!] ?? '').trim();
    const description = get('description');
    if (!description) return errors.push({ row, message: 'Description is missing' });
    const qtyText = get('qty');
    const qtyMilli = qtyText ? parseQty(qtyText) : 1000;
    if (qtyMilli == null || qtyMilli <= 0)
      return errors.push({ row, message: `Quantity "${qtyText}" isn't a number above 0` });
    let unit: Pence | null = null;
    if (get('cost')) {
      unit = parsePounds(get('cost'));
      if (unit == null || unit < 0)
        return errors.push({ row, message: `Unit cost "${get('cost')}" isn't an amount` });
    } else {
      const total = parsePounds(get('total'));
      if (total == null || total < 0)
        return errors.push({ row, message: `Total "${get('total')}" isn't an amount` });
      unit = Math.round((total * 1000) / qtyMilli);
    }
    lines.push({
      code: get('code') || null,
      description: description.slice(0, 300),
      qtyMilli,
      unitCostPence: unit,
    });
  });
  return { lines, errors };
}

/* --------------------------------- DTOs --------------------------------- */

export interface SupplierDto {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  accountRef: string | null;
  notes: string | null;
  billCount: number;
  /** Bills minus credit notes, applied only. */
  spendPence: Pence;
  priceItemCount: number;
  lastBillDate: string | null;
  version: number;
}

export interface BillSummaryDto {
  id: string;
  supplierId: string;
  supplierName: string;
  kind: BillKind;
  reference: string;
  billDate: string;
  jobId: string | null;
  jobNumber: string | null;
  jobTitle: string | null;
  status: 'draft' | 'applied';
  source: BillSource;
  totalPence: Pence;
  lineCount: number;
  unmatchedCount: number;
  createdAt: string;
  version: number;
}

export interface BillLineDto {
  id: string;
  position: number;
  code: string | null;
  description: string;
  qtyMilli: number;
  unitCostPence: Pence;
  totalPence: Pence;
  item: {
    id: string;
    code: string | null;
    description: string;
    unitCostPence: Pence;
    unit: string;
  } | null;
  updatePrice: boolean;
  allocation: Allocation;
  jobLineId: string | null;
}

export interface BillDetailDto extends BillSummaryDto {
  fileName: string | null;
  notes: string | null;
  lines: BillLineDto[];
  appliedByName: string | null;
  appliedAt: string | null;
}

/** What applying a bill does (or did): shown before the owner taps Apply. */
export interface BillApplyResultDto {
  applied: boolean;
  priceChanges: PriceChangeDto[];
  /** Lines whose cost equals the list cost already. */
  unchangedPrices: number;
  kits: KitChangeSummary[];
  /** Lines added to the job's costs (negative for a credit note). */
  jobLines: {
    description: string;
    qtyMilli: number;
    unitCostPence: Pence;
    unitSellPence: Pence;
    totalPence: Pence;
  }[];
  jobNumber: string | null;
  /** Lines with no price-list item: they still count as costs, the list isn't changed. */
  notOnPriceList: number;
}
