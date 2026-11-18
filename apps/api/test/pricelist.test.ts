import { describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/client';
import { applySupplierBillPrices } from '../src/services/pricelist';
import { client, clientFor, seedCustomer, type Client } from './api-helpers';
import { addMember, appSql } from './helpers';

async function item(c: Client, body: Record<string, unknown>) {
  const r = await c.req('POST', '/api/price-list', body);
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body;
}

/** Cable 2.5mm £1.00/m (default 1.3x), socket £3.00 at 1.5x, back box £0.50 sold at £1.25. */
async function stock(c: Client) {
  const cable = await item(c, {
    code: 'CAB25',
    description: '2.5mm T&E cable',
    unit: 'm',
    supplier: 'Island Electrical',
    unitCostPence: 100,
  });
  const socket = await item(c, {
    code: 'SKT2',
    description: 'Double socket',
    supplier: 'Island Electrical',
    unitCostPence: 300,
    markupBp: 15000,
  });
  const box = await item(c, {
    description: 'Back box 35mm',
    supplier: 'Sarnia Supplies',
    unitCostPence: 50,
    sellPricePence: 125,
  });
  const kit = (
    await c.req('POST', '/api/kits', {
      name: 'Double socket, new circuit',
      lines: [
        { itemId: cable.id, qtyMilli: 10000 },
        { itemId: socket.id, qtyMilli: 1000 },
        { itemId: box.id, qtyMilli: 1000 },
      ],
    })
  ).body;
  return { cable, socket, box, kit };
}

describe('price list', () => {
  it('computes sell from cost and markup (rounded up), override wins, and keeps history', async () => {
    const c = await client();
    const { cable, socket, box } = await stock(c);
    expect(cable.unitSellPence).toBe(130);
    expect(socket.unitSellPence).toBe(450);
    expect(box.unitSellPence).toBe(125);
    expect(cable.history).toHaveLength(1);
    expect(cable.history[0]).toMatchObject({
      oldCostPence: null,
      newCostPence: 100,
      source: 'created',
    });

    const r = await c.req('PATCH', `/api/price-list/${cable.id}`, { unitCostPence: 112 });
    expect(r.status).toBe(200);
    expect(r.body.unitSellPence).toBe(146); // 145.6 -> 146
    expect(r.body.history[0]).toMatchObject({
      oldCostPence: 100,
      newCostPence: 112,
      source: 'manual',
      userName: 'Test Owner',
    });
    expect(r.body.kits).toHaveLength(1);
    expect(r.body.kitChanges).toEqual([
      expect.objectContaining({
        oldCostPence: 1350,
        newCostPence: 1470,
        oldSellPence: 1875,
        newSellPence: 2035,
      }),
    ]);
  });

  it('searches, refuses duplicate codes, and protects items used in kits', async () => {
    const c = await client();
    const { cable, box } = await stock(c);
    const s = await c.req('GET', '/api/price-list?q=sarnia');
    expect(s.body.map((i: { id: string }) => i.id)).toEqual([box.id]);
    const dup = await c.req('POST', '/api/price-list', {
      code: 'cab25',
      description: 'x',
      unitCostPence: 1,
    });
    expect(dup.status).toBe(422);
    expect(dup.body.error.details.fields.code).toBeTruthy();
    expect((await c.req('DELETE', `/api/price-list/${cable.id}`)).status).toBe(409);
    // Switching off instead hides it from the list but keeps it in kits.
    await c.req('PATCH', `/api/price-list/${cable.id}`, { isActive: false });
    expect((await c.req('GET', '/api/price-list')).body).toHaveLength(2);
    expect((await c.req('GET', '/api/price-list?inactive=true')).body).toHaveLength(3);
  });

  it('only the owner changes prices; staff can look', async () => {
    const c = await client();
    const staff = await clientFor(await addMember(c.tenantId, 'staff'), c);
    expect((await staff.req('GET', '/api/price-list')).status).toBe(200);
    expect(
      (await staff.req('POST', '/api/price-list', { description: 'x', unitCostPence: 1 })).status,
    ).toBe(403);
    expect((await staff.req('POST', '/api/kits', { name: 'x' })).status).toBe(403);
  });

  it('keeps tenants apart', async () => {
    const a = await client();
    const b = await client();
    const { cable } = await stock(a);
    expect((await b.req('GET', `/api/price-list/${cable.id}`)).status).toBe(404);
    expect((await b.req('GET', '/api/kits')).body).toEqual([]);
  });
});

describe('partial updates', () => {
  it('a cost-only edit keeps code, supplier, unit and markup', async () => {
    const c = await client();
    const { socket } = await stock(c);
    const r = await c.req('PATCH', `/api/price-list/${socket.id}`, { unitCostPence: 345 });
    expect(r.body).toMatchObject({
      code: 'SKT2',
      supplier: 'Island Electrical',
      unit: 'each',
      markupBp: 15000,
      unitCostPence: 345,
    });
  });
  it('a CSV without Markup/Unit/Sell columns leaves those alone', async () => {
    const c = await client();
    const { socket, box } = await stock(c);
    await c.req('POST', '/api/price-list/import', {
      apply: true,
      csv: 'Code,Description,Cost\nSKT2,Double socket,3.45\n',
    });
    expect((await c.req('GET', `/api/price-list/${socket.id}`)).body).toMatchObject({
      markupBp: 15000,
      unitCostPence: 345,
      supplier: 'Island Electrical',
    });
    // Matched on supplier + description; sell override kept.
    await c.req('POST', '/api/price-list/import', {
      apply: true,
      csv: 'Supplier,Description,Cost\nSarnia Supplies,Back box 35mm,0.60\n',
    });
    expect((await c.req('GET', `/api/price-list/${box.id}`)).body).toMatchObject({
      unitCostPence: 60,
      sellPricePence: 125,
    });
  });
});

describe('CSV import', () => {
  const csv = [
    'Code,Description,Unit,Supplier,Cost,Markup,Sell',
    'CAB25,2.5mm T&E cable,m,Island Electrical,1.20,,', // update: 100 -> 120
    'SKT2,Double socket,each,Island Electrical,3.00,50%,', // unchanged
    'RCBO32,RCBO 32A Type A,each,Island Electrical,18.50,,', // new
    'BAD,Broken,each,,not money,,',
  ].join('\n');

  it('previews without writing, then applies; kits recalculate', async () => {
    const c = await client();
    const { cable, kit } = await stock(c);
    const preview = await c.req('POST', '/api/price-list/import', { csv });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ applied: false, unchanged: 1 });
    expect(preview.body.created.map((i: { code: string }) => i.code)).toEqual(['RCBO32']);
    expect(preview.body.updated).toEqual([
      expect.objectContaining({ row: 2, itemId: cable.id, oldCostPence: 100, newCostPence: 120 }),
    ]);
    expect(preview.body.errors).toEqual([{ row: 5, message: expect.stringMatching(/Cost/) }]);
    expect(preview.body.kits).toEqual([
      expect.objectContaining({ kitId: kit.id, oldCostPence: 1350, newCostPence: 1550 }),
    ]);
    // Nothing written by the preview.
    expect((await c.req('GET', `/api/price-list/${cable.id}`)).body.unitCostPence).toBe(100);
    expect((await c.req('GET', '/api/price-list')).body).toHaveLength(3);
    expect((await c.req('GET', `/api/kits/${kit.id}`)).body.changes).toEqual([]);

    const done = await c.req('POST', '/api/price-list/import', { csv, apply: true });
    expect(done.body.applied).toBe(true);
    const after = (await c.req('GET', `/api/price-list/${cable.id}`)).body;
    expect(after.unitCostPence).toBe(120);
    expect(after.history[0]).toMatchObject({ source: 'csv', oldCostPence: 100, newCostPence: 120 });
    expect((await c.req('GET', '/api/price-list')).body).toHaveLength(4);
    const k = (await c.req('GET', `/api/kits/${kit.id}`)).body;
    expect(k.costPence).toBe(1550);
    expect(k.changes[0]).toMatchObject({ oldCostPence: 1350, newCostPence: 1550, source: 'csv' });
    // Importing the same file again changes nothing.
    const again = await c.req('POST', '/api/price-list/import', { csv, apply: true });
    expect(again.body).toMatchObject({ created: [], updated: [], unchanged: 3 });
  });

  it('rejects a file with no usable columns', async () => {
    const c = await client();
    const r = await c.req('POST', '/api/price-list/import', { csv: 'foo,bar\n1,2', apply: true });
    expect(r.status).toBe(422);
  });
});

