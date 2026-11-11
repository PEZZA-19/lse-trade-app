import { NavLink, Outlet, useLocation } from 'react-router';
import { useMe } from '../api/hooks';
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
} from './icons';
import { OfflineBanner } from './OfflineBanner';
import { SyncBadge } from './SyncBadge';

/** Phones: five tabs at most (Apple HIG); Invoices, Customers, Price List, Kits and Settings live under More. */
const TABS = [
  { to: '/home', label: 'Home', Icon: IconHome },
  { to: '/jobs', label: 'Jobs', Icon: IconJobs },
  { to: '/schedule', label: 'Schedule', Icon: IconCalendar },
  { to: '/quotes', label: 'Quotes', Icon: IconQuotes },
  { to: '/more', label: 'More', Icon: IconMoreCircle },
];
const UNDER_MORE = [
  '/more',
  '/customers',
  '/settings',
  '/sync',
  '/invoices',
  '/price-list',
  '/kits',
];
/** Desktop sidebar has room for everything. */
const SIDEBAR = [
  ...TABS.slice(0, 4),
  { to: '/invoices', label: 'Invoices', Icon: IconInvoice },
  { to: '/customers', label: 'Customers', Icon: IconCustomers },
  { to: '/price-list', label: 'Price List', Icon: IconTag },
  { to: '/kits', label: 'Kits', Icon: IconBox },
  { to: '/settings', label: 'Settings', Icon: IconSettings },
];

/** Sidebar on desktop and tablets in landscape; bottom tab bar on phones. */
export function AppShell() {
  const me = useMe();
  const { pathname } = useLocation();
  const inMore = UNDER_MORE.some((p) => pathname.startsWith(p));
  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Main">
        <div className="sidebar__brand">
          <img src="/icon.svg" alt="" />
          <span>{me.data?.tenant.name ?? 'LSE Trade'}</span>
        </div>
        {SIDEBAR.map(({ to, label, Icon }) => (
          <NavLink key={to} to={to} className="sidebar__item">
            <Icon />
            {label}
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
            className={`tabbar__item${to === '/more' && inMore ? ' is-current' : ''}`}
          >
            <Icon />
            {label}
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
