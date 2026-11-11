/** Local defaults match tools/devdb.mjs. Never used in production (Workers read bindings). */
export const DEV_DB_PORT = process.env.DEVDB_PORT ?? '54329';
export const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ?? `postgres://postgres:postgres@127.0.0.1:${DEV_DB_PORT}/lse_dev`;
export const APP_URL =
  process.env.DATABASE_URL ?? `postgres://lse_app:lse_app@127.0.0.1:${DEV_DB_PORT}/lse_dev`;
