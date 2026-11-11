import { z } from 'zod';
import { lineTotal, parsePounds, sellFromCost, type Pence } from './money';

/* ------------------------------- schemas -------------------------------- */

const text = (max: number) => z.string().trim().max(max);
const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));
const money = z.number().int().min(0).max(100_000_000_00);

export const priceItemInput = z.object({
  code: optional(60),
  description: text(300).min(1, 'Description is required'),
  unit: text(20).min(1).default('each'),
  supplier: optional(100),
  unitCostPence: money,
  /** null = business default markup */
  markupBp: z
    .number()
    .int()
    .min(10000)
    .max(100000)
    .nullish()
    .transform((v) => v ?? null),
  /** Explicit sell price; wins over cost x markup. */
  sellPricePence: money.nullish().transform((v) => v ?? null),
  isActive: z.boolean().default(true),
});
export type PriceItemInput = z.input<typeof priceItemInput>;
export type PriceItem = z.output<typeof priceItemInput>;
/** For PATCH: a field that isn't sent is left alone (no defaults, no blanking). */
const keep = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v || null));
export const priceItemUpdate = z.object({
  code: keep(60),
  description: text(300).min(1, 'Description is required').optional(),
  unit: text(20).min(1).optional(),
  supplier: keep(100),
  unitCostPence: money.optional(),
  markupBp: z.number().int().min(10000).max(100000).nullable().optional(),
  sellPricePence: money.nullable().optional(),
  isActive: z.boolean().optional(),
});
export type PriceItemUpdate = z.input<typeof priceItemUpdate>;

export const kitInput = z.object({
  name: text(120).min(1, 'Give the kit a name'),
  description: optional(1000),
  lines: z
    .array(z.object({ itemId: z.uuid(), qtyMilli: z.number().int().min(1).max(1_000_000_000) }))
    .max(200)
    .default([]),
});
export type KitInput = z.input<typeof kitInput>;
export const kitUpdate = kitInput.partial();
export type KitUpdate = z.input<typeof kitUpdate>;

/** A supplier bill, already read (by a person, or later an AI helper whose output Joe confirms). */
export const supplierBillInput = z.object({
  supplier: text(100).min(1),
  reference: text(200).min(1, 'Bill reference is required'),
  lines: z
    .array(
      z.object({
        code: optional(60),
        description: text(300).min(1),
        unitCostPence: money,
      }),
    )
    .min(1)
    .max(500),
});
export type SupplierBillInput = z.input<typeof supplierBillInput>;

export const priceImportInput = z.object({
  csv: z.string().max(2_000_000),
  /** Dry run (default) returns what would change without writing anything. */
  apply: z.boolean().default(false),
});

/* ------------------------------- pricing -------------------------------- */

/** Sell price per unit: explicit price, else cost x (item markup or default), rounded up. */
export function itemSell(
  item: Pick<PriceItem, 'unitCostPence' | 'markupBp' | 'sellPricePence'>,
  defaultMarkupBp: number,
): Pence {
  if (item.sellPricePence != null) return item.sellPricePence;
  return sellFromCost(item.unitCostPence, item.markupBp ?? defaultMarkupBp);
}

export interface KitComponent {
  itemId: string;
  code: string | null;
  description: string;
  unit: string;
  qtyMilli: number;
  unitCostPence: Pence;
  unitSellPence: Pence;
}

/** Kit cost is the sum of its lines (qty x unit cost, each rounded up), same for sell. */
export function kitTotals(
  lines: Pick<KitComponent, 'qtyMilli' | 'unitCostPence' | 'unitSellPence'>[],
): {
  costPence: Pence;
  sellPence: Pence;
} {
  let costPence = 0;
  let sellPence = 0;
  for (const l of lines) {
    costPence += lineTotal(l.qtyMilli, l.unitCostPence);
    sellPence += lineTotal(l.qtyMilli, l.unitSellPence);
  }
  return { costPence, sellPence };
}

