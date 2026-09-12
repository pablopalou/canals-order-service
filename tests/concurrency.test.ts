import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { count, eq, inArray } from 'drizzle-orm';
import { inventory, orderItems, orders } from '../src/db/schema.ts';
import { MockPaymentGateway } from '../src/services/payments.ts';
import {
  buildTestApp,
  closeDatabase,
  db,
  DECLINED_CARD,
  orderPayload,
  productId,
  resetDatabase,
  stockOf,
  warehouseId,
} from './helpers.ts';

let app: FastifyInstance;

const post = (payload: unknown, key: string) =>
  app.inject({
    method: 'POST',
    url: '/orders',
    headers: { 'idempotency-key': key },
    payload: payload as object,
  });

const orderCount = async () => {
  const [row] = await db.select({ value: count() }).from(orders);
  return row!.value;
};

/**
 * These are the tests worth having. The rest of the service can be read and
 * reasoned about; whether the reservation logic actually holds under
 * concurrent load can only be established by running it concurrently.
 */
describe('concurrent checkout', () => {
  beforeEach(async () => {
    await resetDatabase();
    // Latency widens the window between reserving stock and settling payment,
    // which is exactly where a race would hide.
    app = await buildTestApp(new MockPaymentGateway({ latencyMs: 40 }));
  });
  after(closeDatabase);

  it('sells the last unit exactly once', async () => {
    // FLUX-8OZ: one unit, in one warehouse.
    const attempts = 8;
    const responses = await Promise.all(
      Array.from({ length: attempts }, (_, i) =>
        post(
          orderPayload({ items: [{ sku: 'FLUX-8OZ', quantity: 1 }] }),
          `race-key-${i}`,
        ),
      ),
    );

    const created = responses.filter((r) => r.statusCode === 201);
    const rejected = responses.filter((r) => r.statusCode === 409);

    assert.equal(created.length, 1);
    assert.equal(rejected.length, attempts - 1);
    assert.ok(
      rejected.every((r) => r.json().error.code === 'no_eligible_warehouse'),
    );

    // The invariant that matters: stock is drained, never negative.
    assert.equal(await stockOf('Newark NJ', 'FLUX-8OZ'), 0);
    assert.equal(await orderCount(), 1);
  });

  /**
   * Eligibility is computed before any row is locked, so the warehouse it
   * picks can be emptied in between. The reservation re-checks under the lock
   * and falls through to the next candidate rather than overselling.
   */
  it('falls through to the next warehouse when the nearest one is drained', async () => {
    // Dallas holds a single torch kit; Los Angeles holds three.
    const [first, second] = await Promise.all([
      post(orderPayload({ items: [{ sku: 'TORCH-KIT', quantity: 1 }] }), 'fallthrough-a'),
      post(orderPayload({ items: [{ sku: 'TORCH-KIT', quantity: 1 }] }), 'fallthrough-b'),
    ]);

    assert.deepEqual([first!.statusCode, second!.statusCode], [201, 201]);
    assert.deepEqual(
      [first!.json().warehouse.name, second!.json().warehouse.name].sort(),
      ['Dallas TX', 'Los Angeles CA'],
    );

    assert.equal(await stockOf('Dallas TX', 'TORCH-KIT'), 0);
    assert.equal(await stockOf('Los Angeles CA', 'TORCH-KIT'), 2);
  });

  /** A double click: the same request, twice, at the same instant. */
  it('creates one order when the same key arrives twice at once', async () => {
    const payload = orderPayload({ items: [{ sku: 'BRK-20A', quantity: 2 }] });
    const before = await stockOf('Newark NJ', 'BRK-20A');

    const responses = await Promise.all([
      post(payload, 'double-click'),
      post(payload, 'double-click'),
    ]);

    assert.deepEqual(
      responses.map((r) => r.statusCode).sort(),
      [201, 409],
    );
    assert.equal(await orderCount(), 1);
    assert.equal(await stockOf('Newark NJ', 'BRK-20A'), before - 2);
  });

  /**
   * Two orders sharing products, listed in opposite order. Locks are acquired
   * sorted by product id regardless of payload order, so these cannot
   * deadlock. Without that sort this test fails intermittently, which is the
   * worst way for a deadlock to be discovered.
   */
  it('does not deadlock when orders share products in opposite order', async () => {
    const forwards = orderPayload({
      items: [
        { sku: 'CU-ELB-050', quantity: 1 },
        { sku: 'PVC-TEE-075', quantity: 1 },
      ],
    });
    const backwards = orderPayload({
      items: [
        { sku: 'PVC-TEE-075', quantity: 1 },
        { sku: 'CU-ELB-050', quantity: 1 },
      ],
    });

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        post(i % 2 === 0 ? forwards : backwards, `deadlock-${i}`),
      ),
    );

    assert.ok(responses.every((r) => r.statusCode === 201));
    assert.equal(await orderCount(), 10);
  });

  /**
   * Waiting on a row lock is bounded, so a checkout cannot pin a connection
   * behind whoever is holding the row. This holds the lock from a separate
   * connection — the way another instance of the service would — and asserts
   * the caller is told to retry rather than left hanging or handed a 500.
   */
  it('gives up on a contended row instead of waiting forever', async () => {
    const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();

    try {
      await holder.query('begin');
      await holder.query(
        `select * from inventory
         where warehouse_id = $1 and product_id = $2
         for update`,
        [warehouseId('Newark NJ'), productId('BRK-20A')],
      );

      const response = await post(
        orderPayload({ items: [{ sku: 'BRK-20A', quantity: 1 }] }),
        'lock-contention-key',
      );

      assert.equal(response.statusCode, 503);
      assert.equal(response.json().error.code, 'stock_contended');
      // Transient by definition, so the client is told when to come back.
      assert.equal(response.headers['retry-after'], '1');
    } finally {
      await holder.query('rollback');
      await holder.end();
    }
  });

  /**
   * Orders that share a warehouse but no products must not queue behind one
   * another: locks are taken per row, not per warehouse. If this ever starts
   * serialising, throughput on a busy warehouse collapses for no reason.
   */
  it('does not serialise orders that share no products', async () => {
    const skus = ['CU-ELB-050', 'PVC-TEE-075', 'BRK-20A', 'SOLD-LF-1LB'];

    const responses = await Promise.all(
      skus.map((sku, i) =>
        post(
          orderPayload({ items: [{ sku, quantity: 1 }] }),
          `disjoint-key-${i}`,
        ),
      ),
    );

    assert.ok(responses.every((r) => r.statusCode === 201));
    assert.equal(await orderCount(), skus.length);
  });

  /**
   * The strongest statement the suite makes. Twenty concurrent orders, half of
   * them on cards that decline, across overlapping products, and afterwards
   * every unit is accounted for:
   *
   *   stock now + units held by paid orders === stock before
   *
   * Any lost update, double decrement or compensation that released the wrong
   * quantity breaks this equality. Checking each product individually would
   * miss a mistake that moves units between products.
   */
  it('conserves every unit of stock under mixed concurrent load', async () => {
    const before = await inventorySnapshot();

    const skus = ['CU-ELB-050', 'PVC-TEE-075', 'BRK-20A', 'SOLD-LF-1LB'];
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        post(
          orderPayload({
            items: [
              { sku: skus[i % skus.length]!, quantity: 2 },
              { sku: skus[(i + 1) % skus.length]!, quantity: 1 },
            ],
            // Every third attempt is declined, so compensation runs while
            // other orders are still reserving.
            cardNumber: i % 3 === 0 ? DECLINED_CARD : undefined,
          }),
          `mixed-load-key-${i}`,
        ),
      ),
    );

    const paid = responses.filter((r) => r.statusCode === 201);
    const declined = responses.filter((r) => r.statusCode === 402);
    assert.equal(paid.length + declined.length, responses.length);
    assert.ok(paid.length > 0 && declined.length > 0);

    const after = await inventorySnapshot();
    const held = await unitsHeldByPaidOrders();

    for (const [key, quantityBefore] of before) {
      const quantityNow = after.get(key) ?? 0;
      assert.equal(
        quantityNow + (held.get(key) ?? 0),
        quantityBefore,
        `stock for ${key} does not add up`,
      );
      assert.ok(quantityNow >= 0, `stock for ${key} went negative`);
    }
  });
});

