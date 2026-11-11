// Cloudflare Workers entry. Postgres (Neon) is reached through a Hyperdrive binding.
import { createApp } from './app';
import { createSql, type Sql } from './db/client';

export interface Env {
  HYPERDRIVE: Hyperdrive;
  AUTH_MODE: 'dev';
  DEV_USER_ID?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Hyperdrive pools connections, so a small per-request client is the recommended pattern.
    let sql: Sql | undefined;
    const app = createApp({
      getSql: () => (sql ??= createSql(env.HYPERDRIVE.connectionString, { max: 5 })),
      authMode: env.AUTH_MODE,
      devUserId: env.DEV_USER_ID,
    });
    try {
      return await app.fetch(request, env, ctx);
    } finally {
      if (sql) ctx.waitUntil(sql.end());
    }
  },
} satisfies ExportedHandler<Env>;
