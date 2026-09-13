import { sql } from 'drizzle-orm';
import type { Database } from '../db/client.ts';

export type RetentionOptions = {
  /** Settled keys older than this are deleted. */
  retentionMs: number;
  /** Rows deleted per statement. */
  batchSize: number;
};

/**
 * Deletes idempotency keys that have outlived their purpose.
 *
 * A key exists to cover a client's retry window — seconds to minutes — but
 * one row is written per checkout, forever, so left alone the table grows
 * without bound on the hottest write path in the service. Keys older than the
 * retention window (24 hours by default, as Stripe does) are removed.
 *
 * Two things are never deleted:
 *  - keys with no recorded response, because their order's charge outcome is
 *    still unknown and reconciliation needs the key to ask the gateway;
 *  - anything younger than the window.
 *
 * The trade-off is explicit and deliberate: replaying a key after it has been
 * purged is treated as a new request. A client retrying a day later is not
 * retrying, it is placing an order.
 *
 * Deletes run in bounded batches, each its own short statement, so a large
 * backlog never becomes one long transaction holding locks and generating a
 * burst of WAL.
 */
export async function purgeExpiredIdempotencyKeys(
  db: Database,
  { retentionMs, batchSize }: RetentionOptions,
): Promise<number> {
  let total = 0;

  for (;;) {
    const result = await db.execute(sql`
      delete from idempotency_keys
      where key in (
        select key from idempotency_keys
        where response_status is not null
          and created_at < now() - (${retentionMs}::bigint * interval '1 millisecond')
        limit ${batchSize}::integer
      )
    `);

    const deleted = result.rowCount ?? 0;
    total += deleted;
    if (deleted < batchSize) return total;
  }
}
