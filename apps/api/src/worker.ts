// Cloudflare Workers entry. Postgres (Neon) is reached through a Hyperdrive binding.
// Not deployed: no Cloudflare account is connected. See DEPLOY.md for the checklist.
import { createApp } from './app';
import { createSql, type Sql } from './db/client';
import { AiGateway } from './ai/gateway';
import { FakeProvider } from './ai/fake';
import { releaseHeldEmails } from './cron';
import { servicesFor, type ServiceEnv } from './services-for-env';

export interface Env extends ServiceEnv {
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
    const s = servicesFor(env);
    const app = createApp({
      getSql: () => (sql ??= createSql(env.HYPERDRIVE.connectionString, { max: 5 })),
      // Every slot fails closed until configured (services-for-env.ts).
      auth: { mailer: s.mailer, appOrigin: env.APP_ORIGIN },
      blobs: s.blobs,
      turnstile: s.turnstile,
      sender: s.sender ?? undefined,
      ai: new AiGateway(env.AI_PROVIDER === 'fake' ? new FakeProvider() : null),
    });
    try {
      return await app.fetch(request, env, ctx);
    } finally {
      if (sql) ctx.waitUntil(sql.end());
    }
  },

  /** Cron (wrangler.jsonc "triggers"): release held emails whose two minutes are up. */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const sql = createSql(env.HYPERDRIVE.connectionString, { max: 2 });
    ctx.waitUntil(
      releaseHeldEmails(sql, servicesFor(env).sender)
        .then((r) => {
          if (r.released || r.failed.length) console.log('held emails', JSON.stringify(r));
        })
        .finally(() => sql.end()),
    );
  },
} satisfies ExportedHandler<Env>;
