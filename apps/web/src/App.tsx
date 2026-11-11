import { Navigate, Route, Routes } from 'react-router';
import { AppShell } from './components/AppShell';
import { CustomerScreen } from './screens/CustomerScreen';
import { CustomersScreen } from './screens/CustomersScreen';
import { JobScreen } from './screens/JobScreen';
import { JobsScreen } from './screens/JobsScreen';
import { QuoteScreen } from './screens/QuoteScreen';
import { QuotesScreen } from './screens/QuotesScreen';

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/jobs" replace />} />
        <Route path="jobs" element={<JobsScreen />} />
        <Route path="jobs/:id" element={<JobScreen />} />
        <Route path="quotes" element={<QuotesScreen />} />
        <Route path="quotes/:id" element={<QuoteScreen />} />
        <Route path="customers" element={<CustomersScreen />} />
        <Route path="customers/:id" element={<CustomerScreen />} />
        <Route path="*" element={<Navigate to="/jobs" replace />} />
      </Route>
    </Routes>
  );
}
