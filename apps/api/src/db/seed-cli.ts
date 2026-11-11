// Seeds the LOCAL dev database with the LSE business and clearly fictional demo data.
// Never point this at production: it refuses unless the database is on localhost.
// `pnpm db:seed -- --reset` rebuilds the local database and seeds it again.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDemoScript } from '@lse/shared';
import { createApp } from '../app';
import { createSql } from './client';
import { migrate } from './migrate';
import { seedTenant } from './seed';
import { ADMIN_URL, APP_URL } from '../env';

const here = path.dirname(fileURLToPath(import.meta.url));
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(ADMIN_URL))
  throw new Error('Refusing to seed a non-local database');

const admin = createSql(ADMIN_URL, { max: 1 });
const appSql = createSql(APP_URL, { max: 2 });
try {
  if (process.argv.includes('--reset')) {
    // Local only (guarded above): wipe the schema and rebuild it from the migrations.
    await admin.unsafe(
      'DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO app_user;',
    );
  }
  await migrate(admin, path.resolve(here, '../../migrations'), console.log);
  const [existing] = await admin<{ userId: string }[]>`
    SELECT m.user_id FROM tenants t JOIN memberships m ON m.tenant_id = t.id AND m.role = 'owner' WHERE t.slug = 'lse'`;
  let userId = existing?.userId;
  if (!userId) {
    const t = await seedTenant(admin, {
      name: 'Little Sark Electric',
      slug: 'lse',
      owner: { email: 'owner@lse.example', name: 'Joe' },
      nextJobNumber: 122,
      nextQuoteNumber: 1,
    });
    userId = t.userId;
    const app = createApp({ getSql: () => appSql, authMode: 'dev', devUserId: userId });
    const call = async (method: string, p: string, body?: unknown) => {
      const res = await app.request(`/api${p}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${await res.text()}`);
      return res.json();
    };
    await runDemoScript(
      (p, b) => call('POST', p, b),
      (p, b) => call('PATCH', p, b),
    );
    console.log('Seeded demo data for Little Sark Electric');
  }
  writeFileSync(path.resolve(here, '../../.dev.vars'), `AUTH_MODE=dev\nDEV_USER_ID=${userId}\n`);
  console.log(`DEV_USER_ID=${userId} (written to apps/api/.dev.vars)`);
} finally {
  await Promise.all([admin.end(), appSql.end()]);
}
