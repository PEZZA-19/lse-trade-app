// Local development server (Node). Production runs src/worker.ts on Cloudflare Workers.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { createApp } from './app';
import { createSql } from './db/client';
import { APP_URL } from './env';
import { ConsoleMailer } from './lib/mailer';

// Same file Wrangler reads for local vars.
if (existsSync('.dev.vars')) {
  for (const line of readFileSync('.dev.vars', 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2];
  }
}

/** Where the last dev sign-in link is written (git-ignored), for `pnpm sign-in-link` and e2e tests. */
export const DEV_LINK_FILE = '.dev-sign-in-link';

const sql = createSql(APP_URL);
const port = Number(process.env.PORT ?? 8787);
const appOrigin = process.env.APP_ORIGIN ?? 'http://localhost:5173';
// No email is ever sent in development: the link is printed and written to a local file.
const mailer = new ConsoleMailer((line) => {
  console.log(line);
});
const send = mailer.sendMagicLink.bind(mailer);
mailer.sendMagicLink = async (mail) => {
  await send(mail);
  writeFileSync(DEV_LINK_FILE, `${mail.to} ${mail.link}\n`, { mode: 0o600 });
};

const app = createApp({
  getSql: () => sql,
  auth: {
    mailer,
    appOrigin,
    extraOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://127.0.0.1:4173'],
  },
  corsOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'],
});

serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
  console.log(
    `LSE API listening on http://127.0.0.1:${info.port} (sign-in links point at ${appOrigin})`,
  );
});
