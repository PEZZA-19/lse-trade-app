import type { MemberAccessDto } from '@lse/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { canOpen } from '../access';
import { handle, resetDemo } from './mockApi';

const get = <T>(p: string) => handle('GET', p, undefined) as Promise<T>;
const put = <T>(p: string, b: unknown) => handle('PUT', p, b) as Promise<T>;

describe('demo access (same rules as the server)', () => {
  beforeEach(() => {
    localStorage.clear();
    resetDemo();
  });

  it('lists the owner as admin and staff as Office; saves a preset; keeps the owner an admin', async () => {
    const list = await get<MemberAccessDto[]>('/team/access');
    const owner = list.find((a) => a.role === 'owner')!;
    const staff = list.find((a) => a.role === 'staff')!;
    expect(owner).toMatchObject({ isAdmin: true, preset: 'admin' });
    expect(staff).toMatchObject({ isAdmin: false, preset: 'office' });
    const field = await put<MemberAccessDto>(`/team/${staff.userId}/access`, {
      isAdmin: false,
      areas: [],
    });
    expect(field.preset).toBe('field');
    await expect(
      put(`/team/${owner.userId}/access`, { isAdmin: false, areas: [] }),
    ).rejects.toThrow(/owner is always an admin/);
    const me = await get<{ access: { isAdmin: boolean } }>('/me');
    expect(me.access.isAdmin).toBe(true);
  });

  it('screens follow the areas (menus hide them; a link shows No access)', () => {
    const field = { isAdmin: false, areas: [] };
    expect(canOpen(field, '/jobs/abc')).toBe(true);
    expect(canOpen(field, '/schedule')).toBe(true);
    for (const to of [
      '/invoices',
      '/bills/x',
      '/suppliers',
      '/reports',
      '/quotes/1',
      '/kits',
      '/settings',
    ])
      expect(canOpen(field, to), to).toBe(false);
    const office = { isAdmin: false, areas: ['financials', 'quotes', 'settings'] as const };
    expect(canOpen({ ...office, areas: [...office.areas] }, '/invoices')).toBe(true);
    expect(canOpen({ ...office, areas: [...office.areas] }, '/reports')).toBe(false);
    expect(canOpen({ isAdmin: true, areas: [] }, '/reports')).toBe(true);
  });
});
