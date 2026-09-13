import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { inventory, warehouses } from '../src/db/schema.ts';
import type {
  ChargeRequest,
  ChargeResult,
  PaymentGateway,
} from '../src/services/payments.ts';
import {
  buildTestApp,
  closeDatabase,
  db,
  GOOD_CARD,
  orderPayload,
  PHILADELPHIA,
  productId,
  resetDatabase,
  stockOf,
  TIMEOUT_CARD,
} from './helpers.ts';

let app: FastifyInstance;

const PHILADELPHIA_COORDS = { latitude: 39.9526, longitude: -75.1652 };

// The pool is shared by every suite in this file, so it is closed once, here.
after(closeDatabase);

const post = (payload: unknown, key: string) =>
  app.inject({
    method: 'POST',
    url: '/orders',
    headers: { 'idempotency-key': key },
    payload: payload as object,
  });

/** Records what the gateway was actually asked to do. */
class RecordingGateway implements PaymentGateway {
  readonly charges: ChargeRequest[] = [];

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    this.charges.push(request);
    return await Promise.resolve({ paymentId: 'pay_recorded' });
  }

  async findCharge(): Promise<ChargeResult | null> {
    return await Promise.resolve(null);
  }
}

describe('what the payment gateway receives', () => {
  let gateway: RecordingGateway;

  beforeEach(async () => {
    await resetDatabase();
    gateway = new RecordingGateway();
    app = await buildTestApp(gateway);
  });

  /**
   * Regression test. An earlier version rebuilt the card number from the four
   * digits stored on the order and sent `**** **** **** 4242` to the gateway.
   * Every charge would have failed against a real provider, and no test
   * noticed because the mock only ever looked at the last four digits.
   */
  it('is given the real card number, not the stored mask', async () => {
    await post(
      orderPayload({ items: [{ sku: 'BRK-20A', quantity: 2 }] }),
      'gateway-inspection-1',
    );

    assert.equal(gateway.charges.length, 1);
    assert.equal(gateway.charges[0]!.cardNumber, GOOD_CARD);
  });

  it('is given the catalogue total, the currency and the order reference', async () => {
    const response = await post(
      orderPayload({
        items: [
          { sku: 'BRK-20A', quantity: 2 },
          { sku: 'PVC-TEE-075', quantity: 3 },
        ],
      }),
      'gateway-inspection-2',
    );

    const charge = gateway.charges[0]!;
    assert.equal(charge.amountCents, 2 * 1240 + 3 * 129);
    assert.equal(charge.amountCents, response.json().totalCents);
    assert.equal(charge.currency, 'USD');
    assert.ok(charge.description.includes(response.json().id));
  });

  /** Without this the gateway cannot recognise a retry, and double charges. */
  it('is given the caller\'s idempotency key', async () => {
    await post(
      orderPayload({ items: [{ sku: 'BRK-20A', quantity: 1 }] }),
      'gateway-inspection-3',
    );

    assert.equal(gateway.charges[0]!.idempotencyKey, 'gateway-inspection-3');
  });

  it('is not called at all when the order cannot be filled', async () => {
    const response = await post(
      orderPayload({
        items: [
          { sku: 'FLUX-8OZ', quantity: 1 },
          { sku: 'TORCH-KIT', quantity: 1 },
        ],
      }),
      'gateway-inspection-4',
    );

    assert.equal(response.statusCode, 409);
    // Charging before knowing the order can be filled would mean refunding it.
    assert.equal(gateway.charges.length, 0);
  });
});

