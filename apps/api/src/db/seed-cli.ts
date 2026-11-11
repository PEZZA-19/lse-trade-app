// Seeds the LOCAL dev database with the LSE business and clearly fictional demo data.
// Never point this at production: it refuses unless the database is on localhost.
// `pnpm db:seed -- --reset` rebuilds the local database and seeds it again.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDemoScript } from '@lse/shared';
import { createApp } from '../app';
import { DEFAULT_ORIGIN, signIn } from '../dev/session-client';
import { ConsoleMailer } from '../lib/mailer';
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
  if (!existing) {
    await seedTenant(admin, {
      name: 'Little Sark Electric',
      slug: 'lse',
      owner: { email: 'owner@lse.example', name: 'Joe' },
      staff: [{ email: 'sam@lse.example', name: 'Sam Spark' }], // fictional
      nextJobNumber: 122,
      nextQuoteNumber: 1,
      // Fictional details (the real ones are entered by Joe in Settings).
      details: {
        address: 'Demo Workshop, La Sablonnerie Lane, Little Sark (fictional)',
        phone: '01481 000000',
        email: 'owner@lse.example',
        labourRatePence: 4500,
      },
    });
    const mailer = new ConsoleMailer(() => {});
    const app = createApp({ getSql: () => appSql, auth: { mailer, appOrigin: DEFAULT_ORIGIN } });
    const client = await signIn(app, mailer, 'owner@lse.example');
    const call = async (method: string, p: string, body?: unknown) => {
      const res = await client.request(method, `/api${p}`, body);
      if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${await res.text()}`);
      return res.json();
    };
    await runDemoScript(
      (p, b) => call('POST', p, b),
      (p, b) => call('PATCH', p, b),
      (p) => call('GET', p),
    );
    console.log('Seeded demo data for Little Sark Electric');
  }
  console.log(
    'Sign in as owner@lse.example: run `pnpm sign-in-link` after requesting a link in the app.',
  );
} finally {
  await Promise.all([admin.end(), appSql.end()]);
}
