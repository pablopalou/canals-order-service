import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { config } from '../config.ts';
import * as schema from './schema.ts';

/**
 * node-postgres parses int8 as a string by default to avoid silent precision
 * loss. Every bigint we read is a count that fits in a JS number, so parsing
 * it as a number keeps call sites honest.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: config.DB_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  // A request that reserves stock holds row locks; a query that hangs would
  // hold them indefinitely, so we bound it well under the HTTP timeout.
  statement_timeout: config.DB_STATEMENT_TIMEOUT_MS,
  // Separately from the statement budget, never queue behind a row lock for
  // more than a few seconds. Under heavy contention on one popular SKU,
  // failing fast with a retryable answer beats every worker blocking on the
  // same row until the pool is exhausted.
  options: `-c lock_timeout=${config.DB_LOCK_TIMEOUT_MS}`,
});

export const db = drizzle(pool, { schema });

export type Database = typeof db;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
