import { useSyncExternalStore } from 'react';

const subscribe = (cb: () => void) => {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => {
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
  };
};
export const useOnline = () =>
  useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );

/**
 * Says exactly what works offline. Job status and quote edits are saved on the device and sync later;
 * creating new records still needs a connection (and says so when you try).
 */
export function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div className="offline-banner" role="status">
      You’re offline. Job status and quote edits are saved on this device and will sync. Adding new
      customers, quotes or jobs needs signal.
    </div>
  );
}
