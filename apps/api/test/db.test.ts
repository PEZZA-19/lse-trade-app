import { describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/client';
import { appSql, newTenant } from './helpers';

const ctx = (t: { tenantId: string; userId: string }) => ({
  tenantId: t.tenantId,
  userId: t.userId,
});

async function allocate(t: { tenantId: string; userId: string }, kind: string) {
  return withTenant(appSql, ctx(t), async (tx) => {
    const [row] = await tx<
      { value: number; formatted: string }[]
    >`SELECT * FROM allocate_number(${kind})`;
    return row!;
  });
}

describe('number allocation', () => {
  it('formats quotes as Q-0001 and continues jobs from 122', async () => {
    const t = await newTenant({ nextJobNumber: 122 });
    expect((await allocate(t, 'quote')).formatted).toBe('Q-0001');
    expect((await allocate(t, 'quote')).formatted).toBe('Q-0002');
    expect((await allocate(t, 'job')).formatted).toBe('122');
    expect((await allocate(t, 'job')).formatted).toBe('123');
  });

  it('never hands out the same number twice under concurrency', async () => {
    const t = await newTenant();
    const results = await Promise.all(Array.from({ length: 50 }, () => allocate(t, 'job')));
    const values = results.map((r) => r.value).sort((a, b) => a - b);
    expect(new Set(values).size).toBe(50);
    expect(values[0]).toBe(122);
    expect(values[49]).toBe(171); // contiguous: no gaps when nothing rolls back
  });

  it('releases the number when the transaction rolls back (no gap)', async () => {
    const t = await newTenant();
    await expect(
      withTenant(appSql, ctx(t), async (tx) => {
        await tx`SELECT * FROM allocate_number('invoice')`;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((await allocate(t, 'invoice')).formatted).toBe('1');
  });

  it('keeps sequences separate per business', async () => {
    const [a, b] = await Promise.all([newTenant(), newTenant()]);
    await allocate(a, 'quote');
    await allocate(a, 'quote');
    expect((await allocate(b, 'quote')).formatted).toBe('Q-0001');
  });

  it('fails clearly when no tenant is set', async () => {
    await expect(appSql`SELECT * FROM allocate_number('quote')`).rejects.toThrow(
      /No quote number sequence/,
    );
  });
});

describe('row-level security', () => {
  it('hides other businesses customers and blocks cross-tenant writes', async () => {
    const [a, b] = await Promise.all([newTenant(), newTenant()]);
    const [cust] = await withTenant(
      appSql,
      ctx(a),
      (tx) =>
        tx<
          { id: string }[]
        >`INSERT INTO customers (tenant_id, name) VALUES (${a.tenantId}, 'Alice') RETURNING id`,
    );
    const seenByB = await withTenant(
      appSql,
      ctx(b),
      (tx) => tx`SELECT * FROM customers WHERE id = ${cust!.id}`,
    );
    expect(seenByB).toHaveLength(0);
    await expect(
      withTenant(
        appSql,
        ctx(b),
        (tx) => tx`INSERT INTO customers (tenant_id, name) VALUES (${a.tenantId}, 'Sneaky')`,
      ),
    ).rejects.toThrow(/row-level security/);
    const updated = await withTenant(
      appSql,
      ctx(b),
      (tx) => tx`UPDATE customers SET name = 'x' WHERE id = ${cust!.id}`,
    );
    expect(updated.count).toBe(0);
  });

  it('sees nothing at all without a tenant', async () => {
    const t = await newTenant();
    await withTenant(
      appSql,
      ctx(t),
      (tx) => tx`INSERT INTO customers (tenant_id, name) VALUES (${t.tenantId}, 'Bob')`,
    );
    expect(await appSql`SELECT * FROM customers`).toHaveLength(0);
  });

  it('prevents a site pointing at another tenant customer', async () => {
    const [a, b] = await Promise.all([newTenant(), newTenant()]);
    const [cust] = await withTenant(
      appSql,
      ctx(a),
      (tx) =>
        tx<
          { id: string }[]
        >`INSERT INTO customers (tenant_id, name) VALUES (${a.tenantId}, 'Alice') RETURNING id`,
    );
    await expect(
      withTenant(
        appSql,
        ctx(b),
        (tx) =>
          tx`INSERT INTO sites (tenant_id, customer_id, address) VALUES (${b.tenantId}, ${cust!.id}, 'Somewhere')`,
      ),
    ).rejects.toThrow(/foreign key/);
  });
});

describe('single conversion guarantee', () => {
  it('rejects a second job from the same quote at the database level', async () => {
    const t = await newTenant();
    await expect(
      withTenant(appSql, ctx(t), async (tx) => {
        const [c] = await tx<
          { id: string }[]
        >`INSERT INTO customers (tenant_id, name) VALUES (${t.tenantId}, 'C') RETURNING id`;
        const [q] = await tx<{ id: string }[]>`
          INSERT INTO quotes (tenant_id, number, customer_id) VALUES (${t.tenantId}, 'Q-0001', ${c!.id}) RETURNING id`;
        await tx`INSERT INTO jobs (tenant_id, number, customer_id, title, source_quote_id, source_quote_revision, stage_id)
                 VALUES (${t.tenantId}, '122', ${c!.id}, 'One', ${q!.id}, 1,
                         (SELECT id FROM job_stages WHERE system_key = 'unassigned'))`;
        await tx`INSERT INTO jobs (tenant_id, number, customer_id, title, source_quote_id, source_quote_revision, stage_id)
                 VALUES (${t.tenantId}, '123', ${c!.id}, 'Two', ${q!.id}, 1,
                         (SELECT id FROM job_stages WHERE system_key = 'unassigned'))`;
      }),
    ).rejects.toThrow(/jobs_source_quote_id_key/);
  });
});
