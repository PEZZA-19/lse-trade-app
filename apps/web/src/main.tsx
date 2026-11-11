import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import { ToastProvider } from './components/Toast';
import { ApiError } from './api/client';
import { CACHE_MAX_AGE, persister } from './offline/persist';
import { initOffline } from './offline';
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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        maxAge: CACHE_MAX_AGE,
        // Bump when cached data shapes change, so an old cache is dropped rather than misread.
        buster: 'v2',
        dehydrateOptions: {
          // Never persist "signed out", or the next launch would skip checking the session.
          shouldDehydrateQuery: (q) =>
            q.state.status === 'success' && !(q.queryKey[0] === 'session' && q.state.data == null),
        },
      }}
    >
      <BrowserRouter>
        <ToastProvider>
          <App />
        </ToastProvider>
      </BrowserRouter>
    </PersistQueryClientProvider>
  </StrictMode>,
);

// Service worker: caches the app shell so it opens with no signal.
if (import.meta.env.PROD) {
  void import('virtual:pwa-register').then(({ registerSW }) => registerSW({ immediate: true }));
}
