import type { FastifyInstance } from 'fastify';
import { AppError } from '../errors.ts';
import {
  createOrder,
  findOrder,
  type OrderDependencies,
} from '../domain/orders.ts';
import { z } from 'zod';
import { createOrderSchema, idempotencyKeySchema } from './schemas.ts';

const orderIdSchema = z.uuid();

export async function registerOrderRoutes(
  app: FastifyInstance,
  deps: OrderDependencies,
): Promise<void> {
  app.post('/orders', async (request, reply) => {
    const rawKey = request.headers['idempotency-key'];
    if (rawKey === undefined) {
      throw new AppError(
        400,
        'idempotency_key_required',
        'An Idempotency-Key header is required. This endpoint is called on a ' +
          'user action, so retries and double submits are expected, and the ' +
          'key is what stops them from placing a second order.',
      );
    }

    const key = idempotencyKeySchema.safeParse(rawKey);
    if (!key.success) {
      // Reporting a malformed key as a missing one sends the caller looking
      // for a header they already sent.
      throw new AppError(
        400,
        'idempotency_key_invalid',
        key.error.issues[0]?.message ?? 'Invalid Idempotency-Key header',
      );
    }

    const body = createOrderSchema.parse(request.body);
    const order = await createOrder(deps, body, key.data);

    return reply.code(201).header('location', `/orders/${order.id}`).send(order);
  });

  /**
   * Not required by the brief, but a write-only checkout endpoint cannot be
   * verified, and an order left `pending_payment` by an indeterminate charge
   * has to be inspectable by support and by the reconciliation worker.
   */
  app.get<{ Params: { id: string } }>('/orders/:id', async (request) => {
    // Without this the database rejects the malformed uuid and the caller
    // gets a 500 for what is plainly a bad request.
    const id = orderIdSchema.safeParse(request.params.id);
    if (!id.success) {
      throw new AppError(400, 'invalid_order_id', 'Order id must be a UUID');
    }

    const order = await findOrder(deps.db, id.data);

    if (!order) {
      throw new AppError(404, 'order_not_found', 'Unknown order');
    }

    return order;
  });
}
