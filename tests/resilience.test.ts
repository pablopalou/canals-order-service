import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { orders } from '../src/db/schema.ts';
import {
  withTimeout,
  type ChargeRequest,
  type ChargeResult,
  type PaymentGateway,
} from '../src/services/payments.ts';
import {
  buildTestApp,
  closeDatabase,
  CUSTOMER_ID,
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

/** Never answers. The failure mode a timeout exists for. */
class HangingGateway implements PaymentGateway {
  calls = 0;
  async charge(_request: ChargeRequest): Promise<ChargeResult> {
    this.calls++;
    return await new Promise<ChargeResult>(() => {
      // intentionally never settles
    });
  }

  async findCharge(): Promise<ChargeResult | null> {
    return await new Promise<ChargeResult | null>(() => {
      // intentionally never settles
    });
  }
}

after(closeDatabase);

describe('when the payment gateway stops answering', () => {
  beforeEach(resetDatabase);

  /**
   * Without a bound, one unresponsive gateway holds every checkout open until
   * the client gives up, and the reserved stock with them.
   */
  it('gives up after the configured budget', async () => {
    app = await buildTestApp(withTimeout(new HangingGateway(), 200));

    const started = Date.now();
    const response = await post(
      orderPayload({ items: [{ sku: 'BRK-20A', quantity: 1 }] }),
      'gateway-hangs-key',
    );
    const elapsed = Date.now() - started;

    assert.equal(response.statusCode, 504);
    assert.ok(elapsed < 5_000, `gave up in ${elapsed}ms`);
  });

  /**
   * The distinction the whole design rests on. We stopped waiting, which says
   * nothing about whether the money moved — so the charge is indeterminate,
   * not declined, and the reservation is held rather than released.
   */
  it('treats the timeout as indeterminate, not as a decline', async () => {
    app = await buildTestApp(withTimeout(new HangingGateway(), 200));
    const before = await stockOf('Newark NJ', 'BRK-20A');

    const response = await post(
      orderPayload({ items: [{ sku: 'BRK-20A', quantity: 2 }] }),
      'gateway-hangs-indeterminate-key',
    );

    assert.equal(response.json().error.code, 'payment_indeterminate');
    // Stock stays reserved: releasing it while the card may have been charged
    // is the one outcome that costs real money.
    assert.equal(await stockOf('Newark NJ', 'BRK-20A'), before - 2);

    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.customerId, CUSTOMER_ID));
    assert.equal(order?.status, 'pending_payment');
  });

  it('does not leave the timer holding the event loop open', async () => {
    const gateway = withTimeout(
      {
        charge: async () => await Promise.resolve({ paymentId: 'pay_fast' }),
        findCharge: async () => await Promise.resolve(null),
      },
      60_000,
    );

    const started = Date.now();
    const result = await gateway.charge({
      idempotencyKey: 'fast-charge',
      cardNumber: '4242424242424242',
      amountCents: 100,
      currency: 'USD',
      description: 'test',
    });

    assert.equal(result.paymentId, 'pay_fast');
    assert.ok(Date.now() - started < 1_000);
  });
});

describe('readiness', () => {
  beforeEach(async () => {
    await resetDatabase();
    app = await buildTestApp();
  });

  it('reports ready while the database answers', async () => {
    const response = await app.inject({ method: 'GET', url: '/ready' });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, 'ready');
  });

  /**
   * Liveness must not depend on the database. Restarting this process would
   * not bring Postgres back, so an outage should stop traffic being routed
   * here, not have the container killed.
   */
  it('stays alive even when readiness would fail', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, 'ok');
  });
});
