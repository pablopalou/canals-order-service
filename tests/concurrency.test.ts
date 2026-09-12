import type { FastifyInstance } from 'fastify';
import { count } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { orders } from '../src/db/schema.ts';
import { MockPaymentGateway } from '../src/services/payments.ts';
import {
  buildTestApp,
  closeDatabase,
  db,
  orderPayload,
  resetDatabase,
  stockOf,
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
 * These are the tests worth having. Everything else in the service can be read
 * and reasoned about; whether the reservation logic actually holds under
 * concurrent load can only be established by running it concurrently.
 */
describe('concurrent checkout', () => {
  beforeEach(async () => {
    await resetDatabase();
    // Latency widens the window between reserving stock and settling payment,
    // which is exactly where a race would hide.
    app = await buildTestApp(new MockPaymentGateway({ latencyMs: 40 }));
  });
  afterAll(closeDatabase);

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

    expect(created).toHaveLength(1);
    expect(rejected).toHaveLength(attempts - 1);
    expect(
      rejected.every((r) => r.json().error.code === 'no_eligible_warehouse'),
    ).toBe(true);

    // The invariant that matters: stock is drained, never negative.
    expect(await stockOf('Newark NJ', 'FLUX-8OZ')).toBe(0);
    expect(await orderCount()).toBe(1);
  });

  /**
   * The eligibility query runs before any row is locked, so the warehouse it
   * picks can be emptied in between. The reservation re-checks under the lock
   * and falls through to the next candidate rather than overselling.
   */
  it('falls through to the next warehouse when the nearest one is drained', async () => {
    // Dallas holds a single torch kit; Los Angeles holds three.
    const [first, second] = await Promise.all([
      post(orderPayload({ items: [{ sku: 'TORCH-KIT', quantity: 1 }] }), 'fallthrough-a'),
      post(orderPayload({ items: [{ sku: 'TORCH-KIT', quantity: 1 }] }), 'fallthrough-b'),
    ]);

    expect([first!.statusCode, second!.statusCode]).toEqual([201, 201]);
    expect(
      [first!.json().warehouse.name, second!.json().warehouse.name].sort(),
    ).toEqual(['Dallas TX', 'Los Angeles CA']);

    expect(await stockOf('Dallas TX', 'TORCH-KIT')).toBe(0);
    expect(await stockOf('Los Angeles CA', 'TORCH-KIT')).toBe(2);
  });

  /** A double click: the same request, twice, at the same instant. */
  it('creates one order when the same key arrives twice at once', async () => {
    const payload = orderPayload({ items: [{ sku: 'BRK-20A', quantity: 2 }] });
    const before = await stockOf('Newark NJ', 'BRK-20A');

    const responses = await Promise.all([
      post(payload, 'double-click'),
      post(payload, 'double-click'),
    ]);

    const codes = responses.map((r) => r.statusCode).sort();
    expect(codes).toEqual([201, 409]);
    expect(await orderCount()).toBe(1);
    expect(await stockOf('Newark NJ', 'BRK-20A')).toBe(before - 2);
  });

  /**
   * Two orders sharing products, listed in opposite order. Locks are acquired
   * sorted by product id regardless of payload order, so these cannot deadlock.
   * Without that sort this test fails intermittently, which is the worst way
   * for a deadlock to be discovered.
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

    expect(responses.every((r) => r.statusCode === 201)).toBe(true);
    expect(await orderCount()).toBe(10);
  });
});
