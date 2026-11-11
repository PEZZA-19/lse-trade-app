import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Sql } from './client';

/**
 * Applies migrations/NNNN_name.sql in order, each in its own transaction, recording them in
 * schema_migrations. Must run as the schema owner (not the app role). Node-only.
 */
export async function migrate(sql: Sql, dir: string, log: (m: string) => void = () => {}): Promise<string[]> {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  const done = new Set((await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const body = await readFile(path.join(dir, file), 'utf8');
    await sql.begin(async (tx) => {
      // Serialise concurrent migrators (e.g. parallel test workers).
      await tx`SELECT pg_advisory_xact_lock(727274)`;
      const [already] = await tx`SELECT 1 FROM schema_migrations WHERE name = ${file}`;
      if (already) return;
      await tx.unsafe(body);
      await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
      applied.push(file);
      log(`applied ${file}`);
    });
  }
  return applied;
}
