import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
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

describe('POST /orders', () => {
  beforeEach(async () => {
    await resetDatabase();
    app = await buildTestApp();
  });
  afterAll(closeDatabase);

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

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.status).toBe('paid');
    expect(body.warehouse.name).toBe('Dallas TX');
    expect(body.totalCents).toBe(2 * 189 + 6499);
    expect(body.paymentId).toMatch(/^pay_/);
    expect(body.cardLast4).toBe('4242');
    expect(response.headers.location).toBe(`/orders/${body.id}`);

    expect(await stockOf('Dallas TX', 'CU-ELB-050')).toBe(before - 2);
    expect(await stockOf('Dallas TX', 'TORCH-KIT')).toBe(0);
  });

  it('never trusts the client for prices', async () => {
    const response = await post({
      ...orderPayload({ items: [{ sku: 'TORCH-KIT', quantity: 1 }] }),
      // A hostile client trying to set its own price. The field is not part of
      // the contract, and the total must still come from the catalogue.
      totalCents: 1,
      items: [{ productId: productId('TORCH-KIT'), quantity: 1, unitPriceCents: 1 }],
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().totalCents).toBe(6499);
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

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('no_eligible_warehouse');
  });

  describe('idempotency', () => {
    it('returns the original order when a request is replayed', async () => {
      const key = nextKey();
      const payload = orderPayload({ items: [{ sku: 'BRK-20A', quantity: 4 }] });

      const first = await post(payload, key);
      const stockAfterFirst = await stockOf('Newark NJ', 'BRK-20A');
      const second = await post(payload, key);

      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
      expect(second.json()).toEqual(first.json());
      // The replay must not place a second order or move stock again.
      expect(await stockOf('Newark NJ', 'BRK-20A')).toBe(stockAfterFirst);
    });

    it('rejects a key reused with a different body', async () => {
      const key = nextKey();
      await post(orderPayload({ items: [{ sku: 'BRK-20A', quantity: 1 }] }), key);

      const response = await post(
        orderPayload({ items: [{ sku: 'BRK-20A', quantity: 2 }] }),
        key,
      );

      expect(response.statusCode).toBe(422);
      expect(response.json().error.code).toBe('idempotency_key_reused');
    });

    it('distinguishes a malformed key from a missing one', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/orders',
        headers: { 'idempotency-key': 'short' },
        payload: orderPayload({ items: [{ sku: 'BRK-20A', quantity: 1 }] }),
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('idempotency_key_invalid');
    });

    it('requires the header', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/orders',
        payload: orderPayload({ items: [{ sku: 'BRK-20A', quantity: 1 }] }),
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('idempotency_key_required');
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

      expect(response.statusCode).toBe(402);
      expect(response.json().error.code).toBe('payment_declined');
      // Nobody was charged, so the units must go back on the shelf.
      expect(await stockOf('Newark NJ', 'WIRE-12-500')).toBe(before);

      const [order] = await db
        .select()
        .from(orders)
        .where(eq(orders.customerId, CUSTOMER_ID));
      expect(order?.status).toBe('payment_failed');
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

      expect(response.statusCode).toBe(504);
      expect(response.json().error.code).toBe('payment_indeterminate');
      expect(await stockOf('Newark NJ', 'WIRE-12-500')).toBe(before - 3);

      const [order] = await db
        .select()
        .from(orders)
        .where(eq(orders.customerId, CUSTOMER_ID));
      expect(order?.status).toBe('pending_payment');
      expect(order?.paymentFailureReason).toBeTruthy();
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

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('validation_failed');
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

      expect(response.statusCode).toBe(400);
    });

    it('rejects an unknown customer and an unknown product', async () => {
      const unknownCustomer = await post({
        ...orderPayload({ items: [{ sku: 'BRK-20A', quantity: 1 }] }),
        customerId: '30000000-0000-4000-8000-00000000ffff',
      });
      expect(unknownCustomer.statusCode).toBe(404);
      expect(unknownCustomer.json().error.code).toBe('customer_not_found');

      const unknownProduct = await post({
        ...orderPayload({ items: [{ sku: 'BRK-20A', quantity: 1 }] }),
        items: [
          { productId: '10000000-0000-4000-8000-00000000ffff', quantity: 1 },
        ],
      });
      expect(unknownProduct.statusCode).toBe(404);
      expect(unknownProduct.json().error.code).toBe('product_not_found');
    });

    it('rejects a non-US address the geocoder cannot resolve', async () => {
      const response = await post({
        ...orderPayload({ items: [{ sku: 'BRK-20A', quantity: 1 }] }),
        shippingAddress: { ...PHILADELPHIA, country: 'UY' },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().error.code).toBe('address_not_geocodable');
    });
  });
});