/** What a kit block on a quote line keeps: the costed kit as it was when added (frozen once sent). */
export interface QuoteKitSnapshot {
  kitId: string;
  name: string;
  costPence: Pence;
  sellPence: Pence;
  components: KitComponent[];
}
export const quoteKitSnapshot = z.object({
  kitId: z.uuid(),
  name: text(120).min(1),
  costPence: money,
  sellPence: money,
  components: z
    .array(
      z.object({
        itemId: z.uuid(),
        code: z.string().max(60).nullable(),
        description: text(300).min(1),
        unit: text(20).min(1),
        qtyMilli: z.number().int().min(1),
        unitCostPence: money,
        unitSellPence: money,
      }),
    )
    .max(200),
});

/* ------------------------- kits on quote lines --------------------------- */

/** Freezes a kit (as the server costs it now) for a quote line. */
export function snapshotFromKit(kit: {
  id: string;
  name: string;
  costPence: Pence;
  sellPence: Pence;
  lines: KitComponent[];
}): QuoteKitSnapshot {
  return {
    kitId: kit.id,
    name: kit.name,
    costPence: kit.costPence,
    sellPence: kit.sellPence,
    components: kit.lines.map((l) => ({
      itemId: l.itemId,
      code: l.code,
      description: l.description,
      unit: l.unit,
      qtyMilli: l.qtyMilli,
      unitCostPence: l.unitCostPence,
      unitSellPence: l.unitSellPence,
    })),
  };
}

export interface KitQuoteLine {
  kind: 'material';
  description: string;
  qtyMilli: number;
  unitCostPence: Pence;
  markupBp: null;
  unitPricePence: Pence;
  optionLabel: string | null;
  taxRateBp: number;
  kit: QuoteKitSnapshot;
}

/** A kit as one costed block on a quote: cost and sell per kit, qty = number of kits. */
export function kitQuoteLine(
  snap: QuoteKitSnapshot,
  qtyMilli = 1000,
  optionLabel: string | null = null,
): KitQuoteLine {
  return {
    kind: 'material',
    description: snap.name,
    qtyMilli,
    unitCostPence: snap.costPence,
    markupBp: null,
    unitPricePence: snap.sellPence,
    optionLabel,
    taxRateBp: 0,
    kit: snap,
  };
}

/**
 * Expands a kit block into its component lines (qty multiplied by the number of kits), at the
 * frozen prices. Rounding is per line, so the total can differ from the block by a penny or two.
 */
export function expandKitLine(line: {
  qtyMilli: number;
  optionLabel: string | null;
  taxRateBp?: number;
  kit: QuoteKitSnapshot;
}) {
  return line.kit.components.map((c) => ({
    kind: 'material' as const,
    description: c.description,
    qtyMilli: Math.round((c.qtyMilli * line.qtyMilli) / 1000),
    unitCostPence: c.unitCostPence,
    markupBp: null,
    unitPricePence: c.unitSellPence,
    optionLabel: line.optionLabel,
    taxRateBp: line.taxRateBp ?? 0,
    kit: null,
  }));
}

/** Has the kit's price moved since this block was added? */
export function kitPriceChanged(
  snap: Pick<QuoteKitSnapshot, 'costPence' | 'sellPence'>,
  current: { costPence: Pence; sellPence: Pence } | undefined,
): boolean {
  return (
    !!current && (current.costPence !== snap.costPence || current.sellPence !== snap.sellPence)
  );
}

/* --------------------------------- DTOs --------------------------------- */

export type PriceSource = 'created' | 'manual' | 'csv' | 'supplier_bill';

export interface PriceItemDto extends PriceItem {
  id: string;
  /** Sell per unit after markup/override, computed by the server. */
  unitSellPence: Pence;
  kitCount: number;
  updatedAt: string;
}
export interface PriceHistoryDto {
  id: string;
  oldCostPence: Pence | null;
  newCostPence: Pence;
  source: PriceSource;
  reference: string | null;
  userName: string | null;
  createdAt: string;
}
export interface PriceItemDetailDto extends PriceItemDto {
  history: PriceHistoryDto[];
  kits: { id: string; name: string }[];
}

