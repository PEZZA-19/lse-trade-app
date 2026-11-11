import { useEffect } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { SIGNED_OUT_EVENT } from './api/client';
import { keys, useSession } from './api/hooks';
import { AppShell } from './components/AppShell';
import { ListSkeleton } from './components/ui';
import { CustomerScreen } from './screens/CustomerScreen';
import { CustomersScreen } from './screens/CustomersScreen';
import { JobScreen } from './screens/JobScreen';
import { JobsScreen } from './screens/JobsScreen';
import { QuoteScreen } from './screens/QuoteScreen';
import { QuotesScreen } from './screens/QuotesScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { SignInScreen, VerifyScreen } from './screens/SignInScreen';

/** Shows the app only with a live session; otherwise the sign-in screen. */
function RequireSession() {
  const session = useSession();
  const qc = useQueryClient();
  const location = useLocation();
  useEffect(() => {
    const onSignedOut = () => qc.setQueryData(keys.session, null);
    window.addEventListener(SIGNED_OUT_EVENT, onSignedOut);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, onSignedOut);
  }, [qc]);
  if (session.isPending) return <ListSkeleton rows={6} />;
  if (session.data === null)
    return <Navigate to="/sign-in" replace state={{ from: location.pathname }} />;
  // Offline or server down: keep going (cached screens and the offline banner explain the rest).
  return <Outlet />;
}

export function App() {
  return (
    <Routes>
      <Route path="sign-in" element={<SignInScreen />} />
      <Route path="sign-in/verify" element={<VerifyScreen />} />
      <Route element={<RequireSession />}>
        <Route element={<AppShell />}>
          <Route index element={<Navigate to="/jobs" replace />} />
          <Route path="jobs" element={<JobsScreen />} />
          <Route path="jobs/:id" element={<JobScreen />} />
          <Route path="quotes" element={<QuotesScreen />} />
          <Route path="quotes/:id" element={<QuoteScreen />} />
          <Route path="customers" element={<CustomersScreen />} />
          <Route path="customers/:id" element={<CustomerScreen />} />
          <Route path="settings" element={<SettingsScreen />} />
          <Route path="*" element={<Navigate to="/jobs" replace />} />
        </Route>
      </Route>
    </Routes>
  );
}
