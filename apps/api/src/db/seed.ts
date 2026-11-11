import type { Sql } from './client';

export interface SeedTenantInput {
  name: string;
  slug: string;
  owner: { email: string; name: string };
  /** First job number to hand out (LSE continues from 122). */
  nextJobNumber?: number;
  /** First quote number (Q-0001 unless legacy quotes are imported). */
  nextQuoteNumber?: number;
}

export interface SeededTenant {
  tenantId: string;
  userId: string;
}

/**
 * Creates a business, its owner and default number sequences. Runs as the schema owner,
 * because creating tenants is a platform action, not something a tenant's app user can do.
 */
export async function seedTenant(sql: Sql, input: SeedTenantInput): Promise<SeededTenant> {
  return sql.begin(async (tx) => {
    const [tenant] = await tx<{ id: string }[]>`
      INSERT INTO tenants (name, slug) VALUES (${input.name}, ${input.slug}) RETURNING id`;
    const [user] = await tx<{ id: string }[]>`
      INSERT INTO users (email, name) VALUES (${input.owner.email.toLowerCase()}, ${input.owner.name})
      ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id`;
    await tx`INSERT INTO memberships (tenant_id, user_id, role) VALUES (${tenant!.id}, ${user!.id}, 'owner')`;
    await tx`
      INSERT INTO number_sequences (tenant_id, kind, prefix, padding, next_value, gaps_allowed) VALUES
        (${tenant!.id}, 'quote', 'Q-', 4, ${input.nextQuoteNumber ?? 1}, true),
        (${tenant!.id}, 'job', '', 0, ${input.nextJobNumber ?? 1}, true),
        (${tenant!.id}, 'invoice', '', 0, 1, false),
        (${tenant!.id}, 'credit_note', 'CN-', 4, 1, false)`;
    return { tenantId: tenant!.id, userId: user!.id };
  }) as Promise<SeededTenant>;
}
