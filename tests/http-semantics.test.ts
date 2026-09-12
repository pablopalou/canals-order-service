import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import {
  buildTestApp,
  closeDatabase,
  CUSTOMER_ID,
  GOOD_CARD,
  PHILADELPHIA,
  productId,
  resetDatabase,
} from './helpers.ts';

let app: FastifyInstance;
let orderId: string;

after(closeDatabase);

/**
 * The parts of the contract that live in the protocol rather than in the body.
 * A client that follows HTTP correctly should not have to special-case this
 * service.
 */
describe('HTTP semantics', () => {
  before(async () => {
    await resetDatabase();
    app = await buildTestApp();

    const created = await app.inject({
      method: 'POST',
      url: '/orders',
      headers: { 'idempotency-key': 'http-semantics-setup' },
      payload: {
        customerId: CUSTOMER_ID,
        shippingAddress: PHILADELPHIA,
        items: [{ productId: productId('BRK-20A'), quantity: 1 }],
        payment: { cardNumber: GOOD_CARD },
      },
    });
    orderId = created.json().id;
  });

  it('points at the new resource with Location', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/orders',
      headers: { 'idempotency-key': 'http-semantics-location' },
      payload: {
        customerId: CUSTOMER_ID,
        shippingAddress: PHILADELPHIA,
        items: [{ productId: productId('BRK-20A'), quantity: 1 }],
        payment: { cardNumber: GOOD_CARD },
      },
    });

    assert.equal(response.statusCode, 201);
    assert.equal(response.headers.location, `/orders/${response.json().id}`);
  });

  /**
   * A path that exists under another method is a 405 with an Allow header, not
   * a 404. Answering 404 tells a client the resource does not exist when it is
   * only the verb that is wrong.
   */
  it('answers a wrong method with 405 and lists what is allowed', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: `/orders/${orderId}`,
    });

    assert.equal(response.statusCode, 405);
    assert.equal(response.json().error.code, 'method_not_allowed');
    assert.ok(response.headers.allow?.includes('GET'));
  });

  it('still answers 404 for a path that does not exist at all', async () => {
    const response = await app.inject({ method: 'GET', url: '/customers' });

    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, 'route_not_found');
  });

  it('tells clients not to sniff the content type', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    assert.equal(response.headers['x-content-type-options'], 'nosniff');
  });

  /** An order carries a shipping address and part of a card number. */
  it('forbids caching an order', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/orders/${orderId}`,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
  });

  /**
   * Fastify parses bodies with secure-json-parse, which refuses payloads
   * carrying __proto__ or constructor.prototype. Asserted here so that the
   * protection is a documented property of this service rather than something
   * inherited by luck and lost on a future parser change.
   */
  it('refuses a body that tries to reach the prototype chain', async () => {
    for (const hostile of [
      '{"__proto__":{"polluted":true}}',
      '{"constructor":{"prototype":{"polluted":true}}}',
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/orders',
        headers: {
          'idempotency-key': 'prototype-pollution-key',
          'content-type': 'application/json',
        },
        payload: hostile,
      });

      assert.equal(response.statusCode, 400);
    }

    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });
});
