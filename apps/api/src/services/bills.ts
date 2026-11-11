import {
  billLineTotal,
  billTotal,
  itemSell,
  sellFromCost,
  signedLineTotal,
  type Allocation,
  type BillApplyResultDto,
  type BillDetailDto,
  type BillLineDto,
  type BillSummaryDto,
  type SupplierDto,
  type billCreate,
  type billLineInput,
  type billUpdate,
  type supplierInput,
  type supplierUpdate,
} from '@lse/shared';
import type { z } from 'zod';
import type { Tx } from '../db/client';
import { assertVersion, conflict, invalid, notFound } from '../lib/errors';
import { iso, isoNN, type Auth } from '../lib/types';
import { audit } from './audit';
import { assertOwnerDecision } from './invoices';
import {
  ITEM_COLS,
  applySupplierBillPrices,
  defaultMarkup,
  matcher,
  type ItemRow,
} from './pricelist';

/* -------------------------------- suppliers ------------------------------- */

interface SupplierRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  accountRef: string | null;
  notes: string | null;
  billCount: string;
  spendPence: string;
  priceItemCount: string;
  lastBillDate: string | null;
  version: number;
}

const toSupplier = (r: SupplierRow): SupplierDto => ({
  ...r,
  billCount: Number(r.billCount),
  spendPence: Number(r.spendPence),
  priceItemCount: Number(r.priceItemCount),
});

async function supplierRows(tx: Tx, id?: string) {
  return tx<SupplierRow[]>`
    SELECT s.id, s.name, s.email, s.phone, s.account_ref, s.notes, s.version,
           (SELECT count(*) FROM supplier_bills b WHERE b.supplier_id = s.id) AS bill_count,
           (SELECT coalesce(sum(CASE WHEN b.kind = 'credit_note' THEN -b.total_pence ELSE b.total_pence END), 0)
              FROM supplier_bills b WHERE b.supplier_id = s.id AND b.status = 'applied') AS spend_pence,
           (SELECT count(*) FROM price_list_items i WHERE lower(i.supplier) = lower(s.name)) AS price_item_count,
           (SELECT max(b.bill_date)::text FROM supplier_bills b WHERE b.supplier_id = s.id) AS last_bill_date
      FROM suppliers s
     ${id ? tx`WHERE s.id = ${id}` : tx``}
     ORDER BY lower(s.name)`;
}

export async function listSuppliers(tx: Tx): Promise<SupplierDto[]> {
  return (await supplierRows(tx)).map(toSupplier);
}

export async function getSupplier(tx: Tx, id: string): Promise<SupplierDto> {
  const [r] = await supplierRows(tx, id);
  if (!r) throw notFound('Supplier');
  return toSupplier(r);
}

function duplicateName(e: unknown): never {
  if ((e as { code?: string }).code === '23505')
    throw invalid('There is already a supplier with that name', {
      fields: { name: 'Already on your list' },
    });
  throw e;
}

export async function createSupplier(
  tx: Tx,
  auth: Auth,
  input: z.output<typeof supplierInput>,
): Promise<SupplierDto> {
  const [r] = await tx<{ id: string }[]>`
    INSERT INTO suppliers (tenant_id, name, email, phone, account_ref, notes)
    VALUES (${auth.tenantId}, ${input.name}, ${input.email}, ${input.phone}, ${input.accountRef}, ${input.notes})
    RETURNING id`.catch(duplicateName);
  await audit(tx, auth, 'create', 'supplier', r!.id, { name: input.name });
  return getSupplier(tx, r!.id);
}

export async function updateSupplier(
  tx: Tx,
  auth: Auth,
  id: string,
  input: z.output<typeof supplierUpdate>,
  expectedVersion: number | undefined,
): Promise<SupplierDto> {
  const cur = await getSupplier(tx, id);
  await assertVersion(expectedVersion, cur.version, () => getSupplier(tx, id));
  const next = {
    name: input.name ?? cur.name,
    email: input.email === undefined ? cur.email : input.email,
    phone: input.phone === undefined ? cur.phone : input.phone,
    accountRef: input.accountRef === undefined ? cur.accountRef : input.accountRef,
    notes: input.notes === undefined ? cur.notes : input.notes,
  };
  await tx`
    UPDATE suppliers SET name = ${next.name}, email = ${next.email}, phone = ${next.phone},
           account_ref = ${next.accountRef}, notes = ${next.notes}
     WHERE id = ${id}`.catch(duplicateName);
  // Keep the price list's supplier text in step with a rename.
  if (next.name !== cur.name)
    await tx`UPDATE price_list_items SET supplier = ${next.name} WHERE lower(supplier) = lower(${cur.name})`;
  await audit(tx, auth, 'update', 'supplier', id, input);
  return getSupplier(tx, id);
}

