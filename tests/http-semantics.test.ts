import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import {
  buildTestApp,
  closeDatabase,
  CUSTOMER_ID,
  GOOD_CARD,
  orderPayload,
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

  /**
   * One resource, one representation. Creating an order and reading it back
   * used to return two different shapes, which every client would have had to
   * handle separately.
   */
  it('reads an order back in exactly the shape it was created with', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/orders',
      headers: { 'idempotency-key': 'http-semantics-same-shape' },
      payload: {
        customerId: CUSTOMER_ID,
        shippingAddress: PHILADELPHIA,
        // Deliberately not in SKU order, so a difference in line ordering
        // between the two endpoints cannot hide.
        items: [
          { productId: productId('CU-ELB-050'), quantity: 3 },
          { productId: productId('BRK-20A'), quantity: 1 },
        ],
        payment: { cardNumber: GOOD_CARD },
      },
    });
    const read = await app.inject({
      method: 'GET',
      url: `/orders/${created.json().id}`,
    });

    assert.equal(created.statusCode, 201);
    assert.equal(read.statusCode, 200);
    assert.deepEqual(read.json(), created.json());
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

  /**
   * The error mapping, driven through the real error handler with a route
   * that throws what Postgres would. Lock ordering makes deadlocks rare here;
   * when one happens anyway, nothing was committed and a retry is correct.
   */
  it('answers a rolled-back transaction conflict with a retryable 503', async () => {
    const probe = await buildTestApp();
    probe.get('/__probe/deadlock', async () => {
      await Promise.resolve();
      const driverError = Object.assign(new Error('deadlock detected'), { code: '40P01' });
      throw new Error('Failed query', { cause: driverError });
    });

    const response = await probe.inject({ method: 'GET', url: '/__probe/deadlock' });

    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, 'transaction_conflict');
    assert.equal(response.headers['retry-after'], '1');
  });

  it('answers an unreachable database with a retryable 503', async () => {
    const probe = await buildTestApp();
    probe.get('/__probe/db-down', async () => {
      await Promise.resolve();
      throw Object.assign(new Error('terminating connection'), { code: '57P01' });
    });

    const response = await probe.inject({ method: 'GET', url: '/__probe/db-down' });

    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, 'database_unavailable');
  });
});

/**
 * The endpoint is called by a browser UI. From another origin, the custom
 * Idempotency-Key header makes every order preflighted; before CORS was
 * configured the preflight got a 405 and the browser never sent the order.
 */
describe('CORS', () => {
  const ALLOWED = 'https://shop.example.com';

  const preflight = async (origin: string) => {
    const app = await buildTestApp();
    return await app.inject({
      method: 'OPTIONS',
      url: '/orders',
      headers: {
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type, idempotency-key',
      },
    });
  };

  it('lets the configured UI origin send an order with its idempotency key', async () => {
    const response = await preflight(ALLOWED);

    assert.equal(response.statusCode, 204);
    assert.equal(response.headers['access-control-allow-origin'], ALLOWED);
    assert.match(
      String(response.headers['access-control-allow-headers']),
      /idempotency-key/i,
    );
  });

  it('gives any other origin nothing to work with', async () => {
    const response = await preflight('https://evil.example.net');

    // The preflight is answered (so this cannot pass merely because CORS is
    // switched off, which would answer 405), but without an allow-origin the
    // browser refuses to send the order.
    assert.equal(response.statusCode, 204);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  });

  it('exposes Location to the UI so it can follow the created order', async () => {
    const app = await buildTestApp();
    const response = await app.inject({
      method: 'POST',
      url: '/orders',
      headers: { origin: ALLOWED, 'idempotency-key': 'cors-location-key' },
      payload: orderPayload({ items: [{ sku: 'BRK-20A', quantity: 1 }] }),
    });

    assert.equal(response.statusCode, 201);
    assert.match(
      String(response.headers['access-control-expose-headers']),
      /location/i,
    );
  });
});
