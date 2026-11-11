import { NavLink, Outlet } from 'react-router';
import { useMe } from '../api/hooks';
import { IconCustomers, IconJobs, IconQuotes, IconSettings } from './icons';
import { OfflineBanner } from './OfflineBanner';
import { SyncBadge } from './SyncBadge';

const TABS = [
  { to: '/jobs', label: 'Jobs', Icon: IconJobs },
  { to: '/quotes', label: 'Quotes', Icon: IconQuotes },
  { to: '/customers', label: 'Customers', Icon: IconCustomers },
  { to: '/settings', label: 'Settings', Icon: IconSettings },
];

/** Sidebar on desktop and tablets in landscape; bottom tab bar on phones. */
export function AppShell() {
  const me = useMe();
  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Main">
        <div className="sidebar__brand">
          <img src="/icon.svg" alt="" />
          <span>{me.data?.tenant.name ?? 'LSE Trade'}</span>
        </div>
        {TABS.map(({ to, label, Icon }) => (
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
          <NavLink key={to} to={to} className="tabbar__item">
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
          window.location.assign('/jobs');
        }}
      >
        Reset
      </button>
    </div>
  );
}