/** Finds a supplier by name (any case) or adds it, so a bill can be entered in one go. */
async function supplierIdFor(
  tx: Tx,
  auth: Auth,
  name: string,
): Promise<{ id: string; name: string }> {
  const [found] = await tx<{ id: string; name: string }[]>`
    SELECT id, name FROM suppliers WHERE lower(name) = lower(${name})`;
  if (found) return found;
  // Use the spelling already on the price list, so "island electrical" joins "Island Electrical".
  const [listed] = await tx<{ supplier: string }[]>`
    SELECT supplier FROM price_list_items WHERE lower(supplier) = lower(${name}) LIMIT 1`;
  const created = await createSupplier(tx, auth, {
    name: listed?.supplier ?? name,
    email: null,
    phone: null,
    accountRef: null,
    notes: null,
  });
  return { id: created.id, name: created.name };
}

/* ---------------------------------- bills --------------------------------- */

interface BillRow {
  id: string;
  supplierId: string;
  supplierName: string;
  kind: BillSummaryDto['kind'];
  reference: string;
  billDate: string;
  dueDate: string | null;
  jobId: string | null;
  jobNumber: string | null;
  jobTitle: string | null;
  status: BillSummaryDto['status'];
  source: BillSummaryDto['source'];
  totalPence: string;
  lineCount: string;
  unmatchedCount: string;
  createdAt: Date;
  version: number;
  fileName: string | null;
  notes: string | null;
  appliedByName: string | null;
  appliedAt: Date | null;
}

const BILL_SELECT = (tx: Tx) => tx`
  SELECT b.id, b.supplier_id, s.name AS supplier_name, b.kind, b.reference, b.bill_date::text AS bill_date, b.due_date::text AS due_date,
         b.job_id, j.number AS job_number, j.title AS job_title, b.status, b.source, b.total_pence,
         b.created_at, b.version, b.file_name, b.notes, u.name AS applied_by_name, b.applied_at,
         (SELECT count(*) FROM supplier_bill_lines l WHERE l.bill_id = b.id) AS line_count,
         (SELECT count(*) FROM supplier_bill_lines l WHERE l.bill_id = b.id AND l.price_item_id IS NULL) AS unmatched_count
    FROM supplier_bills b
    JOIN suppliers s ON s.id = b.supplier_id
    LEFT JOIN jobs j ON j.id = b.job_id
    LEFT JOIN users u ON u.id = b.applied_by`;

const toSummary = (r: BillRow): BillSummaryDto => ({
  id: r.id,
  supplierId: r.supplierId,
  supplierName: r.supplierName,
  kind: r.kind,
  reference: r.reference,
  billDate: r.billDate,
  dueDate: r.dueDate,
  jobId: r.jobId,
  jobNumber: r.jobNumber,
  jobTitle: r.jobTitle,
  status: r.status,
  source: r.source,
  totalPence: Number(r.totalPence),
  lineCount: Number(r.lineCount),
  unmatchedCount: Number(r.unmatchedCount),
  createdAt: isoNN(r.createdAt),
  version: r.version,
});

export async function listBills(
  tx: Tx,
  q: { status?: 'draft' | 'applied'; supplierId?: string; jobId?: string },
): Promise<BillSummaryDto[]> {
  const rows = await tx<BillRow[]>`
    ${BILL_SELECT(tx)}
     WHERE true
       ${q.status ? tx`AND b.status = ${q.status}` : tx``}
       ${q.supplierId ? tx`AND b.supplier_id = ${q.supplierId}` : tx``}
       ${q.jobId ? tx`AND b.job_id = ${q.jobId}` : tx``}
     ORDER BY (b.status = 'draft') DESC, b.bill_date DESC, b.created_at DESC
     LIMIT 500`;
  return rows.map(toSummary);
}

