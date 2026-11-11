import { Link } from 'react-router';
import { useSync } from '../offline';
import { useOnline } from './OfflineBanner';

/**
 * What's waiting to reach the server, in plain words. Hidden when everything is synced.
 * Reviews (M1): a sync badge that shows what is waiting; never pretend something is on the server.
 */
export function SyncBadge() {
  const sync = useSync();
  const online = useOnline();
  if (!sync.pending && !sync.needsAttention) return null;
  const n = (k: number, word: string) => `${k} ${word}${k === 1 ? '' : 's'}`;
  const text = sync.needsAttention
    ? `${n(sync.needsAttention, 'change')} need${sync.needsAttention === 1 ? 's' : ''} your attention`
    : sync.syncing
      ? 'Syncing…'
      : !online || sync.stalled === 'offline'
        ? `${n(sync.pending, 'change')} saved on this device, waiting for signal`
        : sync.stalled === 'signed_out'
          ? `${n(sync.pending, 'change')} waiting: sign in again to sync`
          : `${n(sync.pending, 'change')} waiting to sync`;
  return (
    <Link
      to="/sync"
      className={`sync-badge${sync.needsAttention ? ' sync-badge--alert' : ''}`}
      role="status"
      aria-live="polite"
    >
      <span className="dot" aria-hidden />
      {text}
    </Link>
  );
}
