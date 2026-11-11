import { describe, expect, it } from 'vitest';
import { client, clientFor, seedCustomer, type Client } from './api-helpers';
import { addMember } from './helpers';

async function item(c: Client, body: Record<string, unknown>) {
  const r = await c.req('POST', '/api/price-list', body);
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body;
}

/** Cable £1.00/m (default 1.3x) and a socket £3.00 at 1.5x, in a kit (10 m + 1 socket = £13.00). */
async function setup(c: Client) {
  const cable = await item(c, {
    code: 'CAB25',
    description: '2.5mm T&E cable',
    unit: 'm',
    supplier: 'Island Electrical',
    unitCostPence: 100,
  });
  const socket = await item(c, {
    description: 'Double socket',
    supplier: 'Island Electrical',
    unitCostPence: 300,
    markupBp: 15000,
  });
  const kit = (
    await c.req('POST', '/api/kits', {
      name: 'Socket on new radial',
      lines: [
        { itemId: cable.id, qtyMilli: 10000 },
        { itemId: socket.id, qtyMilli: 1000 },
      ],
    })
  ).body;
  const cust = await seedCustomer(c);
  const job = (await c.req('POST', '/api/jobs', { customerId: cust.id, title: 'Kitchen' })).body;
  return { cable, socket, kit, job };
}

const bill = (c: Client, body: Record<string, unknown>) =>
  c.req('POST', '/api/supplier-bills', {
    supplier: 'island electrical',
    reference: 'GUR/1001',
    billDate: '2026-11-10',
    ...body,
  });

