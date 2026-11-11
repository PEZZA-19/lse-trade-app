import {
  itemSell,
  kitTotals,
  priceItemKey,
  priceRowsFromCsv,
  importChanges,
  type KitChangeSummary,
  type KitCostChangeDto,
  type KitDetailDto,
  type KitLineDto,
  type KitSummaryDto,
  type PriceChangeDto,
  type PriceHistoryDto,
  type PriceImportResultDto,
  type PriceItem,
  type PriceItemDetailDto,
  type PriceItemDto,
  type PriceSource,
  type SupplierBillResultDto,
  type kitInput,
  type kitUpdate,
  type priceItemInput,
  type priceItemUpdate,
  type supplierBillInput,
} from '@lse/shared';
import type { z } from 'zod';
import type { Tx } from '../db/client';
import { conflict, invalid, notFound } from '../lib/errors';
import { isoNN, type Auth } from '../lib/types';
import { audit } from './audit';

export interface ItemRow extends PriceItem {
  id: string;
  updatedAt: Date;
  kitCount: number;
}

export async function defaultMarkup(tx: Tx): Promise<number> {
  const [t] = await tx<
    { defaultMarkupBp: number }[]
  >`SELECT default_markup_bp FROM tenants WHERE id = app_current_tenant()`;
  if (!t) throw notFound('Business');
  return t.defaultMarkupBp;
}

export const ITEM_COLS =
  'i.id, i.code, i.description, i.unit, i.supplier, i.unit_cost_pence, i.markup_bp, i.sell_price_pence, i.is_active, i.updated_at';

function toItemDto(r: ItemRow, markup: number): PriceItemDto {
  return {
    id: r.id,
    code: r.code,
    description: r.description,
    unit: r.unit,
    supplier: r.supplier,
    unitCostPence: Number(r.unitCostPence),
    markupBp: r.markupBp,
    sellPricePence: r.sellPricePence == null ? null : Number(r.sellPricePence),
    isActive: r.isActive,
    unitSellPence: itemSell(
      {
        unitCostPence: Number(r.unitCostPence),
        markupBp: r.markupBp,
        sellPricePence: r.sellPricePence == null ? null : Number(r.sellPricePence),
      },
      markup,
    ),
    kitCount: Number(r.kitCount),
    updatedAt: isoNN(r.updatedAt),
  };
}

/* ------------------------------ price list ------------------------------ */

