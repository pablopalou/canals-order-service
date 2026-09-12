import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../db/client.ts';
import {
  customers,
  idempotencyKeys,
  inventory,
  orderItems,
  orders,
  products,
} from '../db/schema.ts';
import { AppError } from '../errors.ts';
import type { Address, GeocodingProvider } from '../services/geocoding.ts';
import {
  PAYMENT_INDETERMINATE,
  type PaymentGateway,
} from '../services/payments.ts';
import { findEligibleWarehouses } from './warehouse-selection.ts';

const PG_UNIQUE_VIOLATION = '23505';

/**
 * Drizzle wraps driver errors, so the Postgres error code is not on the error
 * it throws but somewhere down its cause chain. Matching only the top-level
 * error silently turns an expected duplicate-key conflict into a 500.
 */
function isUniqueViolation(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    if ((current as { code?: unknown }).code === PG_UNIQUE_VIOLATION) {
      return true;
    }
  }
  return false;
}

export type CreateOrderInput = {
  customerId: string;
  shippingAddress: Address;
  items: Array<{ productId: string; quantity: number }>;
  payment: { cardNumber: string };
};

export type OrderResponse = {
  id: string;
  status: 'pending_payment' | 'paid' | 'payment_failed';
  customerId: string;
  warehouse: { id: string; name: string; distanceKm: number };
  items: Array<{
    productId: string;
    sku: string;
    quantity: number;
    unitPriceCents: number;
  }>;
  totalCents: number;
  currency: string;
  paymentId: string | null;
  cardLast4: string;
  createdAt: string;
};

export type OrderDependencies = {
  db: Database;
  geocoding: GeocodingProvider;
  payments: PaymentGateway;
};

/** Stable fingerprint of the request an idempotency key was first used with. */
const fingerprint = (input: CreateOrderInput): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        customerId: input.customerId,
        shippingAddress: input.shippingAddress,
        items: [...input.items].sort((a, b) =>
          a.productId.localeCompare(b.productId),
        ),
        cardLast4: input.payment.cardNumber.slice(-4),
      }),
    )
    .digest('hex');

/**
 * Places an order.
 *
 * The flow is deliberately split around the payment call, because the charge
 * is a network request to a third party and must not happen while a database
 * transaction is open. Holding row locks on inventory for the duration of an
 * external HTTP call is how a checkout endpoint takes down a database under
 * load.
 *
 *   1. Reserve stock and persist the order as `pending_payment`, atomically.
 *   2. Commit, then charge the card with no locks held.
 *   3. Settle the order to `paid`, or compensate.
 *
 * The intermediate `pending_payment` row is what makes step 3 recoverable: if
 * the process dies between steps, the order still exists and can be
 * reconciled against the gateway, instead of leaving stock decremented with
 * no record of why.
 */
export async function createOrder(
  deps: OrderDependencies,
  input: CreateOrderInput,
  idempotencyKey: string,
): Promise<OrderResponse> {
  const replay = await findReplay(deps.db, idempotencyKey, input);
  if (replay) return replay;

  // Geocoding is an external call, so it happens before the transaction opens.
  const destination = await deps.geocoding.geocode(input.shippingAddress);

  const reserved = await deps.db.transaction(async (tx) => {
    await claimIdempotencyKey(tx, idempotencyKey, input);

    const catalogue = await loadCatalogue(tx, input);
    const candidates = await findEligibleWarehouses(
      tx,
      input.items,
      destination,
    );

    if (candidates.length === 0) {
      throw new AppError(
        409,
        'no_eligible_warehouse',
        'No single warehouse can fulfil every line of this order',
      );
    }

    for (const candidate of candidates) {
      const secured = await reserveStock(tx, candidate.id, input.items);
      if (!secured) continue;

      const { order, lines } = await insertOrder(tx, {
        input,
        catalogue,
        destination,
        warehouseId: candidate.id,
      });
      return { order, warehouse: candidate, lines };
    }

    // Every candidate was drained by a concurrent order between the read and
    // the lock. Reporting it as a conflict lets the client retry with a fresh
    // idempotency key against current stock.
    throw new AppError(
      409,
      'no_eligible_warehouse',
      'No single warehouse can fulfil every line of this order',
    );
  });

  return settlePayment(
    deps,
    idempotencyKey,
    reserved,
    input.payment.cardNumber,
  );
}

/**
 * A replay of a completed request returns the original response verbatim.
 * A replay that arrives while the first request is still in flight is
 * rejected rather than queued: the caller is a UI retrying a click, and
 * answering "in progress" is safer than risking a second charge.
 */