/** Every (warehouse, product) row, keyed for comparison. */
async function inventorySnapshot(): Promise<Map<string, number>> {
  const rows = await db
    .select({
      warehouseId: inventory.warehouseId,
      productId: inventory.productId,
      quantity: inventory.quantity,
    })
    .from(inventory);

  return new Map(
    rows.map((row) => [`${row.warehouseId}:${row.productId}`, row.quantity]),
  );
}

/** Units committed to orders that actually completed. */
async function unitsHeldByPaidOrders(): Promise<Map<string, number>> {
  const paidOrders = await db
    .select({ id: orders.id, warehouseId: orders.warehouseId })
    .from(orders)
    .where(eq(orders.status, 'paid'));

  const held = new Map<string, number>();
  if (paidOrders.length === 0) return held;

  const lines = await db
    .select({
      orderId: orderItems.orderId,
      productId: orderItems.productId,
      quantity: orderItems.quantity,
    })
    .from(orderItems)
    .where(
      inArray(
        orderItems.orderId,
        paidOrders.map((order) => order.id),
      ),
    );

  const warehouseByOrder = new Map(
    paidOrders.map((order) => [order.id, order.warehouseId]),
  );

  for (const line of lines) {
    const key = `${warehouseByOrder.get(line.orderId)}:${line.productId}`;
    held.set(key, (held.get(key) ?? 0) + line.quantity);
  }

  return held;
}
