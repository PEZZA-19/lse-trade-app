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
 * Says exactly what works offline. Job stages, the timer, quote edits and new customers, quotes and
 * jobs are saved on the device and sync later; sending, invoicing, assigning and booking need signal.
 */
export function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div className="offline-banner" role="status">
      You’re offline. Job stages, the timer, quote edits and new customers, quotes and jobs are
      saved on this device and will sync. Sending, invoicing, assigning and booking need signal.
    </div>
  );
}
