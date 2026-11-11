import { describe, expect, it } from 'vitest';
import { areaForPath, canSee, defaultAccess, presetOf, PRESET_AREAS } from '../src/access';

describe('access areas', () => {
  it('maps routes to areas; jobs, customers and time stay open', () => {
    expect(areaForPath('GET', '/api/invoices')).toBe('financials');
    expect(areaForPath('POST', '/api/supplier-bills/x/approve')).toBe('financials');
    expect(areaForPath('GET', '/api/jobs/abc/invoicing')).toBe('financials');
    expect(areaForPath('GET', '/api/reports')).toBe('reports');
    expect(areaForPath('GET', '/api/jobs/abc/costing')).toBe('reports');
    expect(areaForPath('PUT', '/api/team/u/cost')).toBe('costs');
    expect(areaForPath('GET', '/api/quotes/q')).toBe('quotes');
    expect(areaForPath('GET', '/api/price-list')).toBe('quotes');
    expect(areaForPath('GET', '/api/settings')).toBe('settings');
    expect(areaForPath('POST', '/api/job-stages')).toBe('settings');
    expect(areaForPath('GET', '/api/job-stages')).toBeNull();
    for (const p of ['/api/jobs', '/api/jobs/abc', '/api/customers', '/api/timesheets', '/api/me'])
      expect(areaForPath('GET', p), p).toBeNull();
  });
  it('defaults and presets', () => {
    expect(defaultAccess('owner').isAdmin).toBe(true);
    expect(defaultAccess('subcontractor').areas).toEqual([]);
    expect(presetOf(defaultAccess('staff'))).toBe('office');
    expect(presetOf({ isAdmin: false, areas: [] })).toBe('field');
    expect(presetOf({ isAdmin: false, areas: ['reports'] })).toBe('custom');
    expect(canSee({ isAdmin: false, areas: PRESET_AREAS.office }, 'costs')).toBe(false);
    expect(canSee({ isAdmin: true, areas: [] }, 'costs')).toBe(true);
  });
});
