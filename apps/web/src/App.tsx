import { useEffect } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { SIGNED_OUT_EVENT } from './api/client';
import { keys, useSession } from './api/hooks';
import { AppShell } from './components/AppShell';
import { ListSkeleton } from './components/ui';
import { CustomerScreen } from './screens/CustomerScreen';
import { CustomersScreen } from './screens/CustomersScreen';
import { HomeScreen } from './screens/HomeScreen';
import { JobScreen } from './screens/JobScreen';
import { MoreScreen } from './screens/MoreScreen';
import { ScheduleScreen } from './screens/schedule/ScheduleScreen';
import { JobsScreen } from './screens/JobsScreen';
import { QuoteScreen } from './screens/QuoteScreen';
import { QuotesScreen } from './screens/QuotesScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { SignInScreen, VerifyScreen } from './screens/SignInScreen';
import { SyncScreen } from './screens/SyncScreen';
import { InvoiceScreen } from './screens/invoices/InvoiceScreen';
import { InvoicesScreen } from './screens/invoices/InvoicesScreen';
import { BillScreen } from './screens/bills/BillScreen';
import { BillsScreen } from './screens/bills/BillsScreen';
import { SupplierScreen, SuppliersScreen } from './screens/bills/SuppliersScreen';
import { StatementScreen } from './screens/bills/StatementScreen';
import { EnquiriesScreen } from './screens/inbox/EnquiriesScreen';
import { EnquiryScreen } from './screens/inbox/EnquiryScreen';
import { ApprovalsScreen, ProposalScreen } from './screens/inbox/ApprovalsScreen';
import { KitScreen } from './screens/pricing/KitScreen';
import { KitsScreen } from './screens/pricing/KitsScreen';
import { PriceItemScreen } from './screens/pricing/PriceItemScreen';
import { PriceListScreen } from './screens/pricing/PriceListScreen';

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
          <Route index element={<Navigate to="/home" replace />} />
          <Route path="home" element={<HomeScreen />} />
          <Route path="schedule" element={<ScheduleScreen />} />
          <Route path="more" element={<MoreScreen />} />
          <Route path="jobs" element={<JobsScreen />} />
          <Route path="jobs/:id" element={<JobScreen />} />
          <Route path="quotes" element={<QuotesScreen />} />
          <Route path="quotes/:id" element={<QuoteScreen />} />
          <Route path="customers" element={<CustomersScreen />} />
          <Route path="customers/:id" element={<CustomerScreen />} />
          <Route path="settings" element={<SettingsScreen />} />
          <Route path="sync" element={<SyncScreen />} />
          <Route path="invoices" element={<InvoicesScreen />} />
          <Route path="invoices/:id" element={<InvoiceScreen />} />
          <Route path="price-list" element={<PriceListScreen />} />
          <Route path="price-list/:id" element={<PriceItemScreen />} />
          <Route path="kits" element={<KitsScreen />} />
          <Route path="kits/:id" element={<KitScreen />} />
          <Route path="approvals" element={<ApprovalsScreen />} />
          <Route path="approvals/:id" element={<ProposalScreen />} />
          <Route path="enquiries" element={<EnquiriesScreen />} />
          <Route path="enquiries/:id" element={<EnquiryScreen />} />
          <Route path="bills" element={<BillsScreen />} />
          <Route path="bills/:id" element={<BillScreen />} />
          <Route path="suppliers" element={<SuppliersScreen />} />
          <Route path="suppliers/statement" element={<StatementScreen />} />
          <Route path="suppliers/:id" element={<SupplierScreen />} />
          <Route path="*" element={<Navigate to="/home" replace />} />
        </Route>
      </Route>
    </Routes>
  );
}
