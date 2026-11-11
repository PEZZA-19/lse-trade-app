import { AREA_LABEL, type AccessArea } from '@lse/shared';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
// Bundled (not /public) so it also shows in the single-file local demo.
import appIcon from '../assets/app-icon.png';
import { useAccess, useMe } from '../api/hooks';
import { areaForRoute, canOpen } from '../access';
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
  IconChart,
} from './icons';
import { OfflineBanner } from './OfflineBanner';
import { SyncBadge } from './SyncBadge';
import { Button, EmptyState, Page } from './ui';

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
  '/calendar',
  '/customers',
  '/settings',
  '/sync',
  '/invoices',
  '/price-list',
  '/kits',
  '/bills',
  '/suppliers',
  '/reports',
];
/** Desktop sidebar has room for everything. */
const SIDEBAR = [
  TABS[0]!,
  { to: '/approvals', label: 'Approvals', Icon: IconSeal },
  { to: '/enquiries', label: 'Enquiries', Icon: IconTray },
  ...TABS.slice(1, 4),
  { to: '/invoices', label: 'Invoices', Icon: IconInvoice },
  { to: '/bills', label: 'Supplier Bills', Icon: IconReceipt },
  { to: '/reports', label: 'Reports', Icon: IconChart },
  { to: '/customers', label: 'Customers', Icon: IconCustomers },
  { to: '/price-list', label: 'Price List', Icon: IconTag },
  { to: '/kits', label: 'Kits', Icon: IconBox },
  { to: '/suppliers', label: 'Suppliers', Icon: IconTruck },
  { to: '/settings', label: 'Settings', Icon: IconSettings },
];

/** Sidebar on desktop and tablets in landscape; bottom tab bar on phones. */
export function AppShell() {
  const me = useMe();
  const access = useAccess();
  // Areas an admin has switched off for this person are left out of the menus altogether.
  const tabs = TABS.filter((t) => canOpen(access, t.to));
  const sidebar = SIDEBAR.filter((t) => canOpen(access, t.to));
  const { pathname } = useLocation();
  const inMore = UNDER_MORE.some((p) => pathname.startsWith(p));
  const inHome = UNDER_HOME.some((p) => pathname.startsWith(p));
  const blocked = access.ready && !canOpen(access, pathname);
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
          <img src={appIcon} alt="" />
          <span>{me.data?.tenant.name ?? 'LSE Trade'}</span>
        </div>
        {sidebar.map(({ to, label, Icon }) => (
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
        {blocked ? <NoAccess area={areaForRoute(pathname)} /> : <Outlet />}
      </main>
      <nav className="tabbar" aria-label="Main">
        {tabs.map(({ to, label, Icon }) => (
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

/** Shown instead of a screen this person's access doesn't include (e.g. a shared link). */
function NoAccess({ area }: { area: AccessArea | null }) {
  const navigate = useNavigate();
  return (
    <Page title="No Access">
      <EmptyState
        icon={<IconSeal />}
        title="Not available to you"
        message={`Your account can’t open ${area ? AREA_LABEL[area].title.toLowerCase() : 'this'}. Ask an admin if you need it.`}
        action={<Button onClick={() => navigate('/home')}>Go to Home</Button>}
      />
    </Page>
  );
}

function DemoBanner() {
  return (
    <div className="demo-banner" role="note">
      {import.meta.env.VITE_HASH_ROUTER === '1'
        ? 'Demo on this computer: sample jobs and customers, plus your own supplier bills. Nothing is sent; changes stay in this browser.'
        : 'Preview with made-up sample data. Changes stay on this device.'}{' '}
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
