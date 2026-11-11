import { randomUUID } from 'node:crypto';
import { afterAll } from 'vitest';
import { createSql, type Sql } from '../src/db/client';
import { seedTenant, type SeededTenant } from '../src/db/seed';
import { DEV_DB_PORT } from '../src/env';

const base = `127.0.0.1:${DEV_DB_PORT}/lse_test`;

/** Owner connection (bypasses RLS as table owner): for seeding only. */
export const adminSql: Sql = createSql(`postgres://postgres:postgres@${base}`, { max: 2 });
/** App connection (member of app_user): what the API uses, RLS enforced. */
export const appSql: Sql = createSql(`postgres://lse_app:lse_app@${base}`, { max: 20 });

afterAll(async () => {
  await Promise.all([adminSql.end(), appSql.end()]);
});

export async function newTenant(opts: { nextJobNumber?: number } = {}): Promise<SeededTenant> {
  const suffix = randomUUID().slice(0, 8);
  return seedTenant(adminSql, {
    name: `Test Electrical ${suffix}`,
    slug: `test-${suffix}`,
    owner: { email: `owner-${suffix}@example.test`, name: 'Test Owner' },
    nextJobNumber: opts.nextJobNumber ?? 122,
  });
}
