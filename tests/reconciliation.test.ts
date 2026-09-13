import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import { idempotencyKeys, orders } from '../src/db/schema.ts';
import { failAndReleaseStock, markPaid } from '../src/domain/order-settlement.ts';
import {
  reconcilePendingOrders,
  startReconciler,
} from '../src/domain/reconciliation.ts';
import { MockPaymentGateway } from '../src/services/payments.ts';
import {
  buildTestApp,
  closeDatabase,
  db,
  LOST_RESPONSE_CARD,
  orderPayload,
  resetDatabase,
  stockOf,
  TIMEOUT_CARD,
} from './helpers.ts';

type LogEntry = { level: 'info' | 'warn' | 'error'; message: string };

class RecordingLogger {
  readonly entries: LogEntry[] = [];
  info(_context: Record<string, unknown>, message: string) {
    this.entries.push({ level: 'info', message });
  }
  warn(_context: Record<string, unknown>, message: string) {
    this.entries.push({ level: 'warn', message });
  }
  error(_context: Record<string, unknown>, message: string) {
    this.entries.push({ level: 'error', message });
  }
}

/** The gateway is up for charging but cannot be reached for lookups. */
class UnreachableLookupGateway extends MockPaymentGateway {
  override async findCharge(): Promise<null> {
    return await Promise.reject(new Error('gateway unreachable'));
  }
}

const OPTIONS = { olderThanMs: 60_000, batchSize: 50 };

/**
 * Places an order whose charge outcome is unknown, the way it happens for
 * real: through the endpoint, with a card that times out.
 */
async function placeStuckOrder(
  gateway: MockPaymentGateway,
  key: string,
  card: string,
  quantity = 2,
): Promise<string> {
  const app = await buildTestApp(gateway);
  const response = await app.inject({
    method: 'POST',
    url: '/orders',
    headers: { 'idempotency-key': key },
    payload: orderPayload({
      items: [{ sku: 'BRK-20A', quantity }],
      cardNumber: card,
    }),
  });
  assert.equal(response.statusCode, 504);

  const [record] = await db
    .select({ orderId: idempotencyKeys.orderId })
    .from(idempotencyKeys)
    .where(eq(idempotencyKeys.key, key));
  assert.ok(record?.orderId, 'the key should already be linked to its order');
  return record.orderId;
}

/** Makes an order look like it has been stuck for an hour. */
async function age(orderId: string): Promise<void> {
  await db.execute(
    sql`update orders set updated_at = now() - interval '1 hour' where id = ${orderId}::uuid`,
  );
}

async function statusOf(orderId: string) {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  assert.ok(order);
  return order;
}

const replay = async (gateway: MockPaymentGateway, key: string, card: string) => {
  const app = await buildTestApp(gateway);
  return await app.inject({
    method: 'POST',
    url: '/orders',
    headers: { 'idempotency-key': key },
    payload: orderPayload({ items: [{ sku: 'BRK-20A', quantity: 2 }], cardNumber: card }),
  });
};

after(closeDatabase);

