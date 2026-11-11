import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSql } from './client';
import { migrate } from './migrate';
import { ADMIN_URL } from '../env';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
const sql = createSql(ADMIN_URL, { max: 1 });
try {
  const applied = await migrate(sql, dir, console.log);
  console.log(applied.length ? `Migrated (${applied.length} applied)` : 'Database is up to date');
} finally {
  await sql.end();
}
