import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, HashRouter } from 'react-router';
import { App } from './App';
import { ToastProvider } from './components/Toast';
import { ApiError } from './api/client';
import { CACHE_MAX_AGE, persister } from './offline/persist';
import { afterRestore, initOffline } from './offline';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: CACHE_MAX_AGE, // keep for offline use (persisted to IndexedDB)
      retry: (count, err) =>
        !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
      refetchOnWindowFocus: true,
    },
    // Fail fast when offline so the UI can say "not saved" instead of silently waiting.
    // (Offline-capable edits go through the outbox, which saves on the device first.)
    mutations: { networkMode: 'always', retry: false },
  },
});

initOffline(queryClient);

// The local demo opens from a folder (file://), where only #/hash routes work.
const Router = import.meta.env.VITE_HASH_ROUTER === '1' ? HashRouter : BrowserRouter;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PersistQueryClientProvider
      client={queryClient}
      onSuccess={() => void afterRestore(queryClient)}
      persistOptions={{
        persister,
        maxAge: CACHE_MAX_AGE,
        // Bump when cached data shapes change, so an old cache is dropped rather than misread.
        buster: 'v4', // v4: job timer, timesheets, assignees
        dehydrateOptions: {
          // Never persist "signed out", or the next launch would skip checking the session.
          shouldDehydrateQuery: (q) =>
            q.state.status === 'success' && !(q.queryKey[0] === 'session' && q.state.data == null),
        },
      }}
    >
      <Router>
        <ToastProvider>
          <App />
        </ToastProvider>
      </Router>
    </PersistQueryClientProvider>
  </StrictMode>,
);

// Service worker: caches the app shell so it opens with no signal.
if (import.meta.env.PROD && import.meta.env.VITE_HASH_ROUTER !== '1') {
  void import('virtual:pwa-register').then(({ registerSW }) => registerSW({ immediate: true }));
}