describe('reconciliation', () => {
  beforeEach(resetDatabase);

  /**
   * The charge went through and only the response was lost. Releasing the
   * stock here would take the customer's money for an order that no longer
   * exists; the gateway says the charge is there, so the order is paid.
   */
  it('confirms an order whose charge did go through', async () => {
    const gateway = new MockPaymentGateway();
    const before = await stockOf('Newark NJ', 'BRK-20A');
    const orderId = await placeStuckOrder(gateway, 'lost-response-key', LOST_RESPONSE_CARD);
    await age(orderId);

    const report = await reconcilePendingOrders(
      { db, payments: gateway, logger: new RecordingLogger() },
      OPTIONS,
    );

    assert.equal(report.paid, 1);
    const order = await statusOf(orderId);
    assert.equal(order.status, 'paid');
    assert.match(order.paymentId ?? '', /^pay_/);
    // The units stay with the customer who paid for them.
    assert.equal(await stockOf('Newark NJ', 'BRK-20A'), before - 2);

    // The client that saw a timeout can now retrieve the real outcome.
    const retried = await replay(gateway, 'lost-response-key', LOST_RESPONSE_CARD);
    assert.equal(retried.statusCode, 201);
    assert.equal(retried.json().id, orderId);
    assert.equal(retried.json().status, 'paid');
    assert.equal(retried.json().warehouse.name, 'Newark NJ');
  });

  it('cancels an order the gateway has no charge for, and returns its stock', async () => {
    const gateway = new MockPaymentGateway();
    const before = await stockOf('Newark NJ', 'BRK-20A');
    const orderId = await placeStuckOrder(gateway, 'never-charged-key', TIMEOUT_CARD);
    assert.equal(await stockOf('Newark NJ', 'BRK-20A'), before - 2);
    await age(orderId);

    const report = await reconcilePendingOrders(
      { db, payments: gateway, logger: new RecordingLogger() },
      OPTIONS,
    );

    assert.equal(report.released, 1);
    assert.equal((await statusOf(orderId)).status, 'payment_failed');
    assert.equal(await stockOf('Newark NJ', 'BRK-20A'), before);

    const retried = await replay(gateway, 'never-charged-key', TIMEOUT_CARD);
    assert.equal(retried.statusCode, 402);
    assert.equal(retried.json().error.code, 'payment_not_completed');

    // A second pass finds nothing left to do.
    await age(orderId);
    const again = await reconcilePendingOrders(
      { db, payments: gateway, logger: new RecordingLogger() },
      OPTIONS,
    );
    assert.equal(again.claimed, 0);
    assert.equal(await stockOf('Newark NJ', 'BRK-20A'), before);
  });

  /**
   * A recent order may still have its charge on the way to the gateway.
   * Asking now would be told "no charge" and cancel an order about to be paid.
   */
  it('leaves orders younger than the threshold alone', async () => {
    const gateway = new MockPaymentGateway();
    const orderId = await placeStuckOrder(gateway, 'too-recent-key', TIMEOUT_CARD);

    const report = await reconcilePendingOrders(
      { db, payments: gateway, logger: new RecordingLogger() },
      OPTIONS,
    );

    assert.equal(report.claimed, 0);
    assert.equal((await statusOf(orderId)).status, 'pending_payment');
  });

  /** Not knowing is not an answer. The order waits for the next pass. */
  it('keeps an order pending while the gateway cannot be asked', async () => {
    const gateway = new UnreachableLookupGateway();
    const before = await stockOf('Newark NJ', 'BRK-20A');
    const orderId = await placeStuckOrder(gateway, 'unreachable-key', TIMEOUT_CARD);
    await age(orderId);

    const logger = new RecordingLogger();
    const report = await reconcilePendingOrders(
      { db, payments: gateway, logger },
      OPTIONS,
    );

    assert.equal(report.unresolved, 1);
    const order = await statusOf(orderId);
    assert.equal(order.status, 'pending_payment');
    assert.equal(order.reconciliationAttempts, 1);
    assert.equal(await stockOf('Newark NJ', 'BRK-20A'), before - 2);
    assert.ok(logger.entries.some((entry) => entry.level === 'warn'));
  });

  it('escalates an order the gateway keeps failing to answer about', async () => {
    const gateway = new UnreachableLookupGateway();
    const orderId = await placeStuckOrder(gateway, 'escalation-key', TIMEOUT_CARD);
    await db.execute(
      sql`update orders set reconciliation_attempts = 10 where id = ${orderId}::uuid`,
    );
    await age(orderId);

    const logger = new RecordingLogger();
    await reconcilePendingOrders({ db, payments: gateway, logger }, OPTIONS);

    assert.ok(
      logger.entries.some(
        (entry) => entry.level === 'error' && entry.message.includes('needs attention'),
      ),
    );
  });

  /**
   * Every replica runs reconciliation. Two passes over the same stuck orders
   * must settle each of them exactly once, and return each unit exactly once.
   */
  it('settles each order once when passes overlap', async () => {
    const gateway = new MockPaymentGateway();
    const before = await stockOf('Newark NJ', 'BRK-20A');

    const orderIds: string[] = [];
    for (let i = 0; i < 6; i++) {
      orderIds.push(await placeStuckOrder(gateway, `overlap-key-${i}`, TIMEOUT_CARD, 1));
    }
    for (const id of orderIds) await age(id);

    const deps = { db, payments: gateway, logger: new RecordingLogger() };
    const [first, second] = await Promise.all([
      reconcilePendingOrders(deps, OPTIONS),
      reconcilePendingOrders(deps, OPTIONS),
    ]);

    assert.equal(first.claimed + second.claimed, 6);
    assert.equal(first.released + second.released, 6);
    assert.equal(await stockOf('Newark NJ', 'BRK-20A'), before);
  });

  it('runs on a schedule and stops cleanly', async () => {
    const gateway = new MockPaymentGateway();
    const orderId = await placeStuckOrder(gateway, 'scheduled-key', TIMEOUT_CARD);
    await age(orderId);

    const reconciler = startReconciler(
      { db, payments: gateway, logger: new RecordingLogger() },
      { ...OPTIONS, intervalMs: 25 },
    );

    const deadline = Date.now() + 5_000;
    while ((await statusOf(orderId)).status === 'pending_payment') {
      assert.ok(Date.now() < deadline, 'the scheduler never reconciled the order');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await reconciler.stop();

    assert.equal((await statusOf(orderId)).status, 'payment_failed');
  });
});

describe('settlement transitions', () => {
  beforeEach(resetDatabase);

  /**
   * The race reconciliation introduces: a charge confirmed late by the
   * original request must not resurrect an order already cancelled, and a
   * second cancellation must not return its stock twice.
   */
  it('refuses to move an order that is no longer pending', async () => {
    const gateway = new MockPaymentGateway();
    const before = await stockOf('Newark NJ', 'BRK-20A');
    const orderId = await placeStuckOrder(gateway, 'transition-guard-key', TIMEOUT_CARD);

    await db.transaction(async (tx) => {
      assert.ok(await failAndReleaseStock(tx, orderId, 'cancelled'));
    });

    await db.transaction(async (tx) => {
      assert.equal(await markPaid(tx, orderId, 'pay_late'), null);
      assert.equal(await failAndReleaseStock(tx, orderId, 'again'), null);
    });

    assert.equal((await statusOf(orderId)).status, 'payment_failed');
    assert.equal(await stockOf('Newark NJ', 'BRK-20A'), before);
  });
});