export async function listItems(
  tx: Tx,
  q: { search?: string; includeInactive?: boolean } = {},
): Promise<PriceItemDto[]> {
  const markup = await defaultMarkup(tx);
  const like = q.search ? `%${q.search.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
  const rows = await tx<ItemRow[]>`
    SELECT ${tx.unsafe(ITEM_COLS)},
           (SELECT count(DISTINCT kl.kit_id) FROM kit_lines kl WHERE kl.item_id = i.id) AS kit_count
      FROM price_list_items i
     WHERE (${q.includeInactive ?? false} OR i.is_active)
       AND (${like}::text IS NULL OR i.description ILIKE ${like} OR i.code ILIKE ${like} OR i.supplier ILIKE ${like})
     ORDER BY lower(i.description), i.id
     LIMIT 1000`;
  return rows.map((r) => toItemDto(r, markup));
}

async function loadItem(tx: Tx, id: string, lock = false): Promise<ItemRow> {
  const [r] = lock
    ? await tx<
        ItemRow[]
      >`SELECT ${tx.unsafe(ITEM_COLS)}, 0 AS kit_count FROM price_list_items i WHERE i.id = ${id} FOR UPDATE`
    : await tx<ItemRow[]>`
        SELECT ${tx.unsafe(ITEM_COLS)},
               (SELECT count(DISTINCT kl.kit_id) FROM kit_lines kl WHERE kl.item_id = i.id) AS kit_count
          FROM price_list_items i WHERE i.id = ${id}`;
  if (!r) throw notFound('Price list item');
  return r;
}

export async function getItem(tx: Tx, id: string): Promise<PriceItemDetailDto> {
  const markup = await defaultMarkup(tx);
  const row = await loadItem(tx, id);
  const history = await tx<(Omit<PriceHistoryDto, 'createdAt'> & { createdAt: Date })[]>`
    SELECT h.id, h.old_cost_pence, h.new_cost_pence, h.source, h.reference, u.name AS user_name, h.created_at
      FROM price_history h LEFT JOIN users u ON u.id = h.user_id
     WHERE h.item_id = ${id} ORDER BY h.created_at DESC, h.id LIMIT 100`;
  const kits = await tx<{ id: string; name: string }[]>`
    SELECT DISTINCT k.id, k.name FROM kits k JOIN kit_lines kl ON kl.kit_id = k.id
     WHERE kl.item_id = ${id} ORDER BY k.name`;
  return {
    ...toItemDto(row, markup),
    history: history.map((h) => ({
      ...h,
      oldCostPence: h.oldCostPence == null ? null : Number(h.oldCostPence),
      newCostPence: Number(h.newCostPence),
      createdAt: isoNN(h.createdAt),
    })),
    kits: [...kits],
  };
}

function uniqueViolation(e: unknown): boolean {
  return (e as { code?: string }).code === '23505';
}

export async function createItem(
  tx: Tx,
  auth: Auth,
  input: z.output<typeof priceItemInput>,
  source: PriceSource = 'created',
  reference: string | null = null,
): Promise<PriceItemDetailDto> {
  let id: string;
  try {
    [{ id }] = (await tx`
        INSERT INTO price_list_items ${tx({
          tenant_id: auth.tenantId,
          code: input.code,
          description: input.description,
          unit: input.unit,
          supplier: input.supplier,
          unit_cost_pence: input.unitCostPence,
          markup_bp: input.markupBp,
          sell_price_pence: input.sellPricePence,
          is_active: input.isActive,
        })} RETURNING id`) as unknown as [{ id: string }];
  } catch (e) {
    if (uniqueViolation(e))
      throw invalid(`Code "${input.code}" is already on the price list`, {
        fields: { code: 'Already used' },
      });
    throw e;
  }
  await tx`INSERT INTO price_history (tenant_id, item_id, old_cost_pence, new_cost_pence, source, reference, user_id)
           VALUES (${auth.tenantId}, ${id}, NULL, ${input.unitCostPence}, ${source}, ${reference}, ${auth.userId})`;
  await audit(tx, auth, 'create', 'price_list_item', id, { source });
  return getItem(tx, id);
}

/* ------------------------- kit cost recalculation ------------------------ */

type KitCosts = Map<string, { name: string; costPence: number; sellPence: number }>;

/** Current cost and sell of every kit that uses any of these items. */
async function kitCostsFor(tx: Tx, itemIds: string[], markup: number): Promise<KitCosts> {
  if (!itemIds.length) return new Map();
  const rows = await tx<
    {
      kitId: string;
      name: string;
      qtyMilli: string;
      unitCostPence: string;
      markupBp: number | null;
      sellPricePence: string | null;
    }[]
  >`
    SELECT kl.kit_id, k.name, kl.qty_milli, i.unit_cost_pence, i.markup_bp, i.sell_price_pence
      FROM kit_lines kl JOIN kits k ON k.id = kl.kit_id JOIN price_list_items i ON i.id = kl.item_id
     WHERE kl.kit_id IN (SELECT kit_id FROM kit_lines WHERE item_id = ANY(${itemIds}::uuid[]))
     ORDER BY kl.kit_id`;
  const byKit = new Map<string, { name: string; lines: Parameters<typeof kitTotals>[0] }>();
  for (const r of rows) {
    const cost = Number(r.unitCostPence);
    const sell = itemSell(
      {
        unitCostPence: cost,
        markupBp: r.markupBp,
        sellPricePence: r.sellPricePence == null ? null : Number(r.sellPricePence),
      },
      markup,
    );
    const entry = byKit.get(r.kitId) ?? { name: r.name, lines: [] };
    entry.lines.push({ qtyMilli: Number(r.qtyMilli), unitCostPence: cost, unitSellPence: sell });
    byKit.set(r.kitId, entry);
  }
  const out: KitCosts = new Map();
  for (const [kitId, e] of byKit) out.set(kitId, { name: e.name, ...kitTotals(e.lines) });
  return out;
}

/** Writes a kit_cost_changes row for every kit whose cost or sell moved. */
async function recordKitChanges(
  tx: Tx,
  auth: Auth,
  before: KitCosts,
  itemIds: string[],
  markup: number,
  cause: { itemId: string | null; description: string; source: PriceSource },
): Promise<KitChangeSummary[]> {
  const after = await kitCostsFor(tx, itemIds, markup);
  const changes: KitChangeSummary[] = [];
  for (const [kitId, b] of before) {
    const a = after.get(kitId);
    if (!a || (a.costPence === b.costPence && a.sellPence === b.sellPence)) continue;
    changes.push({
      kitId,
      name: a.name,
      oldCostPence: b.costPence,
      newCostPence: a.costPence,
      oldSellPence: b.sellPence,
      newSellPence: a.sellPence,
    });
  }
  if (changes.length) {
    await tx`INSERT INTO kit_cost_changes ${tx(
      changes.map((c) => ({
        tenant_id: auth.tenantId,
        kit_id: c.kitId,
        item_id: cause.itemId,
        item_description: cause.description.slice(0, 300),
        old_cost_pence: c.oldCostPence,
        new_cost_pence: c.newCostPence,
        old_sell_pence: c.oldSellPence,
        new_sell_pence: c.newSellPence,
        source: cause.source,
      })),
    )}`;
  }
  return changes.sort((x, y) => x.name.localeCompare(y.name));
}

interface ItemPatch {
  id: string;
  current: ItemRow;
  next: Partial<PriceItem>;
}

/**
 * The one way prices change: updates items, writes price history for cost changes, then
 * recalculates every kit that uses them and records the kits' old and new cost.
 */
async function applyItemPatches(
  tx: Tx,
  auth: Auth,
  patches: ItemPatch[],
  source: PriceSource,
  reference: string | null,
): Promise<{ changes: PriceChangeDto[]; kits: KitChangeSummary[] }> {
  if (!patches.length) return { changes: [], kits: [] };
  const markup = await defaultMarkup(tx);
  const ids = patches.map((p) => p.id);
  const before = await kitCostsFor(tx, ids, markup);
  const changes: PriceChangeDto[] = [];
  for (const p of patches) {
    const n = p.next;
    const cols: Record<string, unknown> = {};
    if (n.code !== undefined) cols.code = n.code;
    if (n.description !== undefined) cols.description = n.description;
    if (n.unit !== undefined) cols.unit = n.unit;
    if (n.supplier !== undefined) cols.supplier = n.supplier;
    if (n.unitCostPence !== undefined) cols.unit_cost_pence = n.unitCostPence;
    if (n.markupBp !== undefined) cols.markup_bp = n.markupBp;
    if (n.sellPricePence !== undefined) cols.sell_price_pence = n.sellPricePence;
    if (n.isActive !== undefined) cols.is_active = n.isActive;
    if (!Object.keys(cols).length) continue;
    try {
      await tx`UPDATE price_list_items SET ${tx(cols)} WHERE id = ${p.id}`;
    } catch (e) {
      if (uniqueViolation(e))
        throw invalid(`Code "${n.code}" is already on the price list`, {
          fields: { code: 'Already used' },
        });
      throw e;
    }
    const oldCost = Number(p.current.unitCostPence);
    if (n.unitCostPence !== undefined && n.unitCostPence !== oldCost) {
      await tx`INSERT INTO price_history (tenant_id, item_id, old_cost_pence, new_cost_pence, source, reference, user_id)
               VALUES (${auth.tenantId}, ${p.id}, ${oldCost}, ${n.unitCostPence}, ${source}, ${reference}, ${auth.userId})`;
      changes.push({
        itemId: p.id,
        description: n.description ?? p.current.description,
        oldCostPence: oldCost,
        newCostPence: n.unitCostPence,
      });
    }
  }
  const description =
    patches.length === 1
      ? (patches[0]!.next.description ?? patches[0]!.current.description)
      : `${patches.length} items${reference ? ` (${reference})` : ''}`;
  const kits = await recordKitChanges(tx, auth, before, ids, markup, {
    itemId: patches.length === 1 ? patches[0]!.id : null,
    description,
    source,
  });
  return { changes, kits };
}

export async function updateItem(
  tx: Tx,
  auth: Auth,
  id: string,
  input: z.output<typeof priceItemUpdate>,
): Promise<PriceItemDetailDto & { kitChanges: KitChangeSummary[] }> {
  const current = await loadItem(tx, id, true);
  const { kits } = await applyItemPatches(tx, auth, [{ id, current, next: input }], 'manual', null);
  await audit(tx, auth, 'update', 'price_list_item', id, { fields: Object.keys(input) });
  return { ...(await getItem(tx, id)), kitChanges: kits };
}

export async function deleteItem(tx: Tx, auth: Auth, id: string): Promise<void> {
  await loadItem(tx, id, true);
  const [used] = await tx`SELECT 1 FROM kit_lines WHERE item_id = ${id} LIMIT 1`;
  if (used)
    throw conflict(
      'item_in_kit',
      'This item is used in a kit. Remove it from the kit first, or switch it off instead.',
    );
  await tx`DELETE FROM price_list_items WHERE id = ${id}`;
  await audit(tx, auth, 'delete', 'price_list_item', id);
}

/* ---------------------------- supplier bills ----------------------------- */

/** Finds an item by code, else by supplier + description (both keys are indexed). */
export function matcher(items: ItemRow[]) {
  const byCode = new Map<string, ItemRow>();
  const byDesc = new Map<string, ItemRow>();
  for (const i of items) {
    if (i.code) byCode.set(priceItemKey(i), i);
    byDesc.set(priceItemKey({ code: null, supplier: i.supplier, description: i.description }), i);
  }
  return (q: { code: string | null; supplier: string | null; description: string }) =>
    (q.code
      ? byCode.get(priceItemKey({ code: q.code, supplier: null, description: '' }))
      : undefined) ??
    byDesc.get(priceItemKey({ code: null, supplier: q.supplier, description: q.description }));
}

/**
 * Updates price-list costs from a supplier bill (stub: the bill arrives already read).
 * Lines match on code, else on this supplier + description. Unmatched lines are returned,
 * never auto-created. Every change is in the price history with the bill reference, and every
 * affected kit gets a before/after cost record.
 */
export async function applySupplierBillPrices(
  tx: Tx,
  auth: Auth,
  bill: z.output<typeof supplierBillInput>,
): Promise<SupplierBillResultDto> {
  const items = await tx<ItemRow[]>`
    SELECT ${tx.unsafe(ITEM_COLS)}, 0 AS kit_count FROM price_list_items i ORDER BY i.id FOR UPDATE`;
  const find = matcher([...items]);
  const patches = new Map<string, ItemPatch>();
  const unmatched: SupplierBillResultDto['unmatched'] = [];
  let unchanged = 0;
  for (const line of bill.lines) {
    const item = line.itemId
      ? items.find((i) => i.id === line.itemId)
      : find({ code: line.code, supplier: bill.supplier, description: line.description });
    if (!item) {
      unmatched.push({
        code: line.code,
        description: line.description,
        unitCostPence: line.unitCostPence,
      });
      continue;
    }
    if (Number(item.unitCostPence) === line.unitCostPence) {
      unchanged += 1;
      continue;
    }
    patches.set(item.id, {
      id: item.id,
      current: item,
      next: { unitCostPence: line.unitCostPence },
    });
  }
  const { changes, kits } = await applyItemPatches(
    tx,
    auth,
    [...patches.values()],
    'supplier_bill',
    `${bill.supplier} ${bill.reference}`.slice(0, 200),
  );
  await audit(tx, auth, 'supplier_bill_prices', 'price_list', null, {
    supplier: bill.supplier,
    reference: bill.reference,
    updated: changes.length,
    unmatched: unmatched.length,
  });
  return { updated: changes, unchanged, unmatched, kits };
}

/* ------------------------------ CSV import ------------------------------- */

class DryRun extends Error {
  constructor(public readonly result: PriceImportResultDto) {
    super('dry run');
  }
}

/** Imports a price-list CSV. Without `apply` it runs inside a rolled-back savepoint: a preview. */
export async function importCsv(
  tx: Tx,
  auth: Auth,
  csv: string,
  apply: boolean,
): Promise<PriceImportResultDto> {
  const { rows, errors, columns } = priceRowsFromCsv(csv);
  const run = async (t: Tx): Promise<PriceImportResultDto> => {
    const items = await t<ItemRow[]>`
      SELECT ${t.unsafe(ITEM_COLS)}, 0 AS kit_count FROM price_list_items i ORDER BY i.id FOR UPDATE`;
    const find = matcher([...items]);
    const created: PriceItem[] = [];
    const patches: ItemPatch[] = [];
    const rowOf = new Map<string, number>();
    let unchanged = 0;
    for (const { row, item } of rows) {
      const existing = find(item);
      if (!existing) {
        created.push(item);
        continue;
      }
      const next = importChanges(
        {
          ...existing,
          unitCostPence: Number(existing.unitCostPence),
          sellPricePence: existing.sellPricePence == null ? null : Number(existing.sellPricePence),
        },
        item,
        columns,
      );
      if (!Object.keys(next).length) {
        unchanged += 1;
        continue;
      }
      patches.push({ id: existing.id, current: existing, next });
      rowOf.set(existing.id, row);
    }
    for (const item of created) await createItem(t, auth, item, 'csv', 'CSV import');
    const { changes, kits } = await applyItemPatches(t, auth, patches, 'csv', 'CSV import');
    const updatedIds = new Set(patches.map((p) => p.id));
    // Rows whose only change was markup/unit still count as updated, with equal costs.
    const updated = [...updatedIds].map((id) => {
      const c = changes.find((x) => x.itemId === id);
      const p = patches.find((x) => x.id === id)!;
      return {
        row: rowOf.get(id)!,
        itemId: id,
        description: p.next.description ?? p.current.description,
        oldCostPence: c?.oldCostPence ?? Number(p.current.unitCostPence),
        newCostPence: c?.newCostPence ?? Number(p.current.unitCostPence),
      };
    });
    return { applied: apply, created, updated, unchanged, errors, kits };
  };
  if (apply) {
    if (errors.length && !rows.length) throw invalid(errors[0]!.message, { errors });
    const result = await run(tx);
    await audit(tx, auth, 'import_csv', 'price_list', null, {
      created: result.created.length,
      updated: result.updated.length,
      errors: errors.length,
    });
    return result;
  }
  try {
    await tx.savepoint(async (sp) => {
      throw new DryRun(await run(sp as unknown as Tx));
    });
  } catch (e) {
    if (e instanceof DryRun) return e.result;
    throw e;
  }
  throw new Error('unreachable');
}

/* --------------------------------- kits ---------------------------------- */

interface KitRow {
  id: string;
  name: string;
  description: string | null;
}

async function kitLines(tx: Tx, kitIds: string[], markup: number) {
  if (!kitIds.length) return new Map<string, KitLineDto[]>();
  const rows = await tx<
    {
      kitId: string;
      itemId: string;
      code: string | null;
      description: string;
      unit: string;
      qtyMilli: string;
      unitCostPence: string;
      markupBp: number | null;
      sellPricePence: string | null;
      isActive: boolean;
    }[]
  >`
    SELECT kl.kit_id, kl.item_id, i.code, i.description, i.unit, kl.qty_milli, i.unit_cost_pence,
           i.markup_bp, i.sell_price_pence, i.is_active
      FROM kit_lines kl JOIN price_list_items i ON i.id = kl.item_id
     WHERE kl.kit_id = ANY(${kitIds}::uuid[]) ORDER BY kl.kit_id, kl.position`;
  const out = new Map<string, KitLineDto[]>();
  for (const r of rows) {
    const unitCostPence = Number(r.unitCostPence);
    const unitSellPence = itemSell(
      {
        unitCostPence,
        markupBp: r.markupBp,
        sellPricePence: r.sellPricePence == null ? null : Number(r.sellPricePence),
      },
      markup,
    );
    const qtyMilli = Number(r.qtyMilli);
    const t = kitTotals([{ qtyMilli, unitCostPence, unitSellPence }]);
    const list = out.get(r.kitId) ?? [];
    list.push({
      itemId: r.itemId,
      code: r.code,
      description: r.description,
      unit: r.unit,
      qtyMilli,
      unitCostPence,
      unitSellPence,
      lineCostPence: t.costPence,
      lineSellPence: t.sellPence,
      isActive: r.isActive,
    });
    out.set(r.kitId, list);
  }
  return out;
}

async function kitChanges(tx: Tx, kitIds: string[], perKit: number) {
  if (!kitIds.length) return new Map<string, KitCostChangeDto[]>();
  const rows = await tx<
    (Omit<KitCostChangeDto, 'createdAt'> & { kitId: string; createdAt: Date })[]
  >`
    SELECT * FROM (
      SELECT c.kit_id, c.id, c.item_description, c.old_cost_pence, c.new_cost_pence, c.old_sell_pence,
             c.new_sell_pence, c.source, c.created_at,
             row_number() OVER (PARTITION BY c.kit_id ORDER BY c.created_at DESC, c.id) AS rn
        FROM kit_cost_changes c WHERE c.kit_id = ANY(${kitIds}::uuid[])) x
     WHERE rn <= ${perKit} ORDER BY created_at DESC`;
  const out = new Map<string, KitCostChangeDto[]>();
  for (const r of rows) {
    const list = out.get(r.kitId) ?? [];
    list.push({
      id: r.id,
      itemDescription: r.itemDescription,
      oldCostPence: Number(r.oldCostPence),
      newCostPence: Number(r.newCostPence),
      oldSellPence: Number(r.oldSellPence),
      newSellPence: Number(r.newSellPence),
      source: r.source,
      createdAt: isoNN(r.createdAt),
    });
    out.set(r.kitId, list);
  }
  return out;
}

function kitSummary(k: KitRow, lines: KitLineDto[], changes: KitCostChangeDto[]): KitSummaryDto {
  return {
    id: k.id,
    name: k.name,
    description: k.description,
    lineCount: lines.length,
    ...kitTotals(lines),
    lastChange: changes[0] ?? null,
  };
}

export async function listKits(tx: Tx): Promise<KitSummaryDto[]> {
  const markup = await defaultMarkup(tx);
  const kits = await tx<KitRow[]>`SELECT id, name, description FROM kits ORDER BY lower(name)`;
  const ids = kits.map((k) => k.id);
  const [lines, changes] = [await kitLines(tx, ids, markup), await kitChanges(tx, ids, 1)];
  return kits.map((k) => kitSummary(k, lines.get(k.id) ?? [], changes.get(k.id) ?? []));
}

export async function getKit(tx: Tx, id: string): Promise<KitDetailDto> {
  const markup = await defaultMarkup(tx);
  const [k] = await tx<KitRow[]>`SELECT id, name, description FROM kits WHERE id = ${id}`;
  if (!k) throw notFound('Kit');
  const lines = (await kitLines(tx, [id], markup)).get(id) ?? [];
  const changes = (await kitChanges(tx, [id], 50)).get(id) ?? [];
  return { ...kitSummary(k, lines, changes), lines, changes };
}

async function writeKitLines(
  tx: Tx,
  auth: Auth,
  kitId: string,
  lines: { itemId: string; qtyMilli: number }[],
) {
  await tx`DELETE FROM kit_lines WHERE kit_id = ${kitId}`;
  if (!lines.length) return;
  const ids = [...new Set(lines.map((l) => l.itemId))];
  const found = await tx<
    { id: string }[]
  >`SELECT id FROM price_list_items WHERE id = ANY(${ids}::uuid[])`;
  if (found.length !== ids.length)
    throw invalid('A kit line points at an item that is not on the price list');
  await tx`INSERT INTO kit_lines ${tx(
    lines.map((l, i) => ({
      tenant_id: auth.tenantId,
      kit_id: kitId,
      item_id: l.itemId,
      position: i,
      qty_milli: l.qtyMilli,
    })),
  )}`;
}

function kitNameTaken(e: unknown, name: string | undefined) {
  if (uniqueViolation(e))
    return invalid(`There is already a kit called "${name}"`, { fields: { name: 'Already used' } });
  return e;
}

export async function createKit(
  tx: Tx,
  auth: Auth,
  input: z.output<typeof kitInput>,
): Promise<KitDetailDto> {
  let id: string;
  try {
    [{ id }] = (await tx`
      INSERT INTO kits (tenant_id, name, description) VALUES (${auth.tenantId}, ${input.name}, ${input.description})
      RETURNING id`) as unknown as [{ id: string }];
  } catch (e) {
    throw kitNameTaken(e, input.name);
  }
  await writeKitLines(tx, auth, id, input.lines);
  await audit(tx, auth, 'create', 'kit', id);
  return getKit(tx, id);
}

export async function updateKit(
  tx: Tx,
  auth: Auth,
  id: string,
  input: z.output<typeof kitUpdate>,
): Promise<KitDetailDto> {
  const [k] = await tx`SELECT id FROM kits WHERE id = ${id} FOR UPDATE`;
  if (!k) throw notFound('Kit');
  const cols: Record<string, unknown> = {};
  if (input.name !== undefined) cols.name = input.name;
  if (input.description !== undefined) cols.description = input.description;
  if (Object.keys(cols).length) {
    try {
      await tx`UPDATE kits SET ${tx(cols)} WHERE id = ${id}`;
    } catch (e) {
      throw kitNameTaken(e, input.name);
    }
  }
  if (input.lines) {
    // Editing the recipe is not a price change; it's tracked in the audit log, not kit_cost_changes.
    await writeKitLines(tx, auth, id, input.lines);
    await tx`UPDATE kits SET updated_at = now() WHERE id = ${id}`;
  }
  await audit(tx, auth, 'update', 'kit', id, { fields: Object.keys(input) });
  return getKit(tx, id);
}

export async function deleteKit(tx: Tx, auth: Auth, id: string): Promise<void> {
  const r = await tx`DELETE FROM kits WHERE id = ${id} RETURNING id`;
  if (!r.length) throw notFound('Kit');
  // Quotes keep their frozen snapshot, so deleting a kit never changes a quote.
  await audit(tx, auth, 'delete', 'kit', id);
}