export async function getBill(tx: Tx, id: string): Promise<BillDetailDto> {
  const [r] = await tx<BillRow[]>`${BILL_SELECT(tx)} WHERE b.id = ${id}`;
  if (!r) throw notFound('Bill');
  const lines = await tx<
    {
      id: string;
      position: number;
      code: string | null;
      description: string;
      qtyMilli: string;
      unitCostPence: string;
      totalPence: string;
      updatePrice: boolean;
      allocation: Allocation;
      jobLineId: string | null;
      itemId: string | null;
      itemCode: string | null;
      itemDescription: string | null;
      itemCost: string | null;
      itemUnit: string | null;
    }[]
  >`
    SELECT l.id, l.position, l.code, l.description, l.qty_milli, l.unit_cost_pence, l.total_pence,
           l.update_price, l.allocation, l.job_line_id, i.id AS item_id, i.code AS item_code,
           i.description AS item_description, i.unit_cost_pence AS item_cost, i.unit AS item_unit
      FROM supplier_bill_lines l LEFT JOIN price_list_items i ON i.id = l.price_item_id
     WHERE l.bill_id = ${id} ORDER BY l.position`;
  return {
    ...toSummary(r),
    fileName: r.fileName,
    notes: r.notes,
    appliedByName: r.appliedByName,
    appliedAt: iso(r.appliedAt),
    lines: lines.map((l): BillLineDto => ({
      id: l.id,
      position: l.position,
      code: l.code,
      description: l.description,
      qtyMilli: Number(l.qtyMilli),
      unitCostPence: Number(l.unitCostPence),
      totalPence: Number(l.totalPence),
      updatePrice: l.updatePrice,
      allocation: l.allocation,
      jobLineId: l.jobLineId,
      item: l.itemId
        ? {
            id: l.itemId,
            code: l.itemCode,
            description: l.itemDescription!,
            unitCostPence: Number(l.itemCost),
            unit: l.itemUnit!,
          }
        : null,
    })),
  };
}

async function checkJob(tx: Tx, jobId: string | null) {
  if (!jobId) return;
  const [j] = await tx`SELECT 1 FROM jobs WHERE id = ${jobId}`;
  if (!j) throw invalid('That job was not found', { fields: { jobId: 'Job not found' } });
}

/** Writes the lines, matching any line that wasn't matched by hand. */
async function writeLines(
  tx: Tx,
  auth: Auth,
  billId: string,
  supplierName: string,
  hasJob: boolean,
  lines: z.output<typeof billLineInput>[],
): Promise<number> {
  await tx`DELETE FROM supplier_bill_lines WHERE bill_id = ${billId}`;
  if (!lines.length) return 0;
  const items = await tx<
    ItemRow[]
  >`SELECT ${tx.unsafe(ITEM_COLS)}, 0 AS kit_count FROM price_list_items i`;
  const find = matcher([...items]);
  const ids = new Set(items.map((i) => i.id));
  const rows = lines.map((l, position) => {
    let itemId: string | null;
    if (l.itemId === undefined)
      itemId =
        find({ code: l.code, supplier: supplierName, description: l.description })?.id ?? null;
    else if (l.itemId === null) itemId = null;
    else if (ids.has(l.itemId)) itemId = l.itemId;
    else
      throw invalid('That price-list item was not found', {
        fields: { [`lines.${position}.itemId`]: 'Not found' },
      });
    if (l.allocation === 'job' && !hasJob)
      throw invalid('Pick the job first, then put lines on it', {
        fields: { [`lines.${position}.allocation`]: 'This bill has no job' },
      });
    return {
      tenant_id: auth.tenantId,
      bill_id: billId,
      position,
      code: l.code,
      description: l.description,
      qty_milli: l.qtyMilli,
      unit_cost_pence: l.unitCostPence,
      total_pence: billLineTotal(l),
      price_item_id: itemId,
      update_price: l.updatePrice,
      allocation: l.allocation ?? (hasJob ? 'job' : 'stock'),
    };
  });
  await tx`INSERT INTO supplier_bill_lines ${tx(rows)}`;
  return billTotal(lines);
}

