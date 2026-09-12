import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';

const run = promisify(execFile);

const ADMIN_URL =
  process.env.ADMIN_DATABASE_URL ??
  'postgres://orders:orders@localhost:5433/orders';
const TEST_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://orders:orders@localhost:5433/orders_test';

const databaseName = new URL(TEST_URL).pathname.slice(1);

/**
 * Creates the test database if it does not exist and brings it up to the
 * latest migration, so `npm test` works from a clean checkout with nothing
 * but `docker compose up -d` beforehand.
 */
export async function setup(): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    const { rowCount } = await admin.query(
      'select 1 from pg_database where datname = $1',
      [databaseName],
    );
    if (rowCount === 0) {
      // Identifier cannot be parameterised; it comes from our own config.
      await admin.query(`create database "${databaseName}"`);
    }
  } finally {
    await admin.end();
  }

  await run('node', ['--experimental-strip-types', 'src/db/migrate.ts'], {
    env: { ...process.env, DATABASE_URL: TEST_URL },
  });
}
