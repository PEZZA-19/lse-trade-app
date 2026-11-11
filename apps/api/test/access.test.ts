import { ACCESS_AREAS, type AccessArea } from '@lse/shared';
import { describe, expect, it } from 'vitest';
import { client, clientFor, type Client } from './api-helpers';
import { addMember, adminSql } from './helpers';

const today = new Date().toISOString().slice(0, 10);
/** One read in each area. */
const PROBE: Record<AccessArea, string> = {
  financials: '/api/invoices',
  reports: `/api/reports?from=${today.slice(0, 8)}01&to=${today}`,
  costs: '/api/team',
  quotes: '/api/quotes',
  settings: '/api/settings',
};

async function member(c: Client, role: 'staff' | 'subcontractor' | 'accountant') {
  const email = await addMember(c.tenantId, role);
  const [u] = await adminSql<{ id: string }[]>`SELECT id FROM users WHERE email = ${email}`;
  return { s: await clientFor(email, { tenantId: c.tenantId, userId: u!.id }), id: u!.id };
}
const statusOf = async (s: Client, area: AccessArea) => (await s.req('GET', PROBE[area])).status;

describe('access: admin chooses who sees what (enforced by the API)', () => {
  it('defaults keep what each role could see before', async () => {
    const c = await client();
    const staff = await member(c, 'staff');
    const sub = await member(c, 'subcontractor');
    for (const a of ACCESS_AREAS) expect(await statusOf(c, a), `owner ${a}`).toBe(200);
    const staffExpect = { financials: 200, quotes: 200, settings: 200, reports: 403, costs: 403 };
    for (const a of ACCESS_AREAS)
      expect(await statusOf(staff.s, a), `staff ${a}`).toBe(staffExpect[a]);
    for (const a of ACCESS_AREAS) expect(await statusOf(sub.s, a), `sub ${a}`).toBe(403);
    const me = (await staff.s.req('GET', '/api/me')).body;
    expect(me.access).toEqual({ isAdmin: false, areas: ['financials', 'quotes', 'settings'] });
  });

  it('each area can be switched on and off for a person, and the API follows both ways', async () => {
    const c = await client();
    const staff = await member(c, 'staff');
    for (const area of ACCESS_AREAS) {
      const on = await c.req('PUT', `/api/team/${staff.id}/access`, {
        isAdmin: false,
        areas: [area],
      });
      expect(on.status, JSON.stringify(on.body)).toBe(200);
      for (const a of ACCESS_AREAS)
        expect(await statusOf(staff.s, a), `only ${area}: ${a}`).toBe(a === area ? 200 : 403);
    }
    await c.req('PUT', `/api/team/${staff.id}/access`, { isAdmin: false, areas: [] });
    const denied = await staff.s.req('GET', '/api/invoices');
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('no_access');
    // Writes in an area are blocked too, and jobs stay open to everyone.
    expect((await staff.s.req('POST', '/api/quotes', { customerId: c.userId })).status).toBe(403);
    expect((await staff.s.req('GET', '/api/jobs')).status).toBe(200);
  });

  it('only admins change access or rates; owners stay admins; admins can be added and removed', async () => {
    const c = await client();
    const staff = await member(c, 'staff');
    const other = await member(c, 'staff');
    expect((await staff.s.req('GET', '/api/team/access')).status).toBe(403);
    expect(
      (await staff.s.req('PUT', `/api/team/${other.id}/access`, { isAdmin: true, areas: [] }))
        .status,
    ).toBe(403);
    // Seeing cost rates is not the same as changing them.
    await c.req('PUT', `/api/team/${staff.id}/access`, { isAdmin: false, areas: ['costs'] });
    expect((await staff.s.req('GET', '/api/team')).status).toBe(200);
    const put = await staff.s.req('PUT', `/api/team/${other.id}/charge-out`, { chargeOutPence: 1 });
    expect(put.status).toBe(403);
    expect(put.body.error.code).toBe('admin_only');

    const demoteOwner = await c.req('PUT', `/api/team/${c.userId}/access`, {
      isAdmin: false,
      areas: [],
    });
    expect(demoteOwner.status).toBe(422);
    expect(demoteOwner.body.error.message).toMatch(/owner is always an admin/);

    const promoted = await c.req('PUT', `/api/team/${staff.id}/access`, {
      isAdmin: true,
      areas: [],
    });
    expect(promoted.body).toMatchObject({
      isAdmin: true,
      preset: 'admin',
      areas: [...ACCESS_AREAS],
    });
    for (const a of ACCESS_AREAS) expect(await statusOf(staff.s, a)).toBe(200);
    // A second admin can manage access too, and can step back down (the owner remains an admin).
    expect(
      (
        await staff.s.req('PUT', `/api/team/${other.id}/access`, {
          isAdmin: false,
          areas: ['reports'],
        })
      ).body,
    ).toMatchObject({ preset: 'custom', areas: ['reports'] });
    const down = await staff.s.req('PUT', `/api/team/${staff.id}/access`, {
      isAdmin: false,
      areas: [],
    });
    expect(down.status).toBe(200);
    expect((await staff.s.req('GET', '/api/team/access')).status).toBe(403);

    const list = (await c.req('GET', '/api/team/access')).body as {
      userId: string;
      preset: string;
    }[];
    expect(list.find((x) => x.userId === c.userId)!.preset).toBe('admin');
    expect(list.find((x) => x.userId === staff.id)!.preset).toBe('field');
  });

  it('another business cannot change this one’s access', async () => {
    const c = await client();
    const staff = await member(c, 'staff');
    const other = await client();
    expect(
      (await other.req('PUT', `/api/team/${staff.id}/access`, { isAdmin: true, areas: [] })).status,
    ).toBe(422);
    expect(await statusOf(staff.s, 'reports')).toBe(403);
  });
});
