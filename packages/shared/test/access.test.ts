import { describe, expect, it } from 'vitest';
import {
  areaForPath,
  canSee,
  canSeePrices,
  defaultAccess,
  presetOf,
  PRESET_AREAS,
  redactPrices,
} from '../src/access';

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
  it('prices: shown with quotes or accounts access; redaction removes every money field', () => {
    expect(canSeePrices({ isAdmin: false, areas: [] })).toBe(false);
    expect(canSeePrices({ isAdmin: false, areas: ['reports', 'costs'] })).toBe(false);
    expect(canSeePrices({ isAdmin: false, areas: ['quotes'] })).toBe(true);
    expect(canSeePrices({ isAdmin: false, areas: ['financials'] })).toBe(true);
    const job = {
      title: 'Rewire',
      quotedTotalPence: 5000,
      lines: [{ description: 'RCBO', qtyMilli: 2000, unitSellPence: 1300, markupBp: 3000 }],
      customer: { name: 'Pat', nested: [{ balancePence: 1 }] },
    };
    expect(redactPrices(job)).toEqual({
      title: 'Rewire',
      quotedTotalPence: null,
      lines: [{ description: 'RCBO', qtyMilli: 2000, unitSellPence: null, markupBp: null }],
      customer: { name: 'Pat', nested: [{ balancePence: null }] },
    });
    expect(job.quotedTotalPence).toBe(5000); // the original is untouched
  });
});
