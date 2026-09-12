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
let seq = 0;

const valid = () => ({
  customerId: CUSTOMER_ID,
  shippingAddress: { ...PHILADELPHIA },
  items: [{ productId: productId('BRK-20A'), quantity: 1 }],
  payment: { cardNumber: GOOD_CARD },
});

const post = (payload: unknown) =>
  app.inject({
    method: 'POST',
    url: '/orders',
    headers: { 'idempotency-key': `validation-key-${++seq}` },
    payload: payload as object,
  });

/**
 * The input boundary. Every one of these is a request a real client will send
 * sooner or later, usually by accident, and each must produce a clear refusal
 * rather than a 500 or a silently wrong order.
 */
describe('input validation', () => {
  before(async () => {
    await resetDatabase();
    app = await buildTestApp();
  });
  after(closeDatabase);

  const rejected: Array<[string, unknown]> = [
    ['a quantity of zero', { ...valid(), items: [{ productId: productId('BRK-20A'), quantity: 0 }] }],
    ['a negative quantity', { ...valid(), items: [{ productId: productId('BRK-20A'), quantity: -3 }] }],
    ['a fractional quantity', { ...valid(), items: [{ productId: productId('BRK-20A'), quantity: 1.5 }] }],
    ['a quantity beyond the per-line cap', { ...valid(), items: [{ productId: productId('BRK-20A'), quantity: 10_001 }] }],
    ['an empty cart', { ...valid(), items: [] }],
    ['more lines than the cap', {
      ...valid(),
      items: Array.from({ length: 201 }, () => ({
        productId: productId('BRK-20A'),
        quantity: 1,
      })),
    }],
    ['a customer id that is not a uuid', { ...valid(), customerId: 'nope' }],
    ['a product id that is not a uuid', { ...valid(), items: [{ productId: '123', quantity: 1 }] }],
    ['a missing shipping address', { ...valid(), shippingAddress: undefined }],
    ['a blank street line', { ...valid(), shippingAddress: { ...PHILADELPHIA, line1: '   ' } }],
    ['a missing postal code', { ...valid(), shippingAddress: { ...PHILADELPHIA, postalCode: undefined } }],
    ['a card with letters in it', { ...valid(), payment: { cardNumber: '4242abcd4242abcd' } }],
    ['a card that is too short', { ...valid(), payment: { cardNumber: '424242' } }],
    ['a missing payment object', { ...valid(), payment: undefined }],
    ['an empty body', {}],
  ];

  for (const [description, payload] of rejected) {
    it(`rejects ${description}`, async () => {
      const response = await post(payload);
      assert.equal(response.statusCode, 400, `expected 400 for ${description}`);
      assert.ok(response.json().error);
    });
  }

  it('answers an unsupported content type with 415', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/orders',
      headers: {
        'idempotency-key': 'wrong-content-type-key',
        'content-type': 'application/xml',
      },
      payload: '<order/>',
    });

    // Nothing is malformed here; the media type is simply not one we accept.
    assert.equal(response.statusCode, 415);
    assert.equal(response.json().error.code, 'unsupported_media_type');
  });

  it('rejects a plain text body through validation', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/orders',
      headers: {
        'idempotency-key': 'plain-text-body-key',
        'content-type': 'text/plain',
      },
      payload: 'just a string',
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'validation_failed');
  });

  it('accepts a card written with spaces and dashes', async () => {
    const response = await post({
      ...valid(),
      payment: { cardNumber: '4242-4242 4242-4242' },
    });

    assert.equal(response.statusCode, 201);
    assert.equal(response.json().cardLast4, '4242');
  });

  it('accepts a 13 digit card that satisfies Luhn', async () => {
    const response = await post({
      ...valid(),
      payment: { cardNumber: '4222222222222' },
    });

    assert.equal(response.statusCode, 201);
  });

  it('normalises a lowercase country code', async () => {
    const response = await post({
      ...valid(),
      shippingAddress: { ...PHILADELPHIA, country: 'us' },
    });

    assert.equal(response.statusCode, 201);
  });

  it('ignores fields the contract does not define', async () => {
    const response = await post({
      ...valid(),
      status: 'paid',
      totalCents: 1,
      warehouseId: '20000000-0000-4000-8000-000000000005',
    });

    // Extra keys are stripped, not honoured: a client cannot pick the
    // warehouse, the status or the price by adding fields to the body.
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().totalCents, 1240);
    assert.equal(response.json().warehouse.name, 'Newark NJ');
  });

  it('rejects a body larger than the limit', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/orders',
      headers: {
        'idempotency-key': 'oversized-body-key',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ ...valid(), padding: 'x'.repeat(70 * 1024) }),
    });

    assert.equal(response.statusCode, 413);
    assert.equal(response.json().error.code, 'payload_too_large');
  });

  /**
   * Postgres text columns cannot store a NUL byte, and a JSON body can carry
   * one. Before this was validated the insert failed and the caller got a 500
   * for what is plainly a bad request.
   */
  it('rejects control characters a text column cannot store', async () => {
    const response = await post({
      ...valid(),
      shippingAddress: { ...PHILADELPHIA, line1: '1 Market\u0000St' },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'validation_failed');
  });

  it('accepts accents and emoji, which are ordinary text', async () => {
    const response = await post({
      ...valid(),
      shippingAddress: { ...PHILADELPHIA, line1: 'Åvenida Ñuñoa 123 🏗️' },
    });

    assert.equal(response.statusCode, 201);
  });

  it('keeps text fields literal rather than interpreting them', async () => {
    const hostile = "Robert'); DROP TABLE orders;--";
    const response = await post({
      ...valid(),
      shippingAddress: { ...PHILADELPHIA, line1: hostile },
    });

    assert.equal(response.statusCode, 201);

    const readBack = await app.inject({
      method: 'GET',
      url: `/orders/${response.json().id}`,
    });
    // Stored and returned verbatim, and the table is still there.
    assert.equal(readBack.json().shippingAddress.line1, hostile);
  });
});
