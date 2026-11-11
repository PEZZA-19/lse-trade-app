#!/usr/bin/env node
// Local Postgres 17 for development and tests, using the embedded-postgres binaries from npm.
// No system install or cloud account needed. Data lives in ./.devdb (git-ignored).
//
//   node tools/devdb.mjs start   # init (first run), start, create databases and roles
//   node tools/devdb.mjs stop
//   node tools/devdb.mjs status
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, '.devdb');
const dataDir = path.join(dir, 'data');
const port = process.env.DEVDB_PORT ?? '54329';
const getBinaries = (
  await import(pathToFileURL(path.join(root, 'node_modules/embedded-postgres/dist/binary.js')).href)
).default;
const { initdb, pg_ctl } = await getBinaries();

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0 && !opts.allowFail) {
    console.error(`devdb: ${path.basename(cmd)} failed (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
  return r;
}

function isRunning() {
  return spawnSync(pg_ctl, ['status', '-D', dataDir], { stdio: 'ignore' }).status === 0;
}

function psql(sql, db = 'postgres') {
  // Use the bundled client if present, otherwise any psql on PATH.
  return run(
    'psql',
    [
      '-h',
      '127.0.0.1',
      '-p',
      port,
      '-U',
      'postgres',
      '-d',
      db,
      '-v',
      'ON_ERROR_STOP=1',
      '-qc',
      sql,
    ],
    {
      env: { ...process.env, PGPASSWORD: 'postgres' },
    },
  );
}

const cmd = process.argv[2] ?? 'start';

if (cmd === 'start') {
  if (!existsSync(path.join(dataDir, 'PG_VERSION'))) {
    mkdirSync(dir, { recursive: true });
    const pw = path.join(dir, 'pw');
    writeFileSync(pw, 'postgres\n');
    run(initdb, [
      '-D',
      dataDir,
      '-U',
      'postgres',
      '--pwfile',
      pw,
      '--auth=scram-sha-256',
      '-E',
      'UTF8',
      '--locale=C',
    ]);
  }
  if (!isRunning()) {
    run(pg_ctl, [
      'start',
      '-D',
      dataDir,
      '-w',
      '-l',
      path.join(dir, 'postgres.log'),
      '-o',
      `-p ${port} -c listen_addresses=127.0.0.1 -k ${dir}`,
    ]);
  }
  // Idempotent setup: an app login role that is NOT a superuser, so row-level security applies to it.
  psql(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN CREATE ROLE app_user NOLOGIN; END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'lse_app') THEN CREATE ROLE lse_app LOGIN PASSWORD 'lse_app' IN ROLE app_user; END IF;
  END $$;`);
  for (const db of ['lse_dev', 'lse_test']) {
    const exists = spawnSync(
      'psql',
      [
        '-h',
        '127.0.0.1',
        '-p',
        port,
        '-U',
        'postgres',
        '-tAc',
        `SELECT 1 FROM pg_database WHERE datname='${db}'`,
      ],
      {
        env: { ...process.env, PGPASSWORD: 'postgres' },
        encoding: 'utf8',
      },
    ).stdout.trim();
    if (exists !== '1') psql(`CREATE DATABASE ${db}`);
  }
  console.log(`devdb: Postgres running on 127.0.0.1:${port} (databases lse_dev, lse_test)`);
} else if (cmd === 'stop') {
  if (isRunning()) run(pg_ctl, ['stop', '-D', dataDir, '-m', 'fast']);
  console.log('devdb: stopped');
} else if (cmd === 'status') {
  console.log(isRunning() ? `devdb: running on port ${port}` : 'devdb: not running');
} else {
  console.error(`Unknown command: ${cmd}`);
  process.exit(1);
}
