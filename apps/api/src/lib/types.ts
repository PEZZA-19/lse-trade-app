import type { Sql, Tx } from '../db/client';

export interface Auth {
  userId: string;
  tenantId: string;
  role: 'owner' | 'staff' | 'subcontractor' | 'accountant';
}

export interface AppEnv {
  Variables: {
    auth: Auth;
    sql: Sql;
    /** Runs fn in a transaction scoped to the signed-in user's business. */
    tx: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
  };
}

export const iso = (d: Date | string | null): string | null =>
  d == null ? null : d instanceof Date ? d.toISOString() : new Date(d).toISOString();
export const isoNN = (d: Date | string): string => iso(d)!;
