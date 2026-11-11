import { describe, expect, it } from 'vitest';
import { client, clientFor, rawRequest, seedCustomer, type Client } from './api-helpers';
import { addMember, adminSql } from './helpers';

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
// 1x1 PNG
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function job(c: Client) {
  const cust = await seedCustomer(c);
  return (await c.req('POST', '/api/jobs', { customerId: cust.id, title: 'Shed supply' })).body;
}
async function staffClient(c: Client) {
  const email = await addMember(c.tenantId, 'staff');
  const [u] = await adminSql<{ id: string }[]>`SELECT id FROM users WHERE email = ${email}`;
  return { s: await clientFor(email, { tenantId: c.tenantId, userId: u!.id }), id: u!.id };
}

describe('job detail: time by hand', () => {
  it('owner logs for anyone, staff for themselves; overlaps, future and invoiced time are refused', async () => {
    const c = await client();
    const j = await job(c);
    const { s, id: staffId } = await staffClient(c);

    const add = await c.req('POST', `/api/jobs/${j.id}/timesheets`, {
      startedAt: ago(300),
      endedAt: ago(210),
      note: 'Forgot the timer',
    });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    expect(add.body.totalMinutes).toBe(90);
    expect(add.body.timesheets[0]).toMatchObject({ source: 'manual', note: 'Forgot the timer' });

    // Owner for staff.
    const forStaff = await c.req('POST', `/api/jobs/${j.id}/timesheets`, {
      userId: staffId,
      startedAt: ago(300),
      endedAt: ago(240),
    });
    expect(forStaff.status).toBe(201);
    expect(forStaff.body.totalMinutes).toBe(150);

    // Staff cannot log for someone else, or change the owner's time.
    expect(
      (
        await s.req('POST', `/api/jobs/${j.id}/timesheets`, {
          userId: c.userId,
          startedAt: ago(100),
          endedAt: ago(90),
        })
      ).status,
    ).toBe(403);
    const ownerSheet = add.body.timesheets.find((t: { note: string }) => t.note);
    expect((await s.req('DELETE', `/api/timesheets/${ownerSheet.id}`)).status).toBe(403);

    // Overlap with the owner's own entry; end before start; future; longer than 16 h.
    const overlap = await c.req('POST', `/api/jobs/${j.id}/timesheets`, {
      startedAt: ago(250),
      endedAt: ago(200),
    });
    expect(overlap.status).toBe(422);
    expect(overlap.body.error.message).toMatch(/overlaps time already logged on job/);
    expect(
      (
        await c.req('POST', `/api/jobs/${j.id}/timesheets`, {
          startedAt: ago(10),
          endedAt: ago(20),
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await c.req('POST', `/api/jobs/${j.id}/timesheets`, {
          startedAt: ago(10),
          endedAt: ago(-60),
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await c.req('POST', `/api/jobs/${j.id}/timesheets`, {
          startedAt: ago(17 * 60 + 5),
          endedAt: ago(5),
        })
      ).status,
    ).toBe(422);

    // Edit: 90 min -> 60 min.
    const edit = await c.req('PATCH', `/api/timesheets/${ownerSheet.id}`, { endedAt: ago(240) });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    expect(edit.body.totalMinutes).toBe(120);
    const [log] = await adminSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = ${c.tenantId} AND action = 'timesheet_edit'`;
    expect(log!.n).toBe(1);

    // Invoiced time is locked.
    await c.req('PATCH', '/api/settings', {
      bankAccountName: 'Test Electrical',
      bankSortCode: '400000',
      bankAccountNumber: '12345678',
    });
    const inv = await c.req('POST', `/api/jobs/${j.id}/invoices`, { source: 'job' });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    const locked = await c.req('PATCH', `/api/timesheets/${ownerSheet.id}`, { note: 'x' });
    expect(locked.status).toBe(409);
    expect((await c.req('DELETE', `/api/timesheets/${ownerSheet.id}`)).status).toBe(409);
    const detail = (await c.req('GET', `/api/jobs/${j.id}`)).body;
    expect(detail.timesheets.every((t: { invoiced: boolean }) => t.invoiced)).toBe(true);
  });

  it('staff edit and delete their own time; the accountant is read-only', async () => {
    const c = await client();
    const j = await job(c);
    const { s } = await staffClient(c);
    const add = await s.req('POST', `/api/jobs/${j.id}/timesheets`, {
      startedAt: ago(100),
      endedAt: ago(40),
    });
    expect(add.status).toBe(201);
    const id = add.body.timesheets[0].id;
    expect((await s.req('PATCH', `/api/timesheets/${id}`, { note: 'Fitted CU' })).status).toBe(200);
    const del = await s.req('DELETE', `/api/timesheets/${id}`);
    expect(del.status).toBe(200);
    expect(del.body.totalMinutes).toBe(0);

    const acc = await clientFor(await addMember(c.tenantId, 'accountant'), c);
    expect(
      (
        await acc.req('POST', `/api/jobs/${j.id}/timesheets`, {
          startedAt: ago(30),
          endedAt: ago(20),
        })
      ).status,
    ).toBe(403);
    expect((await acc.req('POST', `/api/jobs/${j.id}/notes`, { body: 'Hi' })).status).toBe(403);
  });
});

describe('job detail: materials by hand', () => {
  it('price from cost x markup, explicit price wins, quote and invoiced lines are locked', async () => {
    const c = await client();
    const j = await job(c);
    const a = await c.req('POST', `/api/jobs/${j.id}/lines`, {
      description: '20A RCBO from the counter',
      qtyMilli: 2000,
      unitCostPence: 1000,
    });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const line = a.body.lines.find((l: { description: string }) => l.description.startsWith('20A'));
    // Default markup 130%: £10.00 cost -> £13.00 each, 2 of them.
    expect(line).toMatchObject({ source: 'manual', unitSellPence: 1300, totalPence: 2600 });

    const b = await c.req('POST', `/api/jobs/${j.id}/lines`, {
      description: 'Parking',
      kind: 'carriage',
      unitSellPence: 500,
    });
    expect(b.status).toBe(201);
    expect(
      (await c.req('POST', `/api/jobs/${j.id}/lines`, { description: 'Nothing' })).status,
    ).toBe(422);

    // Changing the cost re-derives the price; changing qty keeps it.
    const e = await c.req('PATCH', `/api/job-lines/${line.id}`, { unitCostPence: 2000 });
    expect(e.body.lines.find((l: { id: string }) => l.id === line.id)).toMatchObject({
      unitSellPence: 2600,
      totalPence: 5200,
    });
    const q = await c.req('PATCH', `/api/job-lines/${line.id}`, { qtyMilli: 1000 });
    expect(q.body.lines.find((l: { id: string }) => l.id === line.id).totalPence).toBe(2600);

    // A supplier-bill line can't be edited here.
    const [bl] = await adminSql<{ id: string }[]>`
      INSERT INTO job_lines (tenant_id, job_id, position, kind, description, qty_milli, unit_cost_pence,
                             unit_sell_pence, total_pence, source)
      VALUES (${c.tenantId}, ${j.id}, 90, 'material', 'From a bill', 1000, 100, 130, 130, 'supplier_bill')
      RETURNING id`;
    expect((await c.req('DELETE', `/api/job-lines/${bl!.id}`)).status).toBe(409);

    const d = await c.req('DELETE', `/api/job-lines/${line.id}`);
    expect(d.status).toBe(200);
    expect(d.body.lines.some((l: { id: string }) => l.id === line.id)).toBe(false);
  });
});

describe('job detail: notes and photos', () => {
  it('notes: add, list newest first, only the author or owner deletes', async () => {
    const c = await client();
    const j = await job(c);
    const { s } = await staffClient(c);
    await c.req('POST', `/api/jobs/${j.id}/notes`, { body: 'Key under the mat' });
    const r = await s.req('POST', `/api/jobs/${j.id}/notes`, { body: 'Isolator is in the shed' });
    expect(r.status).toBe(201);
    expect(r.body.map((n: { body: string }) => n.body)).toEqual([
      'Isolator is in the shed',
      'Key under the mat',
    ]);
    expect((await c.req('POST', `/api/jobs/${j.id}/notes`, { body: '   ' })).status).toBe(422);
    const ownerNote = r.body[1];
    expect((await s.req('DELETE', `/api/notes/${ownerNote.id}`)).status).toBe(403);
    expect((await c.req('DELETE', `/api/notes/${r.body[0].id}`)).status).toBe(200);
  });

  it('photos: stored through the blob store, served same-origin, sniffed, other tenants cannot read', async () => {
    const c = await client();
    const j = await job(c);
    const up = await c.req('POST', `/api/jobs/${j.id}/photos`, {
      dataUrl: `data:image/png;base64,${PNG}`,
      caption: 'Consumer unit before',
      width: 1,
      height: 1,
    });
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    expect(up.body[0]).toMatchObject({ contentType: 'image/png', caption: 'Consumer unit before' });
    const url = up.body[0].url as string;

    const img = await c.session.request('GET', url);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(img.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await img.arrayBuffer())[1]).toBe(0x50);

    // Signed out, and another business: not found.
    expect((await rawRequest(url, { method: 'GET' })).status).toBe(401);
    const other = await client();
    expect((await other.req('GET', url)).status).toBe(404);

    // A JPEG label on PNG bytes, or a non-image.
    expect(
      (
        await c.req('POST', `/api/jobs/${j.id}/photos`, {
          dataUrl: `data:image/jpeg;base64,${PNG}`,
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await c.req('POST', `/api/jobs/${j.id}/photos`, {
          dataUrl: `data:image/png;base64,${btoa('<svg onload=alert(1)>')}`,
        })
      ).status,
    ).toBe(422);

    const del = await c.req('DELETE', `/api/photos/${up.body[0].id}`);
    expect(del.status).toBe(200);
    expect(del.body).toEqual([]);
    expect((await c.session.request('GET', url)).status).toBe(404);
  });
});
