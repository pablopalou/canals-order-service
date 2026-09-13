import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../db/client.ts';
import { idempotencyKeys, inventory, orderItems, orders, products } from '../db/schema.ts';

/**
 * The transitions out of `pending_payment`, shared by the checkout request and
 * by reconciliation.
 *
 * Two different processes can now try to settle the same order: the request
 * that placed it, and a reconciler that decided it had been stuck too long.
 * Every transition is therefore conditional on the order still being pending,
 * and reports whether it actually happened. An order is settled exactly once,
 * and its stock is released at most once, whoever gets there first.
 */

export type Order = typeof orders.$inferSelect;

export type OrderLine = {
  productId: string;
  sku: string;
  quantity: number;
  unitPriceCents: number;
};

/**
 * The one representation of an order, returned by POST /orders, by
 * GET /orders/:id, and by a replayed idempotency key alike. Two shapes for the
 * same resource would force every client to handle both.
 *
 * Deliberately absent: the geocoded coordinates and the gateway's failure
 * text, which are internal.
 */
export type OrderResponse = {
  id: string;
  status: 'pending_payment' | 'paid' | 'payment_failed';
  customerId: string;
  shippingAddress: {
    line1: string;
    line2: string | null;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  };
  warehouse: { id: string; name: string; distanceKm: number };
  items: OrderLine[];
  totalCents: number;
  currency: string;
  paymentId: string | null;
  cardLast4: string;
  createdAt: string;
  updatedAt: string;
};

/** Moves a pending order to `paid`. Null if it was no longer pending. */
export async function markPaid(
  tx: Transaction,
  orderId: string,
  paymentId: string,
): Promise<Order | null> {
  const [settled] = await tx
    .update(orders)
    .set({ status: 'paid', paymentId, updatedAt: new Date() })
    .where(and(eq(orders.id, orderId), eq(orders.status, 'pending_payment')))
    .returning();

  return settled ?? null;
}

/**
 * Moves a pending order to `payment_failed` and returns its units to the
 * shelf. Null, with nothing released, if the order was no longer pending.
 *
 * The status change comes first and gates the release: the conditional update
 * takes the order's row lock, so a second caller waits on it, then finds the
 * order no longer pending and releases nothing. Releasing first and checking
 * after would let two callers both put the same units back.
 */
export async function failAndReleaseStock(
  tx: Transaction,
  orderId: string,
  reason: string,
): Promise<Order | null> {
  const [failed] = await tx
    .update(orders)
    .set({
      status: 'payment_failed',
      paymentFailureReason: reason,
      updatedAt: new Date(),
    })
    .where(and(eq(orders.id, orderId), eq(orders.status, 'pending_payment')))
    .returning();

  if (!failed) return null;

  await releaseStock(tx, failed);
  return failed;
}

async function releaseStock(tx: Transaction, order: Order): Promise<void> {
  const lines = await tx
    .select({ productId: orderItems.productId, quantity: orderItems.quantity })
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id));

  // Same lock order as the reservation path, by product id. A multi-row update
  // locks rows in whatever order its plan visits them, so taking the locks
  // explicitly first is what keeps a release from deadlocking against a
  // concurrent reservation of the same products.
  await tx
    .select({ productId: inventory.productId })
    .from(inventory)
    .where(
      and(
        eq(inventory.warehouseId, order.warehouseId),
        inArray(
          inventory.productId,
          lines.map((line) => line.productId),
        ),
      ),
    )
    .orderBy(inventory.productId)
    .for('update');

  await tx.execute(sql`
    update inventory as i
    set quantity = i.quantity + v.quantity, updated_at = now()
    from (values ${sql.join(
      lines.map(
        (line) => sql`(${line.productId}::uuid, ${line.quantity}::integer)`,
      ),
      sql`, `,
    )}) as v (product_id, quantity)
    where i.warehouse_id = ${order.warehouseId}::uuid
      and i.product_id = v.product_id
  `);
}

/**
 * Stores the final answer for an idempotency key, so that any later replay
 * returns it instead of `request_in_progress` or, worse, a second attempt.
 */
export async function recordResponse(
  tx: Transaction,
  key: string,
  response: { orderId: string; status: number; body: unknown },
): Promise<void> {
  await tx
    .update(idempotencyKeys)
    .set({
      orderId: response.orderId,
      responseStatus: response.status,
      responseBody: response.body,
    })
    .where(eq(idempotencyKeys.key, key));
}

export async function loadOrderLines(
  executor: Database | Transaction,
  orderId: string,
): Promise<OrderLine[]> {
  return await executor
    .select({
      productId: orderItems.productId,
      sku: products.sku,
      quantity: orderItems.quantity,
      unitPriceCents: orderItems.unitPriceCents,
    })
    .from(orderItems)
    .innerJoin(products, eq(products.id, orderItems.productId))
    .where(eq(orderItems.orderId, orderId))
    .orderBy(products.sku);
}

export function toOrderResponse(
  order: Order,
  warehouse: OrderResponse['warehouse'],
  lines: OrderLine[],
): OrderResponse {
  return {
    id: order.id,
    status: order.status,
    customerId: order.customerId,
    shippingAddress: {
      line1: order.shippingLine1,
      line2: order.shippingLine2,
      city: order.shippingCity,
      state: order.shippingState,
      postalCode: order.shippingPostalCode,
      country: order.shippingCountry,
    },
    warehouse: {
      id: warehouse.id,
      name: warehouse.name,
      distanceKm: Math.round(warehouse.distanceKm * 10) / 10,
    },
    // Stored lines have no inherent order, and the request's order is not
    // kept; sorting by SKU gives every endpoint the same, stable sequence.
    items: [...lines].sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0)),
    totalCents: order.totalCents,
    currency: order.currency,
    paymentId: order.paymentId,
    cardLast4: order.cardLast4,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  };
}
