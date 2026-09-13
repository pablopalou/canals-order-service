import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import { idempotencyKeys, orders } from '../src/db/schema.ts';
import { purgeExpiredIdempotencyKeys } from '../src/domain/idempotency-retention.ts';
import {
  buildTestApp,
  closeDatabase,
  db,
  orderPayload,
  resetDatabase,
  TIMEOUT_CARD,
} from './helpers.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const OPTIONS = { retentionMs: DAY_MS, batchSize: 1_000 };

const place = async (key: string, card?: string) => {
  const app = await buildTestApp();
  return await app.inject({
    method: 'POST',
    url: '/orders',
    headers: { 'idempotency-key': key },
    payload: orderPayload({ items: [{ sku: 'BRK-20A', quantity: 1 }], cardNumber: card }),
  });
};

const backdate = async (key: string, hours: number) => {
  await db.execute(
    sql`update idempotency_keys set created_at = now() - (${hours}::integer * interval '1 hour') where key = ${key}`,
  );
};

const keyExists = async (key: string) =>
  (await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key)))
    .length === 1;

after(closeDatabase);

/**
 * One key is written per checkout. Without retention the table grows forever
 * on the hottest write path in the service.
 */
describe('idempotency key retention', () => {
  beforeEach(resetDatabase);

  it('removes settled keys older than the window and keeps recent ones', async () => {
    await place('retention-old-key');
    await place('retention-recent-key');
    await backdate('retention-old-key', 25);
    await backdate('retention-recent-key', 1);

    const deleted = await purgeExpiredIdempotencyKeys(db, OPTIONS);

    assert.equal(deleted, 1);
    assert.equal(await keyExists('retention-old-key'), false);
    assert.equal(await keyExists('retention-recent-key'), true);
    // Only the key goes; the order it pointed at is untouched.
    assert.equal((await db.select().from(orders)).length, 2);
  });

  /**
   * An unsettled key belongs to an order whose charge outcome is unknown.
   * Reconciliation needs it to ask the gateway, however old it is.
   */
  it('never removes a key whose outcome is still unknown', async () => {
    assert.equal((await place('retention-pending-key', TIMEOUT_CARD)).statusCode, 504);
    await backdate('retention-pending-key', 72);

    await purgeExpiredIdempotencyKeys(db, OPTIONS);

    assert.equal(await keyExists('retention-pending-key'), true);
  });

  it('works through a backlog larger than one batch', async () => {
    for (let i = 0; i < 5; i++) {
      await place(`retention-backlog-key-${i}`);
      await backdate(`retention-backlog-key-${i}`, 30);
    }

    const deleted = await purgeExpiredIdempotencyKeys(db, {
      retentionMs: DAY_MS,
      batchSize: 2,
    });

    assert.equal(deleted, 5);
  });

  /**
   * The trade-off, stated as a test so nobody mistakes it for a bug: a key
   * replayed after the window is a new request. A client retrying a day later
   * is not retrying, it is placing an order.
   */
  it('treats a key replayed after the window as a new request', async () => {
    const first = await place('retention-replay-key');
    await backdate('retention-replay-key', 25);
    await purgeExpiredIdempotencyKeys(db, OPTIONS);

    const second = await place('retention-replay-key');

    assert.equal(second.statusCode, 201);
    assert.notEqual(second.json().id, first.json().id);
  });
});
