// Cloudflare Workers entry. Postgres (Neon) is reached through a Hyperdrive binding.
import { createApp } from './app';
import { createSql, type Sql } from './db/client';
import { UnconfiguredMailer } from './lib/mailer';
import { AiGateway } from './ai/gateway';
import { FakeProvider } from './ai/fake';

export interface Env {
  HYPERDRIVE: Hyperdrive;
  /** Public URL of the web app, e.g. https://app.example. Used for sign-in links and Origin checks. */
  APP_ORIGIN: string;
  /** "fake" for local `wrangler dev`. Unset: AI helpers are off. No real provider is configured. */
  AI_PROVIDER?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Hyperdrive pools connections, so a small per-request client is the recommended pattern.
    let sql: Sql | undefined;
    const app = createApp({
      getSql: () => (sql ??= createSql(env.HYPERDRIVE.connectionString, { max: 5 })),
      // No email provider is wired up yet: sign-in requests fail loudly rather than pretend.
      auth: { mailer: new UnconfiguredMailer(), appOrigin: env.APP_ORIGIN },
      ai: new AiGateway(env.AI_PROVIDER === 'fake' ? new FakeProvider() : null),
    });
    try {
      return await app.fetch(request, env, ctx);
    } finally {
      if (sql) ctx.waitUntil(sql.end());
    }
  },
} satisfies ExportedHandler<Env>;