describe('supplier bills', () => {
  it('matches lines by code, then supplier and description, and adds the supplier', async () => {
    const c = await client();
    const { cable, socket, job } = await setup(c);
    const r = await bill(c, {
      jobId: job.id,
      lines: [
        { code: 'cab25', description: 'T&E 2.5 100m drum', qtyMilli: 100000, unitCostPence: 112 },
        { description: 'Double socket', qtyMilli: 4000, unitCostPence: 320 },
        { description: 'Cable ties', qtyMilli: 1000, unitCostPence: 250 },
      ],
    });
    expect(r.status).toBe(201);
    const b = r.body;
    // The supplier already existed (from the price list, any case), so no duplicate is made.
    expect(b.supplierName).toBe('Island Electrical');
    expect(b.status).toBe('draft');
    expect(b.totalPence).toBe(11200 + 1280 + 250);
    expect(b.lines.map((l: { item: { id: string } | null }) => l.item?.id ?? null)).toEqual([
      cable.id,
      socket.id,
      null,
    ]);
    expect(b.unmatchedCount).toBe(1);
    // On a job, lines default to the job.
    expect(b.lines.every((l: { allocation: string }) => l.allocation === 'job')).toBe(true);
    const suppliers = (await c.req('GET', '/api/suppliers')).body;
    expect(suppliers.map((s: { name: string }) => s.name)).toEqual(['Island Electrical']);
  });

  it('previews without changing anything, then applies prices, kit costs and job materials', async () => {
    const c = await client();
    const { cable, socket, kit, job } = await setup(c);
    const b = (
      await bill(c, {
        jobId: job.id,
        lines: [
          { code: 'CAB25', description: 'T&E 2.5', qtyMilli: 50000, unitCostPence: 112 },
          { description: 'Double socket', qtyMilli: 2000, unitCostPence: 300 },
          { description: 'Cable ties', qtyMilli: 1000, unitCostPence: 250, allocation: 'stock' },
        ],
      })
    ).body;
    const preview = await c.req('POST', `/api/supplier-bills/${b.id}/apply`, {});
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      applied: false,
      priceChanges: [{ itemId: cable.id, oldCostPence: 100, newCostPence: 112 }],
      unchangedPrices: 1,
      kits: [{ kitId: kit.id, oldCostPence: 1300, newCostPence: 1420 }],
      jobNumber: job.number,
      notOnPriceList: 1,
    });
    // Job materials at cost x markup (cable default 1.3x, socket its own 1.5x); ties went to stock.
    expect(preview.body.jobLines).toEqual([
      {
        description: 'T&E 2.5',
        qtyMilli: 50000,
        unitCostPence: 112,
        unitSellPence: 146,
        totalPence: 7300,
      },
      {
        description: 'Double socket',
        qtyMilli: 2000,
        unitCostPence: 300,
        unitSellPence: 450,
        totalPence: 900,
      },
    ]);
    // Nothing changed yet.
    expect((await c.req('GET', `/api/price-list/${cable.id}`)).body.unitCostPence).toBe(100);
    expect((await c.req('GET', `/api/jobs/${job.id}`)).body.lines).toHaveLength(0);
    expect((await c.req('GET', `/api/supplier-bills/${b.id}`)).body.status).toBe('draft');

    const done = await c.req('POST', `/api/supplier-bills/${b.id}/apply`, { dryRun: false });
    expect(done.status).toBe(200);
    expect(done.body.applied).toBe(true);
    const cab = (await c.req('GET', `/api/price-list/${cable.id}`)).body;
    expect(cab.unitCostPence).toBe(112);
    expect(cab.history.find((h: { source: string }) => h.source === 'supplier_bill')).toMatchObject(
      {
        reference: 'Island Electrical GUR/1001',
        oldCostPence: 100,
        newCostPence: 112,
      },
    );
    expect((await c.req('GET', `/api/price-list/${socket.id}`)).body.history).toHaveLength(1);
    const k = (await c.req('GET', `/api/kits/${kit.id}`)).body;
    expect(k.costPence).toBe(1420);
    const jobLines = (await c.req('GET', `/api/jobs/${job.id}`)).body.lines;
    expect(
      jobLines.map((l: { source: string; totalPence: number }) => [l.source, l.totalPence]),
    ).toEqual([
      ['supplier_bill', 7300],
      ['supplier_bill', 900],
    ]);
    // Now billable on a time-and-materials invoice.
    const invoicing = (await c.req('GET', `/api/jobs/${job.id}/invoicing`)).body;
    expect(invoicing.unbilledMaterialsPence).toBe(8200);
    const applied = (await c.req('GET', `/api/supplier-bills/${b.id}`)).body;
    expect(applied.status).toBe('applied');
    expect(applied.appliedByName).toBeTruthy();
    expect(applied.lines[0].jobLineId).toBeTruthy();
    // Applied bills are locked and can't be applied twice.
    expect((await c.req('PATCH', `/api/supplier-bills/${b.id}`, { notes: 'x' })).status).toBe(409);
    expect(
      (await c.req('POST', `/api/supplier-bills/${b.id}/apply`, { dryRun: false })).status,
    ).toBe(409);
    expect((await c.req('DELETE', `/api/supplier-bills/${b.id}`)).status).toBe(409);
    const s = (await c.req('GET', '/api/suppliers')).body[0];
    expect(s).toMatchObject({ billCount: 1, spendPence: 5600 + 600 + 250, priceItemCount: 2 });
  });

  it('respects a match made by hand and lines that should not update the list', async () => {
    const c = await client();
    const { cable, socket } = await setup(c);
    const b = (
      await bill(c, {
        lines: [
          {
            description: 'Some cable',
            qtyMilli: 1000,
            unitCostPence: 150,
            itemId: cable.id,
            updatePrice: false,
          },
          { description: 'Double socket', qtyMilli: 1000, unitCostPence: 333, itemId: null },
        ],
      })
    ).body;
    expect(b.lines[0].item.id).toBe(cable.id);
    expect(b.lines[1].item).toBeNull();
    // No job: lines default to stock.
    expect(b.lines[0].allocation).toBe('stock');
    const r = (await c.req('POST', `/api/supplier-bills/${b.id}/apply`, { dryRun: false })).body;
    expect(r.priceChanges).toEqual([]);
    expect(r.jobLines).toEqual([]);
    expect((await c.req('GET', `/api/price-list/${cable.id}`)).body.unitCostPence).toBe(100);
    expect((await c.req('GET', `/api/price-list/${socket.id}`)).body.unitCostPence).toBe(300);
  });

  it('edits drafts (re-matching lines), and needs a job before allocating to one', async () => {
    const c = await client();
    const { cable, job } = await setup(c);
    const b = (await bill(c, { lines: [] })).body;
    expect(b.totalPence).toBe(0);
    expect((await c.req('POST', `/api/supplier-bills/${b.id}/apply`, {})).status).toBe(422);
    const line = { code: 'CAB25', description: 'Cable', qtyMilli: 2000, unitCostPence: 99 };
    const noJob = await c.req('PATCH', `/api/supplier-bills/${b.id}`, {
      lines: [{ ...line, allocation: 'job' }],
    });
    expect(noJob.status).toBe(422);
    expect(noJob.body.error.message).toMatch(/job/);
    const u = await c.req(
      'PATCH',
      `/api/supplier-bills/${b.id}`,
      { lines: [line] },
      { 'If-Match': String(b.version) },
    );
    expect(u.status).toBe(200);
    expect(u.body.lines[0].item.id).toBe(cable.id);
    expect(u.body.totalPence).toBe(198);
    // Stale version is refused.
    expect(
      (
        await c.req(
          'PATCH',
          `/api/supplier-bills/${b.id}`,
          { notes: 'x' },
          { 'If-Match': String(b.version) },
        )
      ).status,
    ).toBe(409);
    const withJob = await c.req('PATCH', `/api/supplier-bills/${b.id}`, {
      jobId: job.id,
      lines: [{ ...line, allocation: 'job' }],
    });
    expect(withJob.body.jobNumber).toBe(job.number);
    expect(withJob.body.lines[0].allocation).toBe('job');
    expect((await c.req('POST', `/api/supplier-bills/${b.id}/apply`, {})).status).toBe(200);
    // Taking the job off moves job lines back to stock.
    const off = await c.req('PATCH', `/api/supplier-bills/${b.id}`, { jobId: null });
    expect(off.body.lines[0].allocation).toBe('stock');
    expect((await c.req('DELETE', `/api/supplier-bills/${b.id}`)).status).toBe(204);
  });

  it('credit notes reduce the job and never change list prices', async () => {
    const c = await client();
    const { cable, job } = await setup(c);
    const cn = (
      await bill(c, {
        kind: 'credit_note',
        reference: 'CR/77',
        jobId: job.id,
        lines: [
          { code: 'CAB25', description: 'Returned cable', qtyMilli: 10000, unitCostPence: 80 },
        ],
      })
    ).body;
    const r = (await c.req('POST', `/api/supplier-bills/${cn.id}/apply`, { dryRun: false })).body;
    expect(r.priceChanges).toEqual([]);
    expect(r.jobLines).toEqual([
      {
        description: 'Credit: Returned cable',
        qtyMilli: -10000,
        unitCostPence: 80,
        unitSellPence: 104,
        totalPence: -1040,
      },
    ]);
    expect((await c.req('GET', `/api/price-list/${cable.id}`)).body.unitCostPence).toBe(100);
    const s = (await c.req('GET', '/api/suppliers')).body[0];
    expect(s.spendPence).toBe(-800);
  });

  it('refuses duplicate references, keeps applying to the owner and keeps businesses apart', async () => {
    const c = await client();
    await setup(c);
    const lines = [{ description: 'Ties', qtyMilli: 1000, unitCostPence: 100 }];
    expect((await bill(c, { lines })).status).toBe(201);
    const dup = await bill(c, { reference: 'gur/1001', lines });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('duplicate_bill');
    // A credit note may share a number with a bill.
    expect((await bill(c, { kind: 'credit_note', lines })).status).toBe(201);

    const staff = await clientFor(await addMember(c.tenantId, 'staff'), c);
    const sb = await bill(staff, { reference: 'S-1', lines });
    expect(sb.status).toBe(201);
    expect((await staff.req('POST', `/api/supplier-bills/${sb.body.id}/apply`, {})).status).toBe(
      403,
    );
    expect(
      (await staff.req('PATCH', `/api/suppliers/${sb.body.supplierId}`, { name: 'X' })).status,
    ).toBe(403);

    const other = await client();
    expect((await other.req('GET', `/api/supplier-bills/${sb.body.id}`)).status).toBe(404);
    expect((await other.req('GET', '/api/supplier-bills')).body).toEqual([]);
    expect((await other.req('GET', '/api/suppliers')).body).toEqual([]);
  });

  it('renaming a supplier keeps the price list in step and refuses duplicates', async () => {
    const c = await client();
    const { cable } = await setup(c);
    const s = (
      await c.req('POST', '/api/suppliers', { name: 'Sarnia Supplies', email: 'Sales@Sarnia.test' })
    ).body;
    expect(s.email).toBe('sales@sarnia.test');
    expect((await c.req('POST', '/api/suppliers', { name: 'sarnia supplies' })).status).toBe(422);
    const island = (await c.req('GET', '/api/suppliers')).body.find(
      (x: { name: string }) => x.name === 'Island Electrical',
    );
    // Island Electrical exists because the price list mentioned it once a bill was entered.
    expect(island).toBeUndefined();
    await bill(c, { lines: [] });
    const isl = (await c.req('GET', '/api/suppliers')).body.find(
      (x: { name: string }) => x.name === 'Island Electrical',
    );
    const r = await c.req(
      'PATCH',
      `/api/suppliers/${isl.id}`,
      { name: 'Island Electrical Ltd' },
      {
        'If-Match': String(isl.version),
      },
    );
    expect(r.status).toBe(200);
    expect((await c.req('GET', `/api/price-list/${cable.id}`)).body.supplier).toBe(
      'Island Electrical Ltd',
    );
  });
});
