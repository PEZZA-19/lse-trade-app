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

export interface TestTenant extends SeededTenant {
  ownerEmail: string;
}

/** A new business with complete details (pass `incomplete: true` for a fresh, half-set-up one). */
export async function newTenant(
  opts: { nextJobNumber?: number; incomplete?: boolean } = {},
): Promise<TestTenant> {
  const suffix = randomUUID().slice(0, 8);
  const ownerEmail = `owner-${suffix}@example.test`;
  const t = await seedTenant(adminSql, {
    name: `Test Electrical ${suffix}`,
    slug: `test-${suffix}`,
    owner: { email: ownerEmail, name: 'Test Owner' },
    nextJobNumber: opts.nextJobNumber ?? 122,
    details: opts.incomplete
      ? {}
      : { address: '1 Test Lane, Sark', phone: '01481 000000', email: ownerEmail },
  });
  return { ...t, ownerEmail };
}

/** Adds a user to a business with a role. Returns their email. */
export async function addMember(
  tenantId: string,
  role: 'owner' | 'staff' | 'subcontractor' | 'accountant',
  email = `${role}-${randomUUID().slice(0, 8)}@example.test`,
): Promise<string> {
  const [u] = await adminSql<{ id: string }[]>`
    INSERT INTO users (email, name) VALUES (${email}, ${role}) ON CONFLICT (email) DO UPDATE SET name = users.name
    RETURNING id`;
  await adminSql`INSERT INTO memberships (tenant_id, user_id, role) VALUES (${tenantId}, ${u!.id}, ${role})`;
  return email;
}
