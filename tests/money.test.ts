import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { inventory, products } from '../src/db/schema.ts';
import {
  buildTestApp,
  closeDatabase,
  CUSTOMER_ID,
  db,
  PHILADELPHIA,
  resetDatabase,
  warehouseId,
} from './helpers.ts';

/**
 * A distributor's order can be large. 200 lines of a high-priced SKU passes
 * the 2.1 billion cent ceiling of a 32-bit integer, where the insert would
 * fail and the customer would get a 500 for a perfectly valid order.
 */
describe('order totals beyond 32 bits', () => {
  const EXPENSIVE = '10000000-0000-4000-8000-0000000000ff';
  let app: FastifyInstance;

  before(async () => {
    await resetDatabase();
    await db.insert(products).values({
      id: EXPENSIVE,
      sku: 'SWITCHGEAR-5KV',
      name: 'Medium Voltage Switchgear Lineup',
      priceCents: 99_999_999,
    });
    await db.insert(inventory).values({
      warehouseId: warehouseId('Newark NJ'),
      productId: EXPENSIVE,
      quantity: 100,
    });
    app = await buildTestApp();
  });
  after(closeDatabase);

  it('accepts a total that would overflow a 32-bit column', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/orders',
      headers: { 'idempotency-key': 'big-order-key-1' },
      payload: {
        customerId: CUSTOMER_ID,
        shippingAddress: PHILADELPHIA,
        items: [{ productId: EXPENSIVE, quantity: 30 }],
        payment: { cardNumber: '4242424242424242' },
      },
    });

    const expected = 30 * 99_999_999; // 2,999,999,970 cents, about $30m
    assert.ok(expected > 2_147_483_647);
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().totalCents, expected);
  });
});
