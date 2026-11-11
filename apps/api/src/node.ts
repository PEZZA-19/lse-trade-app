// Local development server (Node). Production runs src/worker.ts on Cloudflare Workers.
import { existsSync, readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { createApp } from './app';
import { createSql } from './db/client';
import { APP_URL } from './env';

// Pick up DEV_USER_ID written by `pnpm db:seed` (same file Wrangler reads).
if (existsSync('.dev.vars')) {
  for (const line of readFileSync('.dev.vars', 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2];
  }
}

const sql = createSql(APP_URL);
const port = Number(process.env.PORT ?? 8787);
const app = createApp({
  getSql: () => sql,
  authMode: 'dev',
  devUserId: process.env.DEV_USER_ID,
  corsOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'],
});

serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
  console.log(`LSE API listening on http://127.0.0.1:${info.port}`);
  if (!process.env.DEV_USER_ID)
    console.log('Tip: run `pnpm db:seed` first; it writes DEV_USER_ID to apps/api/.dev.vars.');
});
