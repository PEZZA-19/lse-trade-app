import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSql } from '../src/db/client';
import { migrate } from '../src/db/migrate';
import { DEV_DB_PORT } from '../src/env';

/** Fresh lse_test database per run, migrated as the owner. Requires `pnpm db:start`. */
export default async function setup() {
  const server = createSql(`postgres://postgres:postgres@127.0.0.1:${DEV_DB_PORT}/postgres`, { max: 1 });
  try {
    await server`DROP DATABASE IF EXISTS lse_test WITH (FORCE)`;
    await server`CREATE DATABASE lse_test`;
  } catch (e) {
    throw new Error(`Cannot reach local Postgres on port ${DEV_DB_PORT}. Run \`pnpm db:start\` first.\n${e}`);
  } finally {
    await server.end();
  }
  const admin = createSql(`postgres://postgres:postgres@127.0.0.1:${DEV_DB_PORT}/lse_test`, { max: 1 });
  try {
    await migrate(admin, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations'));
  } finally {
    await admin.end();
  }
}