export interface KitLineDto extends KitComponent {
  lineCostPence: Pence;
  lineSellPence: Pence;
  isActive: boolean;
}
export interface KitCostChangeDto {
  id: string;
  itemDescription: string;
  oldCostPence: Pence;
  newCostPence: Pence;
  oldSellPence: Pence;
  newSellPence: Pence;
  source: PriceSource;
  createdAt: string;
}
export interface KitSummaryDto {
  id: string;
  name: string;
  description: string | null;
  lineCount: number;
  costPence: Pence;
  sellPence: Pence;
  /** The most recent cost change, if any: shown as "was £x". */
  lastChange: KitCostChangeDto | null;
}
export interface KitDetailDto extends KitSummaryDto {
  lines: KitLineDto[];
  changes: KitCostChangeDto[];
}

export interface PriceChangeDto {
  itemId: string;
  description: string;
  oldCostPence: Pence;
  newCostPence: Pence;
}
export interface KitChangeSummary {
  kitId: string;
  name: string;
  oldCostPence: Pence;
  newCostPence: Pence;
  oldSellPence: Pence;
  newSellPence: Pence;
}
export interface SupplierBillResultDto {
  updated: PriceChangeDto[];
  unchanged: number;
  /** Bill lines that matched nothing on the price list: left for Joe to add. */
  unmatched: { code: string | null; description: string; unitCostPence: Pence }[];
  kits: KitChangeSummary[];
}
export interface PriceImportResultDto {
  applied: boolean;
  created: PriceItem[];
  updated: (PriceChangeDto & { row: number })[];
  unchanged: number;
  errors: CsvRowError[];
  kits: KitChangeSummary[];
}

/* ---------------------------------- CSV --------------------------------- */

/** RFC 4180-ish: quoted fields, doubled quotes, CRLF/LF, a leading BOM; blank lines skipped. */
export function parseCsv(input: string): string[][] {
  const s = input.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const endRow = () => {
    row.push(field);
    if (row.some((f) => f.trim() !== '')) rows.push(row);
    row = [];
    field = '';
  };
  while (i < s.length) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else field += c;
      i += 1;
      continue;
    }
    if (c === '"' && field.trim() === '') {
      quoted = true;
      field = '';
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      endRow();
      if (c === '\r' && s[i + 1] === '\n') i += 1;
    } else field += c;
    i += 1;
  }
  if (field !== '' || row.length) endRow();
  return rows;
}

export interface CsvRowError {
  /** 1-based line number in the file (header = 1). */
  row: number;
  message: string;
}

export type CsvColumn = 'code' | 'description' | 'unit' | 'supplier' | 'cost' | 'markup' | 'sell';
type Column = CsvColumn;
const HEADERS: Record<Column, string[]> = {
  code: ['code', 'sku', 'item code', 'product code', 'part number', 'part no'],
  description: ['description', 'item', 'name', 'product'],
  unit: ['unit', 'uom', 'units'],
  supplier: ['supplier', 'merchant', 'vendor'],
  cost: ['cost', 'unit cost', 'cost price', 'buy', 'buy price', 'net'],
  markup: ['markup', 'markup %', 'mark-up', 'margin %'],
  sell: ['sell', 'sell price', 'price', 'unit price', 'retail'],
};

/** "30" or "30%" = 30% markup (1.3x); "1.3x" = multiplier. */
export function parseMarkup(input: string): number | null {
  const v = input.trim().toLowerCase();
  if (!v) return null;
  const mult = /^(\d+(?:\.\d{1,4})?)\s*x$/.exec(v);
  if (mult) return Math.round(Number(mult[1]) * 10000);
  const pct = /^(\d+(?:\.\d{1,2})?)\s*%?$/.exec(v);
  if (pct) return Math.round(10000 + Number(pct[1]) * 100);
  return null;
}

