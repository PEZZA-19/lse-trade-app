import postgres from 'postgres';

export type Sql = postgres.Sql;
/** A transaction handle. Same tagged-template API as Sql. */
export type Tx = postgres.TransactionSql;

export interface SqlOptions {
  /** Max pool size. Workers should use 1 per request (Hyperdrive pools for us). */
  max?: number;
}

export function createSql(url: string, opts: SqlOptions = {}): Sql {
  return postgres(url, {
    max: opts.max ?? 10,
    // snake_case columns -> camelCase keys in results.
    transform: postgres.camel,
    // int8 (bigint) -> JS number. Every bigint we store (pence, thousandths, sequence values)
    // stays far below Number.MAX_SAFE_INTEGER; parse guards against silent precision loss.
    types: {
      bigint: {
        to: 20,
        from: [20],
        serialize: (x: number) => String(x),
        parse: (x: string) => {
          const n = Number(x);
          if (!Number.isSafeInteger(n)) throw new RangeError(`int8 out of safe range: ${x}`);
          return n;
        },
      },
    },
    onnotice: () => {},
    // Hyperdrive and local dev both handle prepared statements.
    prepare: true,
  });
}

export interface TenantContext {
  tenantId: string;
  userId: string;
}

/**
 * Runs fn in a transaction scoped to one tenant. Row-level security reads these settings,
 * so even a buggy query cannot see or change another business's rows.
 */
export async function withTenant<T>(sql: Sql, ctx: TenantContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', ${ctx.tenantId}, true), set_config('app.user_id', ${ctx.userId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

/** Transaction with only the user set: used to list a user's memberships before a tenant is chosen. */
export async function withUser<T>(sql: Sql, userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}