describe('stock boundaries', () => {
  beforeEach(async () => {
    await resetDatabase();
    app = await buildTestApp();
  });

  it('allows an order for exactly the stock on hand', async () => {
    // Newark holds exactly twelve spools; every other warehouse holds fewer.
    const response = await post(
      orderPayload({ items: [{ sku: 'WIRE-12-500', quantity: 12 }] }),
      'exact-stock-key',
    );

    assert.equal(response.statusCode, 201);
    assert.equal(response.json().warehouse.name, 'Newark NJ');
    assert.equal(await stockOf('Newark NJ', 'WIRE-12-500'), 0);
  });

  it('refuses an order for one unit more than anyone holds', async () => {
    const response = await post(
      orderPayload({ items: [{ sku: 'WIRE-12-500', quantity: 31 }] }),
      'over-stock-key',
    );

    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, 'no_eligible_warehouse');
  });

  it('leaves a warehouse eligible for other products once one runs out', async () => {
    await post(
      orderPayload({ items: [{ sku: 'FLUX-8OZ', quantity: 1 }] }),
      'drain-flux-key',
    );

    const response = await post(
      orderPayload({ items: [{ sku: 'BRK-20A', quantity: 1 }] }),
      'after-drain-key',
    );

    assert.equal(response.statusCode, 201);
    assert.equal(response.json().warehouse.name, 'Newark NJ');
  });
});

describe('deterministic selection', () => {
  const WEST = '20000000-0000-4000-8000-0000000000aa';
  const EAST = '20000000-0000-4000-8000-0000000000bb';

  beforeEach(async () => {
    await resetDatabase();
    // Two warehouses at the same coordinates, both able to fill the order.
    // Distance cannot separate them, so the tiebreak has to.
    for (const id of [WEST, EAST]) {
      await db.insert(warehouses).values({
        id,
        name: `Twin ${id.slice(-2)}`,
        latitude: PHILADELPHIA_COORDS.latitude,
        longitude: PHILADELPHIA_COORDS.longitude,
      });
      await db.insert(inventory).values({
        warehouseId: id,
        productId: productId('BRK-20A'),
        quantity: 50,
      });
    }
    app = await buildTestApp();
  });

  it('breaks a distance tie the same way every time', async () => {
    const chosen: string[] = [];

    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await post(
        orderPayload({ items: [{ sku: 'BRK-20A', quantity: 1 }] }),
        `tiebreak-key-${attempt}`,
      );
      assert.equal(response.statusCode, 201);
      chosen.push(response.json().warehouse.id);
    }

    // Lowest id wins, and keeps winning: the same request must never resolve
    // to a different warehouse from one run to the next.
    assert.deepEqual(chosen, [WEST, WEST, WEST]);
  });
});

describe('addresses', () => {
  beforeEach(async () => {
    await resetDatabase();
    app = await buildTestApp();
  });

  it('resolves an address the geocoder has never seen, consistently', async () => {
    const unknown = {
      line1: '742 Evergreen Terrace',
      city: 'Springfield',
      state: 'IL',
      postalCode: '62701',
      country: 'US',
    };

    const first = await post(
      { ...orderPayload({ items: [{ sku: 'BRK-20A', quantity: 1 }] }), shippingAddress: unknown },
      'unknown-address-1',
    );
    const second = await post(
      { ...orderPayload({ items: [{ sku: 'BRK-20A', quantity: 1 }] }), shippingAddress: unknown },
      'unknown-address-2',
    );

    assert.equal(first.statusCode, 201);
    // Same address, same warehouse. A random fallback would make the choice
    // unreproducible and every documented example meaningless.
    assert.equal(second.json().warehouse.id, first.json().warehouse.id);
  });

  it('round-trips a second address line', async () => {
    const response = await post(
      {
        ...orderPayload({ items: [{ sku: 'BRK-20A', quantity: 1 }] }),
        shippingAddress: { ...PHILADELPHIA, line2: 'Suite 1400' },
      },
      'line2-key',
    );

    const readBack = await app.inject({
      method: 'GET',
      url: `/orders/${response.json().id}`,
    });
    assert.equal(readBack.json().shippingAddress.line2, 'Suite 1400');
  });
});

