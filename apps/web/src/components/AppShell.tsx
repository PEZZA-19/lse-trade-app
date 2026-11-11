import { NavLink, Outlet, useLocation } from 'react-router';
import { useMe } from '../api/hooks';
import { useEnquiryCounts, useProposalCounts } from '../api/inbox';
import {
  IconCalendar,
  IconCustomers,
  IconHome,
  IconJobs,
  IconMoreCircle,
  IconQuotes,
  IconSettings,
  IconInvoice,
  IconTag,
  IconBox,
  IconReceipt,
  IconTruck,
  IconTray,
  IconSeal,
} from './icons';
import { OfflineBanner } from './OfflineBanner';
import { SyncBadge } from './SyncBadge';

/**
 * Phones: five tabs at most (Apple HIG). Approvals and Enquiries are things to act on today, so
 * they hang off Home (cards with counts, and a badge on the Home tab); Invoices, Bills,
 * Customers, Price List, Kits, Suppliers, Reports and Settings live under More.
 */
const TABS = [
  { to: '/home', label: 'Home', Icon: IconHome },
  { to: '/jobs', label: 'Jobs', Icon: IconJobs },
  { to: '/schedule', label: 'Schedule', Icon: IconCalendar },
  { to: '/quotes', label: 'Quotes', Icon: IconQuotes },
  { to: '/more', label: 'More', Icon: IconMoreCircle },
];
const UNDER_HOME = ['/home', '/approvals', '/enquiries'];
const UNDER_MORE = [
  '/more',
  '/customers',
  '/settings',
  '/sync',
  '/invoices',
  '/price-list',
  '/kits',
  '/bills',
  '/suppliers',
];
/** Desktop sidebar has room for everything. */
const SIDEBAR = [
  TABS[0]!,
  { to: '/approvals', label: 'Approvals', Icon: IconSeal },
  { to: '/enquiries', label: 'Enquiries', Icon: IconTray },
  ...TABS.slice(1, 4),
  { to: '/invoices', label: 'Invoices', Icon: IconInvoice },
  { to: '/bills', label: 'Supplier Bills', Icon: IconReceipt },
  { to: '/customers', label: 'Customers', Icon: IconCustomers },
  { to: '/price-list', label: 'Price List', Icon: IconTag },
  { to: '/kits', label: 'Kits', Icon: IconBox },
  { to: '/suppliers', label: 'Suppliers', Icon: IconTruck },
  { to: '/settings', label: 'Settings', Icon: IconSettings },
];

/** Sidebar on desktop and tablets in landscape; bottom tab bar on phones. */
export function AppShell() {
  const me = useMe();
  const { pathname } = useLocation();
  const inMore = UNDER_MORE.some((p) => pathname.startsWith(p));
  const inHome = UNDER_HOME.some((p) => pathname.startsWith(p));
  const waiting = useProposalCounts().data?.pending ?? 0;
  const todo = useEnquiryCounts().data?.todo ?? 0;
  const badges: Record<string, number> = {
    '/home': waiting + todo,
    '/approvals': waiting,
    '/enquiries': todo,
  };
  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Main">
        <div className="sidebar__brand">
          <img src="/icon-192.png" alt="" />
          <span>{me.data?.tenant.name ?? 'LSE Trade'}</span>
        </div>
        {SIDEBAR.map(({ to, label, Icon }) => (
          <NavLink key={to} to={to} className="sidebar__item">
            <Icon />
            {label}
            {to !== '/home' && badges[to] ? (
              <>
                <span className="nav-badge" aria-hidden="true">
                  {badges[to]}
                </span>
                <span className="visually-hidden">, {badges[to]} to check</span>
              </>
            ) : null}
          </NavLink>
        ))}
      </nav>
      <main className="shell__main">
        <OfflineBanner />
        <SyncBadge />
        {import.meta.env.VITE_DEMO === '1' && <DemoBanner />}
        <Outlet />
      </main>
      <nav className="tabbar" aria-label="Main">
        {TABS.map(({ to, label, Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={`tabbar__item${(to === '/more' && inMore) || (to === '/home' && inHome) ? ' is-current' : ''}`}
          >
            <span className="tabbar__icon">
              <Icon />
              {to === '/home' && badges['/home'] ? (
                <span className="nav-badge nav-badge--tab" aria-hidden="true">
                  {badges['/home']}
                </span>
              ) : null}
            </span>
            {label}
            {to === '/home' && badges['/home'] ? (
              <span className="visually-hidden">, {badges['/home']} to check</span>
            ) : null}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

function DemoBanner() {
  return (
    <div className="demo-banner" role="note">
      Preview with made-up sample data. Changes stay on this device.{' '}
      <button
        type="button"
        onClick={async () => {
          (await import('../demo/mockApi')).resetDemo();
          window.location.assign('/home');
        }}
      >
        Reset
      </button>
    </div>
  );
}
