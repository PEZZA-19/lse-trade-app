import { useCallback, useEffect, useRef, useState } from 'react';
import type { SaveState } from '../components/SaveStatus';

/**
 * Sends saves one at a time, always ending with the latest edit (no out-of-order writes).
 * State is honest: "saving" while any write is in flight or queued, "saved" only after the
 * server confirmed the final one, "error" (kept visible, retryable) if it failed.
 */
export function useSerialSave<P>(send: (patch: P) => Promise<unknown>) {
  const [state, setState] = useState<SaveState>('idle');
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);
  const queued = useRef<P | null>(null);
  const lastFailed = useRef<P | null>(null);
  const sendRef = useRef(send);
  useEffect(() => {
    sendRef.current = send;
  }, [send]);

  const pumpRef = useRef<() => Promise<void>>(async () => {});
  const pump = useCallback(async () => {
    if (inFlight.current || queued.current === null) return;
    const patch = queued.current;
    queued.current = null;
    inFlight.current = true;
    setState('saving');
    try {
      await sendRef.current(patch);
      lastFailed.current = null;
      inFlight.current = false;
      if (queued.current !== null) void pumpRef.current();
      else setState('saved');
    } catch (e) {
      inFlight.current = false;
      lastFailed.current = queued.current ?? patch;
      queued.current = null;
      setError((e as Error).message);
      setState('error');
    }
  }, []);
  useEffect(() => {
    pumpRef.current = pump;
  }, [pump]);

  const save = useCallback(
    (patch: P) => {
      queued.current = patch;
      void pump();
    },
    [pump],
  );
  const retry = useCallback(() => {
    if (lastFailed.current) save(lastFailed.current);
  }, [save]);

  // Warn before leaving with unsaved work.
  useEffect(() => {
    if (state !== 'saving' && state !== 'error') return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [state]);

  return { state, error, save, retry };
}
