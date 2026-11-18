import { z } from 'zod';

/**
 * Who can see what (Tradify-style). An admin sees everything and decides, per person, which
 * areas they can open. Jobs, schedule, customers and their own time are open to everyone in the
 * business (subcontractors still only see jobs they're on). Enforced by the API, mirrored in the UI.
 */
export const ACCESS_AREAS = ['financials', 'reports', 'costs', 'quotes', 'settings'] as const;
export type AccessArea = (typeof ACCESS_AREAS)[number];

export const AREA_LABEL: Record<AccessArea, { title: string; sub: string }> = {
  financials: {
    title: 'Accounts',
    sub: 'Invoices, credit notes, supplier bills, statements, payments',
  },
  reports: { title: 'Reports and profit', sub: 'Reports, quote vs actual, profit per job' },
  costs: { title: 'Cost rates', sub: 'What each person costs and charges per hour' },
  quotes: { title: 'Quotes and pricing', sub: 'Quotes, price list, kits' },
  settings: { title: 'Settings', sub: 'Business details, documents, job stages' },
};

export type AccessPreset = 'admin' | 'office' | 'field' | 'subcontractor' | 'custom';
export const PRESET_AREAS: Record<Exclude<AccessPreset, 'custom'>, AccessArea[]> = {
  admin: [...ACCESS_AREAS],
  office: ['financials', 'quotes', 'settings'],
  field: [],
  subcontractor: [],
};
export const PRESET_LABEL: Record<AccessPreset, string> = {
  admin: 'Admin',
  office: 'Office',
  field: 'Field worker',
  subcontractor: 'Subcontractor',
  custom: 'Custom',
};

export interface Access {
  isAdmin: boolean;
  areas: AccessArea[];
}

/** Before an admin chooses: owners are admins; staff and accountants get Office; subcontractors nothing. */
export function defaultAccess(role: string): Access {
  if (role === 'owner') return { isAdmin: true, areas: [...ACCESS_AREAS] };
  if (role === 'subcontractor') return { isAdmin: false, areas: [] };
  return { isAdmin: false, areas: [...PRESET_AREAS.office] };
}

export const canSee = (a: Access, area: AccessArea) => a.isAdmin || a.areas.includes(area);

/** The preset whose areas match exactly (admins are "Admin"), else "Custom". */
export function presetOf(a: Access): AccessPreset {
  if (a.isAdmin) return 'admin';
  const key = [...a.areas].sort().join(',');
  for (const p of ['office', 'field'] as const)
    if ([...PRESET_AREAS[p]].sort().join(',') === key) return p;
  return 'custom';
}

export const accessUpdate = z.object({
  isAdmin: z.boolean(),
  areas: z.array(z.enum(ACCESS_AREAS)).max(ACCESS_AREAS.length),
});
export type AccessUpdate = z.input<typeof accessUpdate>;

export interface MemberAccessDto extends Access {
  userId: string;
  name: string;
  role: string;
  preset: AccessPreset;
}

/** Which area an API path belongs to (null: open to everyone signed in). */
export function areaForPath(method: string, path: string): AccessArea | null {
  if (/^\/api\/(invoices|credit-notes|supplier-bills|suppliers)(\/|$)/.test(path))
    return 'financials';
  if (/^\/api\/jobs\/[^/]+\/(invoices|invoicing)$/.test(path)) return 'financials';
  // The business overview and Xero-style reports: Reports here, and Accounts checked by the route.
  if (/^\/api\/business(\/|$)/.test(path)) return 'reports';
  if (/^\/api\/reports(\/|$)/.test(path) || /^\/api\/jobs\/[^/]+\/costing$/.test(path))
    return 'reports';
  if (/^\/api\/team(\/|$)/.test(path)) return 'costs';
  if (/^\/api\/(quotes|price-list|kits)(\/|$)/.test(path)) return 'quotes';
  if (/^\/api\/enquiries\/[^/]+\/draft-quote$/.test(path)) return 'quotes';
  if (path === '/api/settings' || /^\/api\/settings\/(logo|enquiry-form)$/.test(path))
    return 'settings';
  // Job stages can be read by everyone (the job screen needs them); changing them is Settings.
  if (/^\/api\/job-stages(\/|$)/.test(path) && method !== 'GET') return 'settings';
  return null;
}

/** Prices and money are for people with Quotes and pricing or Accounts access (Joe, 11 Nov 2026). */
export const canSeePrices = (a: Access) => canSee(a, 'quotes') || canSee(a, 'financials');

/** Money fields end in Pence (amounts) or Bp (markups, rates). */
const MONEY_KEY = /(Pence|Bp)$/;

/** A copy with every money field set to null, at any depth (for people who can't see prices). */
export function redactPrices<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => redactPrices(v)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = MONEY_KEY.test(k) ? null : redactPrices(v);
    return out as T;
  }
  return value;
}