async function findReplay(
  db: Database,
  key: string,
  input: CreateOrderInput,
): Promise<OrderResponse | null> {
  const [existing] = await db
    .select()
    .from(idempotencyKeys)
    .where(eq(idempotencyKeys.key, key));

  if (!existing) return null;

  if (existing.requestFingerprint !== fingerprint(input)) {
    throw new AppError(
      422,
      'idempotency_key_reused',
      'This Idempotency-Key was already used with a different request body',
    );
  }

  if (existing.responseBody === null) {
    throw new AppError(
      409,
      'request_in_progress',
      'A request with this Idempotency-Key is still being processed',
    );
  }

  // A stored failure has to be replayed as that same failure. Returning its
  // body as if it were an order would report a declined payment as a success.
  const status = existing.responseStatus ?? 201;
  if (status >= 400) {
    const failure = existing.responseBody as { code: string; message: string };
    throw new AppError(status, failure.code, failure.message);
  }

  return existing.responseBody as OrderResponse;
}

async function claimIdempotencyKey(
  tx: Transaction,
  key: string,
  input: CreateOrderInput,
): Promise<void> {
  try {
    await tx
      .insert(idempotencyKeys)
      .values({ key, requestFingerprint: fingerprint(input) });
  } catch (error) {
    // Two identical requests raced past findReplay; the loser stops here.
    if (isUniqueViolation(error)) {
      throw new AppError(
        409,
        'request_in_progress',
        'A request with this Idempotency-Key is still being processed',
      );
    }
    throw error;
  }
}

type Catalogue = Map<string, { sku: string; priceCents: number }>;

/**
 * Prices come from the catalogue, never from the request. Trusting a
 * client-supplied amount is how an order for a $6,499 torch kit gets charged
 * as $0.01.
 */
async function loadCatalogue(
  tx: Transaction,
  input: CreateOrderInput,
): Promise<Catalogue> {
  const [customer] = await tx
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.id, input.customerId));

  if (!customer) {
    throw new AppError(404, 'customer_not_found', 'Unknown customer');
  }

  const ids = input.items.map((item) => item.productId);
  const rows = await tx
    .select({
      id: products.id,
      sku: products.sku,
      priceCents: products.priceCents,
    })
    .from(products)
    .where(inArray(products.id, ids));

  const catalogue: Catalogue = new Map(
    rows.map((row) => [row.id, { sku: row.sku, priceCents: row.priceCents }]),
  );

  const missing = ids.filter((id) => !catalogue.has(id));
  if (missing.length > 0) {
    throw new AppError(404, 'product_not_found', 'Unknown product', {
      productIds: missing,
    });
  }

  return catalogue;
}

/**
 * Locks the warehouse's rows for the requested products and decrements them.
 *
 * Rows are locked in a fixed order (by product id) so that two orders sharing
 * products can never take the same locks in opposite order and deadlock.
 * Returns false when the warehouse no longer has enough stock, which is
 * possible even though it qualified moments ago: the eligibility query ran
 * before any lock was held.
 */
async function reserveStock(
  tx: Transaction,
  warehouseId: string,
  items: CreateOrderInput['items'],
): Promise<boolean> {
  const ordered = [...items].sort((a, b) => a.productId.localeCompare(b.productId));

  const locked = await tx
    .select({
      productId: inventory.productId,
      quantity: inventory.quantity,
    })
    .from(inventory)
    .where(
      and(
        eq(inventory.warehouseId, warehouseId),
        inArray(
          inventory.productId,
          ordered.map((item) => item.productId),
        ),
      ),
    )
    .orderBy(inventory.productId)
    .for('update');

  const onHand = new Map(locked.map((row) => [row.productId, row.quantity]));
  const sufficient = ordered.every(
    (item) => (onHand.get(item.productId) ?? 0) >= item.quantity,
  );
  if (!sufficient) return false;

  await tx.execute(sql`
    update inventory as i
    set quantity = i.quantity - v.quantity, updated_at = now()
    from (values ${sql.join(
      ordered.map(
        (item) => sql`(${item.productId}::uuid, ${item.quantity}::integer)`,
      ),
      sql`, `,
    )}) as v (product_id, quantity)
    where i.warehouse_id = ${warehouseId}::uuid and i.product_id = v.product_id
  `);

  return true;
}

async function insertOrder(
  tx: Transaction,
  args: {
    input: CreateOrderInput;
    catalogue: Catalogue;
    destination: { latitude: number; longitude: number };
    warehouseId: string;
  },
) {
  const { input, catalogue, destination, warehouseId } = args;

  const lines: OrderLine[] = input.items.map((item) => {
    const product = catalogue.get(item.productId)!;
    return {
      productId: item.productId,
      sku: product.sku,
      quantity: item.quantity,
      unitPriceCents: product.priceCents,
    };
  });

  const totalCents = lines.reduce(
    (sum, line) => sum + line.unitPriceCents * line.quantity,
    0,
  );

  const [order] = await tx
    .insert(orders)
    .values({
      customerId: input.customerId,
      warehouseId,
      status: 'pending_payment',
      shippingLine1: input.shippingAddress.line1,
      shippingLine2: input.shippingAddress.line2 ?? null,
      shippingCity: input.shippingAddress.city,
      shippingState: input.shippingAddress.state,
      shippingPostalCode: input.shippingAddress.postalCode,
      shippingCountry: input.shippingAddress.country,
      shippingLatitude: destination.latitude,
      shippingLongitude: destination.longitude,
      totalCents,
      cardLast4: input.payment.cardNumber.slice(-4),
    })
    .returning();

  await tx.insert(orderItems).values(
    lines.map((line) => ({
      orderId: order!.id,
      productId: line.productId,
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
    })),
  );

  return { order: order!, lines };
}

