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
      assert.equal((await latestOrder())?.status, 'payment_failed');
    });

    /**
     * The case that separates a correct implementation from a plausible one.
     * The charge may have succeeded, so the reservation is deliberately NOT
     * released and the order is left for reconciliation.
     */
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
      assert.equal(order?.status, 'pending_payment');
      assert.ok(order?.paymentFailureReason);
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
