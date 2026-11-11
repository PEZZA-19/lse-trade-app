import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { idbKv, openOfflineDb } from './idb';

/** Server data seen on this device is kept in IndexedDB, so jobs and quotes open with no signal. */
export const persister = createAsyncStoragePersister({
  storage: idbKv(() => openOfflineDb()),
  key: 'lse-query-cache',
  throttleTime: 1000,
});
export const CACHE_MAX_AGE = 7 * 24 * 3600_000;