type OrderLine = {
  productId: string;
  sku: string;
  quantity: number;
  unitPriceCents: number;
};

type ReservedOrder = {
  order: typeof orders.$inferSelect;
  warehouse: { id: string; name: string; distanceKm: number };
  lines: OrderLine[];
};

/**
 * Charges the card and settles the reserved order.
 *
 * The two failure modes are handled differently on purpose:
 *
 *  - A decline is a definitive "no". The order is marked failed and the
 *    reserved stock is released, because nobody was charged and holding the
 *    units would starve other customers.
 *  - An indeterminate result (timeout, dropped connection) is *not* rolled
 *    back. The charge may have succeeded, and releasing stock while the
 *    customer's card was debited is the one outcome that costs real money and
 *    real trust. The order stays `pending_payment` for reconciliation: a
 *    background worker replays the same idempotency key against the gateway,
 *    which either returns the original charge or confirms none exists.
 */
async function settlePayment(
  deps: OrderDependencies,
  idempotencyKey: string,
  reserved: ReservedOrder,
  /**
   * The only place the full number is used. It lives in memory for the
   * duration of the request, is handed to the gateway, and is never written
   * to the database or to a log.
   */
  cardNumber: string,
): Promise<OrderResponse> {
  const { order } = reserved;

  let paymentId: string;
  try {
    const charge = await deps.payments.charge({
      idempotencyKey,
      cardNumber,
      amountCents: order.totalCents,
      currency: order.currency,
      description: `Order ${order.id}`,
    });
    paymentId = charge.paymentId;
  } catch (error) {
    if (error instanceof AppError && error.code === PAYMENT_INDETERMINATE) {
      await deps.db
        .update(orders)
        .set({ paymentFailureReason: error.message, updatedAt: new Date() })
        .where(eq(orders.id, order.id));
      throw error;
    }

    await releaseReservation(deps, idempotencyKey, reserved, error);
    throw error;
  }

  const response = await deps.db.transaction(async (tx) => {
    const [settled] = await tx
      .update(orders)
      .set({ status: 'paid', paymentId, updatedAt: new Date() })
      .where(eq(orders.id, order.id))
      .returning();

    const body = toOrderResponse(settled!, reserved);
    await tx
      .update(idempotencyKeys)
      .set({ orderId: order.id, responseStatus: 201, responseBody: body })
      .where(eq(idempotencyKeys.key, idempotencyKey));

    return body;
  });

  return response;
}

/** Compensating transaction for a declined charge. */
async function releaseReservation(
  deps: OrderDependencies,
  idempotencyKey: string,
  reserved: ReservedOrder,
  error: unknown,
): Promise<void> {
  const { order } = reserved;
  const failure =
    error instanceof AppError
      ? { status: error.status, code: error.code, message: error.message }
      : { status: 502, code: 'payment_error', message: 'Payment failed' };

  await deps.db.transaction(async (tx) => {
    const lines = await tx
      .select({
        productId: orderItems.productId,
        quantity: orderItems.quantity,
      })
      .from(orderItems)
      .where(eq(orderItems.orderId, order.id))
      .orderBy(orderItems.productId);

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

    await tx
      .update(orders)
      .set({
        status: 'payment_failed',
        paymentFailureReason: failure.message,
        updatedAt: new Date(),
      })
      .where(eq(orders.id, order.id));

    // Recording the failure lets a retry of the same key return the same
    // answer instead of attempting a second charge.
    await tx
      .update(idempotencyKeys)
      .set({
        orderId: order.id,
        responseStatus: failure.status,
        responseBody: { code: failure.code, message: failure.message },
      })
      .where(eq(idempotencyKeys.key, idempotencyKey));
  });
}

function toOrderResponse(
  order: typeof orders.$inferSelect,
  reserved: ReservedOrder,
): OrderResponse {
  return {
    id: order.id,
    status: order.status,
    customerId: order.customerId,
    warehouse: {
      id: reserved.warehouse.id,
      name: reserved.warehouse.name,
      distanceKm: Math.round(reserved.warehouse.distanceKm * 10) / 10,
    },
    items: reserved.lines,
    totalCents: order.totalCents,
    currency: order.currency,
    paymentId: order.paymentId,
    cardLast4: order.cardLast4,
    createdAt: order.createdAt.toISOString(),
  };
}
