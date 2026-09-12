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
  // A transaction left open holds its locks until something closes it. If a
  // bug or a hung await ever gets us there, Postgres ends the session rather
  // than letting one stuck request block a SKU indefinitely.
  options: [
    `-c lock_timeout=${config.DB_LOCK_TIMEOUT_MS}`,
    `-c idle_in_transaction_session_timeout=${config.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS}`,
  ].join(' '),
});

/**
 * Postgres closes idle connections when it restarts, fails over, or is simply
 * restarted by an operator. node-postgres surfaces that as an `error` event on
 * the pool, and an EventEmitter with no error listener throws — which would
 * take the whole process down every time the database is bounced.
 *
 * The pool discards the broken client on its own and opens a fresh one on the
 * next query, so there is nothing to do here but record it and stay alive.
 * This is deliberately not the Fastify logger: the connection layer should not
 * depend on the web layer, and this has to be attached the moment the pool
 * exists, before any request can be served.
 */
const reportConnectionFailure = (error: Error, scope: string): void => {
  process.stderr.write(
    `${JSON.stringify({
      level: 50,
      time: Date.now(),
      msg: `${scope} database connection failed; the pool will reconnect`,
      err: { type: error.name, message: error.message },
    })}\n`,
  );
};

pool.on('error', (error) => {
  reportConnectionFailure(error, 'idle');
});

/**
 * The pool only speaks for its *idle* clients. A client checked out for a
 * transaction emits its failure on itself, so losing the database mid
 * transaction — a hard kill, a network partition — still reached the process
 * as an uncaught exception. The in-flight query rejects either way and the
 * request gets its 503; this listener is what stops the process dying with it.
 */
pool.on('connect', (client) => {
  client.on('error', (error) => {
    reportConnectionFailure(error, 'in-use');
  });
});

export const db = drizzle(pool, { schema });

export type Database = typeof db;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
