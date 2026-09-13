import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';

/**
 * Preloaded with `--import` so it runs before any test module, and therefore
 * before src/config.ts reads the environment.
 *
 * Tests use their own database: a failing run must never leave development
 * data in a surprising state.
 */
const TEST_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://orders:orders@localhost:5433/orders_test';
const ADMIN_URL =
  process.env.ADMIN_DATABASE_URL ??
  'postgres://orders:orders@localhost:5433/orders';

process.env.DATABASE_URL = TEST_URL;
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
// Assigned unconditionally, not with ??=: the suite asserts on these values,
// so a developer's own environment (a sourced .env, say) must not change what
// the tests run against. With ??= an empty CORS_ORIGINS in .env silently
// disabled CORS under test, and one CORS test passed without checking anything.
//
// The suite runs requests in parallel against one database and asserts on lock
// contention; a short lock budget keeps that test fast without changing what
// it proves.
process.env.DB_POOL_MAX = '20';
process.env.DB_LOCK_TIMEOUT_MS = '400';
process.env.CORS_ORIGINS = 'https://shop.example.com';

/**
 * Creates the database if needed and migrates it, so `npm test` works from a
 * clean checkout with nothing but `docker compose up -d postgres` beforehand.
 */
const admin = new pg.Client({ connectionString: ADMIN_URL });
await admin.connect();
try {
  const databaseName = new URL(TEST_URL).pathname.slice(1);
  const { rowCount } = await admin.query(
    'select 1 from pg_database where datname = $1',
    [databaseName],
  );
  if (rowCount === 0) {
    // Identifiers cannot be parameterised; this one comes from our own config.
    await admin.query(`create database "${databaseName}"`);
  }
} finally {
  await admin.end();
}

await promisify(execFile)('node', ['src/db/migrate.ts'], {
  env: { ...process.env, DATABASE_URL: TEST_URL },
});