/** Maps a price-list CSV (any column order; header names are forgiving) to validated items. */
export function priceRowsFromCsv(text: string): {
  rows: { row: number; item: PriceItem }[];
  errors: CsvRowError[];
  /** Columns the file has: an absent column never changes an existing item. */
  columns: CsvColumn[];
} {
  const table = parseCsv(text);
  const errors: CsvRowError[] = [];
  if (!table.length)
    return { rows: [], errors: [{ row: 1, message: 'The file is empty' }], columns: [] };
  const header = table[0]!.map((h) => h.trim().toLowerCase());
  const col = {} as Record<Column, number>;
  for (const key of Object.keys(HEADERS) as Column[]) {
    col[key] = header.findIndex((h) => HEADERS[key].includes(h));
  }
  if (col.description < 0 || col.cost < 0) {
    return {
      rows: [],
      errors: [{ row: 1, message: 'Needs at least "Description" and "Cost" columns' }],
      columns: [],
    };
  }
  const rows: { row: number; item: PriceItem }[] = [];
  const seen = new Set<string>();
  table.slice(1).forEach((cells, idx) => {
    const row = idx + 2;
    const get = (c: Column) => (col[c] >= 0 ? (cells[col[c]] ?? '').trim() : '');
    const cost = parsePounds(get('cost'));
    if (cost == null || cost < 0) {
      errors.push({ row, message: `Cost "${get('cost')}" isn't a price` });
      return;
    }
    let markupBp: number | null = null;
    if (get('markup')) {
      markupBp = parseMarkup(get('markup'));
      if (markupBp == null || markupBp < 10000 || markupBp > 100000) {
        errors.push({ row, message: `Markup "${get('markup')}" isn't between 0% and 900%` });
        return;
      }
    }
    let sell: number | null = null;
    if (get('sell')) {
      sell = parsePounds(get('sell'));
      if (sell == null || sell < 0) {
        errors.push({ row, message: `Sell price "${get('sell')}" isn't a price` });
        return;
      }
    }
    const parsed = priceItemInput.safeParse({
      code: get('code') || null,
      description: get('description'),
      unit: get('unit') || 'each',
      supplier: get('supplier') || null,
      unitCostPence: cost,
      markupBp,
      sellPricePence: sell,
    });
    if (!parsed.success) {
      errors.push({ row, message: parsed.error.issues[0]?.message ?? 'Invalid row' });
      return;
    }
    const key = priceItemKey(parsed.data);
    if (seen.has(key)) {
      errors.push({ row, message: 'Duplicate of an earlier row' });
      return;
    }
    seen.add(key);
    rows.push({ row, item: parsed.data });
  });
  const columns = (Object.keys(col) as Column[]).filter((k) => col[k] >= 0);
  return { rows, errors, columns };
}

/**
 * What an import row changes on an existing item. Only columns present in the file count, and
 * blank supplier/code cells never clear a value.
 */
export function importChanges(
  existing: PriceItem,
  row: PriceItem,
  columns: readonly CsvColumn[],
): Partial<PriceItem> {
  const has = (c: CsvColumn) => columns.includes(c);
  const next: Partial<PriceItem> = {};
  if (existing.unitCostPence !== row.unitCostPence) next.unitCostPence = row.unitCostPence;
  if (has('markup') && existing.markupBp !== row.markupBp) next.markupBp = row.markupBp;
  if (has('sell') && existing.sellPricePence !== row.sellPricePence)
    next.sellPricePence = row.sellPricePence;
  if (has('unit') && existing.unit !== row.unit) next.unit = row.unit;
  if (row.supplier && existing.supplier !== row.supplier) next.supplier = row.supplier;
  if (row.code && existing.description !== row.description) next.description = row.description;
  if (!existing.isActive) next.isActive = true;
  return next;
}

/** Rows match existing items on code, else on supplier + description (case-insensitive). */
export function priceItemKey(i: Pick<PriceItem, 'code' | 'supplier' | 'description'>): string {
  return i.code
    ? `code:${i.code.toLowerCase()}`
    : `desc:${(i.supplier ?? '').toLowerCase()}|${i.description.toLowerCase()}`;
}

/** Turns a list of items back into CSV (for export, and round-trip tests). */
export function priceItemsToCsv(items: PriceItem[]): string {
  const esc = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const p = (n: number | null) => (n == null ? '' : (n / 100).toFixed(2));
  const lines = ['Code,Description,Unit,Supplier,Cost,Markup,Sell'];
  for (const i of items) {
    lines.push(
      [
        esc(i.code ?? ''),
        esc(i.description),
        esc(i.unit),
        esc(i.supplier ?? ''),
        p(i.unitCostPence),
        i.markupBp == null ? '' : `${(i.markupBp - 10000) / 100}%`,
        p(i.sellPricePence),
      ].join(','),
    );
  }
  return lines.join('\n') + '\n';
}
