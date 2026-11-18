// Cloudflare Workers entry. Postgres (Neon) is reached through a Hyperdrive binding.
// Not deployed: no Cloudflare account is connected. See DEPLOY.md for the checklist.
import { createApp } from './app';
import { createSql, type Sql } from './db/client';
import { AiGateway } from './ai/gateway';
import { FakeProvider } from './ai/fake';
import { releaseHeldEmails } from './cron';
import { syncDue } from './services/calendarSync';
import { googleFromEnv, type GoogleCalendar, type GoogleEnv } from './services/googleCalendar';
import { servicesFor, type ServiceEnv } from './services-for-env';

/**
 * Google Calendar (two-way sync): built once per isolate from the secrets GOOGLE_CLIENT_ID,
 * GOOGLE_CLIENT_SECRET and CALENDAR_TOKEN_KEY. Missing any: null, and the app says "needs setting
 * up". A malformed CALENDAR_TOKEN_KEY fails loudly (never silently stores tokens unsealed).
 */
let googleOnce: Promise<GoogleCalendar | null> | undefined;
const googleFor = (env: Env) =>
  (googleOnce ??= googleFromEnv(env, env.APP_ORIGIN).then((g) => g.google));

export interface Env extends ServiceEnv, GoogleEnv {
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
    const google = await googleFor(env);
    const app = createApp({
      google,
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

  /**
   * Cron (wrangler.jsonc "triggers", every minute): release held emails whose two minutes are up;
   * every 15 minutes, sync connected Google calendars that are due (each at most every 15 min).
   */
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const sql = createSql(env.HYPERDRIVE.connectionString, { max: 2 });
    const minute = new Date(event.scheduledTime).getUTCMinutes();
    const google = minute % 15 === 0 ? await googleFor(env) : null;
    ctx.waitUntil(
      releaseHeldEmails(sql, servicesFor(env).sender)
        .then((r) => {
          if (r.released || r.failed.length) console.log('held emails', JSON.stringify(r));
        })
        .then(async () => {
          if (!google) return;
          const r = await syncDue(sql, { google }, env.APP_ORIGIN);
          if (r.synced || r.failed) console.log('calendar sync', JSON.stringify(r));
        })
        .finally(() => sql.end()),
    );
  },
} satisfies ExportedHandler<Env>;
