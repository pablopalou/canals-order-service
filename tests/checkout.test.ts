import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { orders } from '../src/db/schema.ts';
import {
  buildTestApp,
  closeDatabase,
  CUSTOMER_ID,
  db,
  DECLINED_CARD,
  orderPayload,
  PHILADELPHIA,
  productId,
  resetDatabase,
  stockOf,
  TIMEOUT_CARD,
} from './helpers.ts';

let app: FastifyInstance;
let keySeq = 0;
const nextKey = () => `test-key-${++keySeq}-${Date.now()}`;

const post = (payload: unknown, key = nextKey()) =>
  app.inject({
    method: 'POST',
    url: '/orders',
    headers: { 'idempotency-key': key },
    payload: payload as object,
  });

const latestOrder = async () => {
  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.customerId, CUSTOMER_ID));
  return order;
};

describe('POST /orders', () => {
  beforeEach(async () => {
    await resetDatabase();
    app = await buildTestApp();
  });
  after(closeDatabase);

  it('places an order, charges the card and decrements stock', async () => {
    const before = await stockOf('Dallas TX', 'CU-ELB-050');

    const response = await post(
      orderPayload({
        items: [
          { sku: 'CU-ELB-050', quantity: 2 },
          { sku: 'TORCH-KIT', quantity: 1 },
        ],
      }),
    );

    assert.equal(response.statusCode, 201);
    const body = response.json();
    assert.equal(body.status, 'paid');
    assert.equal(body.warehouse.name, 'Dallas TX');
    assert.equal(body.totalCents, 2 * 189 + 6499);
    assert.match(body.paymentId, /^pay_/);
    assert.equal(body.cardLast4, '4242');
    assert.equal(response.headers.location, `/orders/${body.id}`);

    assert.equal(await stockOf('Dallas TX', 'CU-ELB-050'), before - 2);
    assert.equal(await stockOf('Dallas TX', 'TORCH-KIT'), 0);
  });

  it('never trusts the client for prices', async () => {
    const response = await post({
      ...orderPayload({ items: [{ sku: 'TORCH-KIT', quantity: 1 }] }),
      // A hostile client trying to set its own price. Neither field is part of
      // the contract, and the total must still come from the catalogue.
      totalCents: 1,
      items: [
        { productId: productId('TORCH-KIT'), quantity: 1, unitPriceCents: 1 },
      ],
    });

    assert.equal(response.statusCode, 201);
    assert.equal(response.json().totalCents, 6499);
  });

  it('rejects an order no single warehouse can fill', async () => {
    const response = await post(
      orderPayload({
        items: [
          { sku: 'FLUX-8OZ', quantity: 1 },
          { sku: 'TORCH-KIT', quantity: 1 },
        ],
      }),
    );

    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, 'no_eligible_warehouse');
  });

  describe('idempotency', () => {
    it('returns the original order when a request is replayed', async () => {
      const key = nextKey();
      const payload = orderPayload({ items: [{ sku: 'BRK-20A', quantity: 4 }] });

      const first = await post(payload, key);
      const stockAfterFirst = await stockOf('Newark NJ', 'BRK-20A');
      const second = await post(payload, key);

      assert.equal(first.statusCode, 201);
      assert.equal(second.statusCode, 201);
      assert.deepEqual(second.json(), first.json());
      // The replay must not place a second order or move stock again.
      assert.equal(await stockOf('Newark NJ', 'BRK-20A'), stockAfterFirst);
    });

    it('rejects a key reused with a different body', async () => {
      const key = nextKey();
      await post(orderPayload({ items: [{ sku: 'BRK-20A', quantity: 1 }] }), key);

      const response = await post(
        orderPayload({ items: [{ sku: 'BRK-20A', quantity: 2 }] }),
        key,
      );

      assert.equal(response.statusCode, 422);
      assert.equal(response.json().error.code, 'idempotency_key_reused');
    });

    it('treats an omitted line2 and an explicit null as the same request', async () => {
      const key = nextKey();
      const base = orderPayload({ items: [{ sku: 'BRK-20A', quantity: 1 }] });

      const first = await post(base, key);
      const second = await post(
        { ...base, shippingAddress: { ...PHILADELPHIA, line2: null } },
        key,
      );

      assert.equal(first.statusCode, 201);
      // A replay, not a different request: the fingerprint must not depend on
      // whether an optional field was sent as null or left out.
      assert.equal(second.statusCode, 201);
      assert.deepEqual(second.json(), first.json());
    });

    it('distinguishes a malformed key from a missing one', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/orders',
        headers: { 'idempotency-key': 'short' },
        payload: orderPayload({ items: [{ sku: 'BRK-20A', quantity: 1 }] }),
      });

      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error.code, 'idempotency_key_invalid');
    });

    it('requires the header', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/orders',
        payload: orderPayload({ items: [{ sku: 'BRK-20A', quantity: 1 }] }),
      });

      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error.code, 'idempotency_key_required');
    });
  });

  describe('payment outcomes', () => {
    it('releases the reservation when the card is declined', async () => {
      const before = await stockOf('Newark NJ', 'WIRE-12-500');

      const response = await post(
        orderPayload({
          items: [{ sku: 'WIRE-12-500', quantity: 3 }],
          cardNumber: DECLINED_CARD,
        }),
      );

      assert.equal(response.statusCode, 402);
      assert.equal(response.json().error.code, 'payment_declined');
      // Nobody was charged, so the units must go back on the shelf.
      assert.equal(await stockOf('Newark NJ', 'WIRE-12-500'), before);

      const order = await latestOrder();
      assert.ok(order, 'the failed order should still exist');
      assert.equal(order.status, 'payment_failed');
    });

    /**
     * The case that separates a correct implementation from a plausible one.
     * The charge may have succeeded, so the reservation is deliberately NOT
     * released and the order is left for reconciliation.
     */
    /**
     * What a real HTTP client throws when the connection drops mid-charge: a
     * plain Error, not one of ours. It used to be treated as a decline — stock
     * released, order failed, and ECONNRESET reported to the client as the
     * database being down. Only an explicit decline proves no money moved.
     */
    it('treats an unrecognised gateway failure as unknown, not as a decline', async () => {
      app = await buildTestApp({
        charge: async () =>
          await Promise.reject(
            Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
          ),
        findCharge: async () => await Promise.resolve(null),
      });
      const before = await stockOf('Newark NJ', 'BRK-20A');
      const key = nextKey();
      const payload = orderPayload({ items: [{ sku: 'BRK-20A', quantity: 2 }] });

      const response = await post(payload, key);

      assert.equal(response.statusCode, 504);
      assert.equal(response.json().error.code, 'payment_indeterminate');
      assert.equal(await stockOf('Newark NJ', 'BRK-20A'), before - 2);

      const order = await latestOrder();
      assert.ok(order);
      assert.equal(order.status, 'pending_payment');

      // A retry must not look like a failure it can act on, or charge again.
      const replay = await post(payload, key);
      assert.equal(replay.statusCode, 409);
      assert.equal(replay.json().error.code, 'request_in_progress');
    });

    it('holds the reservation when the charge outcome is unknown', async () => {
      const before = await stockOf('Newark NJ', 'WIRE-12-500');

      const response = await post(
        orderPayload({
          items: [{ sku: 'WIRE-12-500', quantity: 3 }],
          cardNumber: TIMEOUT_CARD,
        }),
      );

      assert.equal(response.statusCode, 504);
      assert.equal(response.json().error.code, 'payment_indeterminate');
      assert.equal(await stockOf('Newark NJ', 'WIRE-12-500'), before - 3);

      const order = await latestOrder();
      assert.ok(order, 'the pending order should still exist');
      assert.equal(order.status, 'pending_payment');
      assert.ok(order.paymentFailureReason);
    });
  });

  describe('reading an order back', () => {
    it('returns the order that was placed', async () => {
      const created = await post(
        orderPayload({ items: [{ sku: 'BRK-20A', quantity: 1 }] }),
      );
      const id = created.json().id;

      const response = await app.inject({ method: 'GET', url: `/orders/${id}` });

      assert.equal(response.statusCode, 200);
      assert.equal(response.json().id, id);
      assert.equal(response.json().status, 'paid');
    });

    it('rejects a malformed id instead of letting the database reject it', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/orders/not-a-uuid',
      });

      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error.code, 'invalid_order_id');
    });

    it('answers an unknown order with 404', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/orders/11111111-1111-4111-8111-111111111111',
      });

      assert.equal(response.statusCode, 404);
      assert.equal(response.json().error.code, 'order_not_found');
    });

    it('exposes only the fields it means to, not the raw row', async () => {
      const created = await post(
        orderPayload({ items: [{ sku: 'BRK-20A', quantity: 1 }] }),
      );
      const response = await app.inject({
        method: 'GET',
        url: `/orders/${created.json().id}`,
      });

      const body = response.json();
      assert.equal(body.items[0].sku, 'BRK-20A');
      assert.equal(body.shippingAddress.city, 'Philadelphia');
      // Internal columns must not travel: the geocoded coordinates are ours,
      // and the gateway's failure text is not the customer's business.
      assert.equal(body.shippingLatitude, undefined);
      assert.equal(body.shippingLongitude, undefined);
      assert.equal(body.paymentFailureReason, undefined);
    });

    it('answers an unknown route in the same error shape', async () => {
      const response = await app.inject({ method: 'GET', url: '/nope' });

      assert.equal(response.statusCode, 404);
      assert.equal(response.json().error.code, 'route_not_found');
    });
  });

  describe('validation', () => {
    it('rejects a card that fails the Luhn check', async () => {
      const response = await post(
        orderPayload({
          items: [{ sku: 'BRK-20A', quantity: 1 }],
          cardNumber: '4242424242424241',
        }),
      );

      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error.code, 'validation_failed');
    });

    it('rejects duplicate order lines instead of merging them', async () => {
      const response = await post({
        customerId: CUSTOMER_ID,
        shippingAddress: PHILADELPHIA,
        items: [
          { productId: productId('BRK-20A'), quantity: 1 },
          { productId: productId('BRK-20A'), quantity: 2 },
        ],
        payment: { cardNumber: '4242424242424242' },
      });

      assert.equal(response.statusCode, 400);
    });

    it('rejects an unknown customer and an unknown product', async () => {
      const unknownCustomer = await post({
        ...orderPayload({ items: [{ sku: 'BRK-20A', quantity: 1 }] }),
        customerId: '30000000-0000-4000-8000-00000000ffff',
      });
      assert.equal(unknownCustomer.statusCode, 404);
      assert.equal(unknownCustomer.json().error.code, 'customer_not_found');

      const unknownProduct = await post({
        ...orderPayload({ items: [{ sku: 'BRK-20A', quantity: 1 }] }),
        items: [
          { productId: '10000000-0000-4000-8000-00000000ffff', quantity: 1 },
        ],
      });
      assert.equal(unknownProduct.statusCode, 404);
      assert.equal(unknownProduct.json().error.code, 'product_not_found');
    });

    it("answers a malformed body with our error shape, not the framework's", async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/orders',
        headers: {
          'idempotency-key': 'malformed-body-key',
          'content-type': 'application/json',
        },
        payload: '{not json',
      });

      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error.code, 'malformed_request');
    });

    it('rejects a non-US address the geocoder cannot resolve', async () => {
      const response = await post({
        ...orderPayload({ items: [{ sku: 'BRK-20A', quantity: 1 }] }),
        shippingAddress: { ...PHILADELPHIA, country: 'UY' },
      });

      assert.equal(response.statusCode, 422);
      assert.equal(response.json().error.code, 'address_not_geocodable');
    });
  });
});