function duplicateRef(e: unknown): never {
  if ((e as { code?: string }).code === '23505')
    throw conflict('duplicate_bill', 'This supplier reference has already been entered.', {
      fields: { reference: 'Already entered for this supplier' },
    });
  throw e;
}

export async function createBill(
  tx: Tx,
  auth: Auth,
  input: z.output<typeof billCreate>,
): Promise<BillDetailDto> {
  await checkJob(tx, input.jobId);
  const supplier = await supplierIdFor(tx, auth, input.supplier);
  const [b] = await tx<{ id: string }[]>`
    INSERT INTO supplier_bills (tenant_id, supplier_id, kind, reference, bill_date, due_date, job_id, source, file_name, notes, created_by, total_pence)
    VALUES (${auth.tenantId}, ${supplier.id}, ${input.kind}, ${input.reference}, ${input.billDate}, ${input.dueDate}, ${input.jobId},
            ${input.source}, ${input.fileName}, ${input.notes}, ${auth.userId}, ${billTotal(input.lines)})
    RETURNING id`.catch(duplicateRef);
  await writeLines(tx, auth, b!.id, supplier.name, !!input.jobId, input.lines);
  await audit(tx, auth, 'create', 'supplier_bill', b!.id, {
    supplier: supplier.name,
    reference: input.reference,
    kind: input.kind,
    lines: input.lines.length,
  });
  return getBill(tx, b!.id);
}

async function lockDraft(tx: Tx, id: string, expectedVersion?: number) {
  const [cur] = await tx<
    { status: string; version: number; supplierName: string; jobId: string | null }[]
  >`
    SELECT b.status, b.version, s.name AS supplier_name, b.job_id
      FROM supplier_bills b JOIN suppliers s ON s.id = b.supplier_id
     WHERE b.id = ${id} FOR UPDATE OF b`;
  if (!cur) throw notFound('Bill');
  await assertVersion(expectedVersion, cur.version, () => getBill(tx, id));
  if (cur.status !== 'draft')
    throw conflict('bill_applied', 'This bill has been applied, so it can no longer be changed.');
  return cur;
}

export async function updateBill(
  tx: Tx,
  auth: Auth,
  id: string,
  input: z.output<typeof billUpdate>,
  expectedVersion: number | undefined,
): Promise<BillDetailDto> {
  const cur = await lockDraft(tx, id, expectedVersion);
  const jobId = input.jobId === undefined ? cur.jobId : input.jobId;
  await checkJob(tx, jobId);
  await tx`
    UPDATE supplier_bills SET
      reference = coalesce(${input.reference ?? null}, reference),
      bill_date = coalesce(${input.billDate ?? null}::date, bill_date),
      due_date = ${input.dueDate === undefined ? tx`due_date` : input.dueDate},
      job_id = ${jobId},
      notes = ${input.notes === undefined ? tx`notes` : input.notes}
     WHERE id = ${id}`.catch(duplicateRef);
  if (input.lines) {
    const total = await writeLines(tx, auth, id, cur.supplierName, !!jobId, input.lines);
    await tx`UPDATE supplier_bills SET total_pence = ${total} WHERE id = ${id}`;
  }
  // A bill no longer on a job can't allocate lines to one.
  if (!jobId)
    await tx`UPDATE supplier_bill_lines SET allocation = 'stock' WHERE bill_id = ${id} AND allocation = 'job'`;
  await audit(tx, auth, 'update', 'supplier_bill', id, { lines: input.lines?.length });
  return getBill(tx, id);
}

export async function deleteBill(tx: Tx, auth: Auth, id: string): Promise<void> {
  await lockDraft(tx, id);
  await tx`DELETE FROM supplier_bills WHERE id = ${id}`;
  await audit(tx, auth, 'delete', 'supplier_bill', id, {});
}

class DryRun extends Error {
  constructor(public readonly result: BillApplyResultDto) {
    super('dry run');
  }
}

/**
 * Applies a draft bill: an owner's explicit decision, always previewed first (dryRun runs the
 * same code inside a savepoint that is rolled back). Bills update list costs through the
 * supplier-bill price service; credit notes never change list prices. Lines allocated to the job
 * become job material lines (negative for a credit note) at cost x markup.
 */