describe('kits', () => {
  it('costs a kit from its lines and lists the last change', async () => {
    const c = await client();
    const { kit, socket } = await stock(c);
    // cost: 10m x 100 + 300 + 50 = 1350; sell: 1300 + 450 + 125 = 1875
    expect(kit).toMatchObject({ lineCount: 3, costPence: 1350, sellPence: 1875, changes: [] });
    await c.req('PATCH', `/api/price-list/${socket.id}`, { unitCostPence: 350 });
    const list = (await c.req('GET', '/api/kits')).body;
    expect(list[0].lastChange).toMatchObject({
      itemDescription: 'Double socket',
      oldCostPence: 1350,
      newCostPence: 1400,
      oldSellPence: 1875,
      newSellPence: 1950,
    });
  });

  it('replaces lines, refuses unknown items and duplicate names', async () => {
    const c = await client();
    const { kit, box } = await stock(c);
    const r = await c.req('PATCH', `/api/kits/${kit.id}`, {
      lines: [{ itemId: box.id, qtyMilli: 2000 }],
    });
    expect(r.body).toMatchObject({ costPence: 100, sellPence: 250, lineCount: 1, changes: [] });
    const bad = await c.req('PATCH', `/api/kits/${kit.id}`, {
      lines: [{ itemId: '00000000-0000-4000-8000-000000000000', qtyMilli: 1000 }],
    });
    expect(bad.status).toBe(422);
    expect((await c.req('POST', '/api/kits', { name: 'DOUBLE SOCKET, NEW CIRCUIT' })).status).toBe(
      422,
    );
    expect((await c.req('DELETE', `/api/kits/${kit.id}`)).status).toBe(204);
  });

  it('keeps fitting time per kit and per item; a name-only edit leaves it alone', async () => {
    const c = await client();
    const { kit, cable, socket } = await stock(c);
    expect(kit).toMatchObject({ kitLabourMinutes: 0, labourMinutes: 0 });
    const r = await c.req('PATCH', `/api/kits/${kit.id}`, {
      labourMinutes: 30,
      lines: [
        { itemId: cable.id, qtyMilli: 10000, labourMinutes: 2 },
        { itemId: socket.id, qtyMilli: 2000, labourMinutes: 15 },
      ],
    });
    // 30 + 10 m x 2 + 2 x 15 = 80 minutes per kit
    expect(r.body).toMatchObject({ kitLabourMinutes: 30, labourMinutes: 80 });
    expect(r.body.lines[1]).toMatchObject({ labourMinutes: 15 });
    const renamed = await c.req('PATCH', `/api/kits/${kit.id}`, { name: 'Socket circuit' });
    expect(renamed.body).toMatchObject({ kitLabourMinutes: 30, labourMinutes: 80 });
    expect((await c.req('PATCH', `/api/kits/${kit.id}`, { labourMinutes: -1 })).status).toBe(422);
  });

  it('a kit block on a quote is frozen once sent; a draft can take the new cost', async () => {
    const c = await client();
    const { kit, cable } = await stock(c);
    const snapshot = {
      kitId: kit.id,
      name: kit.name,
      costPence: kit.costPence,
      sellPence: kit.sellPence,
      components: kit.lines.map((l: Record<string, unknown>) => ({
        itemId: l.itemId,
        code: l.code,
        description: l.description,
        unit: l.unit,
        qtyMilli: l.qtyMilli,
        unitCostPence: l.unitCostPence,
        unitSellPence: l.unitSellPence,
      })),
    };
    const cust = await seedCustomer(c);
    const kitLine = {
      kind: 'material',
      description: kit.name,
      qtyMilli: 2000,
      unitCostPence: kit.costPence,
      unitPricePence: kit.sellPence,
      kit: snapshot,
    };
    const q = (
      await c.req('POST', '/api/quotes', {
        customerId: cust.id,
        title: 'Kitchen sockets',
        lines: [kitLine],
      })
    ).body;
    expect(q.current.lines[0].kit).toMatchObject({ kitId: kit.id, costPence: 1350 });
    expect(q.current.totals.corePence).toBe(3750);

    await c.req('PATCH', `/api/price-list/${cable.id}`, { unitCostPence: 150 });
    const newKit = (await c.req('GET', `/api/kits/${kit.id}`)).body;
    expect(newKit.costPence).toBe(1850);

    // Draft: still the old block until updated; updating takes the new cost.
    const draft = (await c.req('GET', `/api/quotes/${q.id}`)).body;
    expect(draft.current.lines[0].kit.costPence).toBe(1350);
    const upd = await c.req('PATCH', `/api/quotes/${q.id}`, {
      lines: [
        {
          ...kitLine,
          unitCostPence: newKit.costPence,
          unitPricePence: newKit.sellPence,
          kit: { ...snapshot, costPence: 1850, sellPence: newKit.sellPence },
        },
      ],
    });
    expect(upd.status).toBe(200);
    expect(upd.body.current.lines[0].kit.costPence).toBe(1850);

    // Sent: frozen.
    expect((await c.req('POST', `/api/quotes/${q.id}/send`)).status).toBe(200);
    await c.req('PATCH', `/api/price-list/${cable.id}`, { unitCostPence: 300 });
    const sent = (await c.req('GET', `/api/quotes/${q.id}`)).body;
    expect(sent.current.lines[0].kit.costPence).toBe(1850);
    expect((await c.req('PATCH', `/api/quotes/${q.id}`, { lines: [kitLine] })).status).toBe(409);
  });
});