describe('replays in awkward states', () => {
  beforeEach(async () => {
    await resetDatabase();
    app = await buildTestApp();
  });

  /**
   * A replay answers from the record, not from current stock. The customer
   * already has this order; that another customer has since bought the rest
   * of the shelf changes nothing.
   */
  it('replays an order placed before the stock ran out', async () => {
    const payload = orderPayload({ items: [{ sku: 'FLUX-8OZ', quantity: 1 }] });
    const first = await post(payload, 'replay-after-drain-key');
    assert.equal(first.statusCode, 201);
    assert.equal(await stockOf('Newark NJ', 'FLUX-8OZ'), 0);

    const replay = await post(payload, 'replay-after-drain-key');

    assert.equal(replay.statusCode, 201);
    assert.deepEqual(replay.json(), first.json());
  });

  /**
   * A charge whose outcome is unknown leaves the key without a recorded
   * response on purpose. Replaying it must not start a second charge; it is
   * told the request is still in flight until reconciliation settles it.
   */
  it('refuses to replay a charge whose outcome is still unknown', async () => {
    const payload = orderPayload({
      items: [{ sku: 'WIRE-12-500', quantity: 1 }],
      cardNumber: TIMEOUT_CARD,
    });

    const first = await post(payload, 'replay-timeout-key');
    assert.equal(first.statusCode, 504);

    const replay = await post(payload, 'replay-timeout-key');
    assert.equal(replay.statusCode, 409);
    assert.equal(replay.json().error.code, 'request_in_progress');
  });

  it('detects a key reused by a different customer', async () => {
    const key = 'cross-customer-key';
    await post(orderPayload({ items: [{ sku: 'BRK-20A', quantity: 1 }] }), key);

    const response = await post(
      {
        ...orderPayload({ items: [{ sku: 'BRK-20A', quantity: 1 }] }),
        customerId: '30000000-0000-4000-8000-000000000002',
      },
      key,
    );

    assert.equal(response.statusCode, 422);
    assert.equal(response.json().error.code, 'idempotency_key_reused');
  });

  it('treats a key with surrounding whitespace as the same key', async () => {
    const payload = orderPayload({ items: [{ sku: 'BRK-20A', quantity: 1 }] });
    const first = await post(payload, 'whitespace-key-value');
    const second = await post(payload, '  whitespace-key-value  ');

    assert.equal(second.statusCode, 201);
    assert.equal(second.json().id, first.json().id);
  });
});

describe('multi-line orders', () => {
  beforeEach(async () => {
    await resetDatabase();
    app = await buildTestApp();
  });

  it('fills five different products from a single warehouse', async () => {
    const response = await post(
      orderPayload({
        items: [
          { sku: 'CU-ELB-050', quantity: 10 },
          { sku: 'PVC-TEE-075', quantity: 5 },
          { sku: 'BRK-20A', quantity: 2 },
          { sku: 'SOLD-LF-1LB', quantity: 1 },
          { sku: 'BALL-VLV-100', quantity: 3 },
        ],
      }),
      'multi-line-key',
    );

    assert.equal(response.statusCode, 201);
    assert.equal(response.json().items.length, 5);
    assert.equal(
      response.json().totalCents,
      10 * 189 + 5 * 129 + 2 * 1240 + 1 * 2799 + 3 * 1875,
    );

    const warehouse = response.json().warehouse.name;
    assert.equal(await stockOf(warehouse, 'CU-ELB-050'), 110);
  });

  it('charges once for an order spanning many lines', async () => {
    const gateway = new RecordingGateway();
    app = await buildTestApp(gateway);

    await post(
      orderPayload({
        items: [
          { sku: 'CU-ELB-050', quantity: 1 },
          { sku: 'PVC-TEE-075', quantity: 1 },
          { sku: 'BRK-20A', quantity: 1 },
        ],
      }),
      'single-charge-key',
    );

    // One order, one charge. Charging per line would be three authorisations
    // on the customer's statement.
    assert.equal(gateway.charges.length, 1);
  });
});
