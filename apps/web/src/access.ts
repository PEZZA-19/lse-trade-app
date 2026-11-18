import { canSee, type Access, type AccessArea } from '@lse/shared';

/** Which access area a screen belongs to (mirrors the API's areaForPath); null = open to all. */
export function areaForRoute(pathname: string): AccessArea | null {
  const top = pathname.split('/')[1] ?? '';
  if (['invoices', 'bills', 'suppliers'].includes(top)) return 'financials';
  if (top === 'reports' || top === 'business') return 'reports';
  if (['quotes', 'price-list', 'kits'].includes(top)) return 'quotes';
  if (top === 'settings') return 'settings';
  return null;
}

/** Can this person open the route? Open routes always; others need the area. */
export const canOpen = (a: Access, to: string) => {
  const area = areaForRoute(to);
  // The business overview shows the books: it needs Accounts as well as Reports (as the API does).
  if (to.split('/')[1] === 'business') return canSee(a, 'reports') && canSee(a, 'financials');
  return area === null || canSee(a, area);
};