describe('supplier bill prices (service stub)', () => {
  it('updates matched items, records history with the bill, recalculates kits, reports unmatched', async () => {
    const c = await client();
    const { cable, socket, box, kit } = await stock(c);
    const result = await withTenant(appSql, c, (tx) =>
      applySupplierBillPrices(
        tx,
        { ...c, role: 'owner' },
        {
          supplier: 'Island Electrical',
          reference: 'INV-88812',
          lines: [
            { code: 'cab25', description: 'Cable 2.5 T&E 100m', unitCostPence: 105 }, // by code
            { code: null, description: 'double socket', unitCostPence: 300 }, // by description, unchanged
            { code: null, description: 'Fused spur', unitCostPence: 420 }, // unknown
          ],
        },
      ),
    );
    expect(result.updated).toEqual([
      { itemId: cable.id, description: '2.5mm T&E cable', oldCostPence: 100, newCostPence: 105 },
    ]);
    expect(result.unchanged).toBe(1);
    expect(result.unmatched).toEqual([
      { code: null, description: 'Fused spur', unitCostPence: 420 },
    ]);
    expect(result.kits).toEqual([
      expect.objectContaining({
        kitId: kit.id,
        oldCostPence: 1350,
        newCostPence: 1400,
        oldSellPence: 1875,
        newSellPence: 1945,
      }),
    ]);
    const hist = (await c.req('GET', `/api/price-list/${cable.id}`)).body.history[0];
    expect(hist).toMatchObject({
      source: 'supplier_bill',
      reference: 'Island Electrical INV-88812',
    });
    // The box is from another supplier: never matched by description across suppliers.
    expect((await c.req('GET', `/api/price-list/${box.id}`)).body.history).toHaveLength(1);
    expect((await c.req('GET', `/api/price-list/${socket.id}`)).body.history).toHaveLength(1);
    expect((await c.req('GET', `/api/kits/${kit.id}`)).body.changes[0].source).toBe(
      'supplier_bill',
    );
  });
});
