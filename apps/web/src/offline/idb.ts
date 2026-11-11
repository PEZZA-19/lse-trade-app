import { openDB, type IDBPDatabase } from 'idb';
import type { OutboxOp, OutboxStorage } from './outbox';

/** One IndexedDB database on the device: the outbox and the cached server data for offline reading. */
const DB_NAME = 'lse-offline';
let dbp: Promise<IDBPDatabase> | null = null;

export function openOfflineDb(name = DB_NAME) {
  if (name !== DB_NAME) return open(name);
  dbp ??= open(name);
  return dbp;
}
function open(name: string) {
  return openDB(name, 1, {
    upgrade(db) {
      db.createObjectStore('outbox', { keyPath: 'id' });
      db.createObjectStore('kv');
    },
  });
}

export function idbOutboxStorage(db: () => Promise<IDBPDatabase>): OutboxStorage {
  return {
    all: async () => (await db()).getAll('outbox') as Promise<OutboxOp[]>,
    // structuredClone strips anything non-cloneable and detaches us from the live object.
    put: async (op) => void (await (await db()).put('outbox', structuredClone(op))),
    delete: async (id) => void (await (await db()).delete('outbox', id)),
  };
}

/** Async key-value storage for the TanStack Query persister. */
export function idbKv(db: () => Promise<IDBPDatabase>) {
  return {
    getItem: async (key: string) =>
      ((await (await db()).get('kv', key)) as string | undefined) ?? null,
    setItem: async (key: string, value: string) => void (await (await db()).put('kv', value, key)),
    removeItem: async (key: string) => void (await (await db()).delete('kv', key)),
  };
}