export async function applyBill(
  tx: Tx,
  auth: Auth,
  id: string,
  dryRun: boolean,
): Promise<BillApplyResultDto> {
  assertOwnerDecision(auth, 'apply a supplier bill');
  const run = async (t: Tx): Promise<BillApplyResultDto> => {
    await lockDraft(t, id);
    const bill = await getBill(t, id);
    if (!bill.lines.length) throw invalid('Add the bill lines first');
    const credit = bill.kind === 'credit_note';
    const priceLines = credit ? [] : bill.lines.filter((l) => l.item && l.updatePrice);
    const prices = priceLines.length
      ? await applySupplierBillPrices(t, auth, {
          supplier: bill.supplierName,
          reference: bill.reference,
          lines: priceLines.map((l) => ({
            code: l.code,
            description: l.description,
            unitCostPence: l.unitCostPence,
            itemId: l.item!.id,
          })),
        })
      : { updated: [], unchanged: 0, unmatched: [], kits: [] };

    const jobLines: BillApplyResultDto['jobLines'] = [];
    const forJob = bill.lines.filter((l) => l.allocation === 'job');
    if (forJob.length) {
      if (!bill.jobId) throw invalid('Pick the job these materials are for');
      const markup = await defaultMarkup(t);
      const itemIds = forJob.map((l) => l.item?.id).filter(Boolean) as string[];
      const markups = new Map(
        (
          await t<{ id: string; markupBp: number | null }[]>`
            SELECT id, markup_bp FROM price_list_items WHERE id = ANY(${itemIds}::uuid[])`
        ).map((r) => [r.id, r.markupBp]),
      );
      const [pos] = await t<{ next: number }[]>`
        SELECT coalesce(max(position) + 1, 0)::int AS next FROM job_lines WHERE job_id = ${bill.jobId}`;
      let position = pos!.next;
      for (const l of forJob) {
        // Sell follows the item's own markup (the list's sell override is for quoting, not costs).
        const sell = l.item
          ? itemSell(
              {
                unitCostPence: l.unitCostPence,
                markupBp: markups.get(l.item.id) ?? null,
                sellPricePence: null,
              },
              markup,
            )
          : sellFromCost(l.unitCostPence, markup);
        const qty = credit ? -l.qtyMilli : l.qtyMilli;
        const total = signedLineTotal(qty, sell);
        const description = credit ? `Credit: ${l.description}` : l.description;
        const [jl] = await t<{ id: string }[]>`
          INSERT INTO job_lines (tenant_id, job_id, position, kind, description, qty_milli, unit_cost_pence,
                                 unit_sell_pence, total_pence, source, bill_line_id)
          VALUES (${auth.tenantId}, ${bill.jobId}, ${position++}, 'material', ${description}, ${qty},
                  ${l.unitCostPence}, ${sell}, ${total}, 'supplier_bill', ${l.id})
          RETURNING id`;
        await t`UPDATE supplier_bill_lines SET job_line_id = ${jl!.id} WHERE id = ${l.id}`;
        jobLines.push({
          description,
          qtyMilli: qty,
          unitCostPence: l.unitCostPence,
          unitSellPence: sell,
          totalPence: total,
        });
      }
    }
    await t`UPDATE supplier_bills SET status = 'applied', applied_by = ${auth.userId}, applied_at = now() WHERE id = ${id}`;
    await audit(t, auth, 'apply', 'supplier_bill', id, {
      prices: prices.updated.length,
      kits: prices.kits.length,
      jobLines: jobLines.length,
    });
    return {
      applied: true,
      priceChanges: prices.updated,
      unchangedPrices: prices.unchanged,
      kits: prices.kits,
      jobLines,
      jobNumber: bill.jobNumber,
      notOnPriceList: bill.lines.filter((l) => !l.item).length,
    };
  };
  if (!dryRun) return run(tx);
  try {
    await tx.savepoint(async (sp) => {
      throw new DryRun(await run(sp as unknown as Tx));
    });
  } catch (e) {
    if (e instanceof DryRun) return { ...e.result, applied: false };
    throw e;
  }
  throw new Error('unreachable');
}
