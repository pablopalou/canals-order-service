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
import { AppError, postgresErrorCode } from '../errors.ts';
import type {
  Address,
  Coordinates,
  GeocodingProvider,
} from '../services/geocoding.ts';
import {
  PAYMENT_DECLINED,
  PAYMENT_INDETERMINATE,
  type PaymentGateway,
} from '../services/payments.ts';
import {
  failAndReleaseStock,
  loadOrderLines,
  markPaid,
  recordResponse,
  toOrderResponse,
  type Order,
  type OrderLine,
  type OrderResponse,
} from './order-settlement.ts';
import {
  distanceToWarehouse,
  findEligibleWarehouses,
} from './warehouse-selection.ts';

const PG_UNIQUE_VIOLATION = '23505';
const PG_LOCK_NOT_AVAILABLE = '55P03';

export type CreateOrderInput = {
  customerId: string;
  shippingAddress: Address;
  items: Array<{ productId: string; quantity: number }>;
  payment: { cardNumber: string };
};

export type { OrderResponse };

/**
 * The subset of a logger this module needs. Depending on the shape rather
 * than on Fastify's logger keeps the domain free of the web framework.
 */
export type Logger = {
  error(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
  info(context: Record<string, unknown>, message: string): void;
};

export type OrderDependencies = {
  db: Database;
  geocoding: GeocodingProvider;
  payments: PaymentGateway;
  logger: Logger;
};

/**
 * Stable fingerprint of the request an idempotency key was first used with.
 *
 * Every field is written out in a fixed order rather than spread from the
 * parsed body, because JSON.stringify serialises keys in insertion order: an
 * address whose optional line2 was omitted produces a different string from
 * the same address that sent line2 as null, and the two would be reported as
 * a key reused with a different body. Lines are sorted for the same reason —
 * the same cart in a different order is the same cart.
 */
const fingerprint = (input: CreateOrderInput): string => {
  const address = input.shippingAddress;
  const canonical = {
    customerId: input.customerId,
    shippingAddress: [
      address.line1,
      address.line2 ?? null,
      address.city,
      address.state,
      address.postalCode,
      address.country,
    ],
    items: [...input.items]
      .map((item) => [item.productId, item.quantity] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    cardLast4: input.payment.cardNumber.slice(-4),
  };

  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
};

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
  // Its failures are handled where the provider is wired (server.ts): the
  // withGeocodingTimeout wrapper bounds the call and turns a timeout or a
  // provider error into a retryable 503, before anything has been reserved.
  const destination = await deps.geocoding.geocode(input.shippingAddress);

  const reserved = await reserveOrder(deps, input, destination, idempotencyKey);

  return await settlePayment(
    deps,
    idempotencyKey,
    reserved,
    input.payment.cardNumber,
  );
}

const noEligibleWarehouse = () =>
  new AppError(
    409,
    'no_eligible_warehouse',
    'No single warehouse can fulfil every line of this order',
  );

/**
 * Step one: claim the idempotency key, choose a warehouse, take the stock and
 * write the order, all in one transaction. Either the whole reservation
 * exists after this returns, or none of it does.
 */
async function reserveOrder(
  deps: OrderDependencies,
  input: CreateOrderInput,
  destination: Coordinates,
  idempotencyKey: string,
): Promise<ReservedOrder> {
  return await withLockContentionMapped(() =>
    deps.db.transaction(async (tx) => {
      await claimIdempotencyKey(tx, idempotencyKey, input);
      await assertCustomerExists(tx, input.customerId);
      const catalogue = await loadCatalogue(tx, input.items);

      const candidates = await findEligibleWarehouses(
        tx,
        input.items,
        destination,
      );
      if (candidates.length === 0) throw noEligibleWarehouse();

      for (const candidate of candidates) {
        const secured = await reserveStock(tx, candidate.id, input.items);
        if (!secured) continue;

        const { order, lines } = await insertOrder(tx, {
          input,
          catalogue,
          destination,
          warehouseId: candidate.id,
        });

        // Linked now rather than at settlement: if this process dies before
        // settling, reconciliation starts from the order and needs its key.
        await tx
          .update(idempotencyKeys)
          .set({ orderId: order.id })
          .where(eq(idempotencyKeys.key, idempotencyKey));

        return { order, warehouse: candidate, lines };
      }

      // Every candidate was drained by a concurrent order between the
      // eligibility read and the lock. A conflict lets the client retry with a
      // fresh idempotency key against current stock.
      throw noEligibleWarehouse();
    }),
  );
}

/**
 * A checkout that waited too long for a row lock is not a server fault: some
 * other order is holding the same SKU. Saying so, with a status the client
 * knows to retry, beats an opaque 500.
 */
async function withLockContentionMapped<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (postgresErrorCode(error) === PG_LOCK_NOT_AVAILABLE) {
      throw new AppError(
        503,
        'stock_contended',
        'The requested stock is being updated by another order. Retry shortly.',
      );
    }
    throw error;
  }
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
    if (postgresErrorCode(error) === PG_UNIQUE_VIOLATION) {
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
async function assertCustomerExists(
  tx: Transaction,
  customerId: string,
): Promise<void> {
  const [customer] = await tx
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.id, customerId));

  if (!customer) {
    throw new AppError(404, 'customer_not_found', 'Unknown customer');
  }
}

async function loadCatalogue(
  tx: Transaction,
  items: CreateOrderInput['items'],
): Promise<Catalogue> {
  const ids = items.map((item) => item.productId);
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
 * The `order by product_id` on the locking select is what prevents deadlocks:
 * Postgres plans it as LockRows above Sort, so rows are locked in product id
 * order no matter what order the client listed them in. Two orders sharing
 * products therefore always contend in the same direction; one waits, neither
 * deadlocks. (`explain` on that statement shows the LockRows node sitting
 * above the Sort.)
 *
 * Returns false when the warehouse no longer has enough stock, which is
 * possible even though it qualified moments ago: the eligibility query ran
 * before any lock was held.
 */
async function reserveStock(
  tx: Transaction,
  warehouseId: string,
  items: CreateOrderInput['items'],
): Promise<boolean> {
  const productIds = items.map((item) => item.productId);

  const locked = await tx
    .select({
      productId: inventory.productId,
      quantity: inventory.quantity,
    })
    .from(inventory)
    .where(
      and(
        eq(inventory.warehouseId, warehouseId),
        inArray(inventory.productId, productIds),
      ),
    )
    .orderBy(inventory.productId)
    .for('update');

  const onHand = new Map(locked.map((row) => [row.productId, row.quantity]));
  const sufficient = items.every(
    (item) => (onHand.get(item.productId) ?? 0) >= item.quantity,
  );
  if (!sufficient) return false;

  await tx.execute(sql`
    update inventory as i
    set quantity = i.quantity - v.quantity, updated_at = now()
    from (values ${sql.join(
      items.map(
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

type ReservedOrder = {
  order: Order;
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
 *  - Everything else is indeterminate and is *not* rolled back: our timeout,
 *    a dropped connection, a response we did not expect. The charge may have succeeded, and releasing stock while the
 *    customer's card was debited is the one outcome that costs real money and
 *    real trust. The order stays `pending_payment`, and reconciliation later
 *    asks the gateway what became of the charge made under this key.
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
    // Bounded by the withTimeout wrapper applied in server.ts; a timeout
    // arrives here as payment_indeterminate and is handled below.
    const charge = await deps.payments.charge({
      idempotencyKey,
      cardNumber,
      amountCents: order.totalCents,
      currency: order.currency,
      description: `Order ${order.id}`,
    });
    paymentId = charge.paymentId;
  } catch (error) {
    // The default has to be "we do not know". Only an explicit decline from
    // the gateway proves that no money moved; anything else — a socket hang
    // up from a real HTTP client, a 5xx, a malformed response — is exactly as
    // uncertain as a timeout. Treating unrecognised errors as declines would
    // release the stock of an order the customer may already have paid for.
    if (!(error instanceof AppError && error.code === PAYMENT_DECLINED)) {
      throw await leavePendingForReconciliation(deps, order, error);
    }

    // If the compensation itself fails, the payment error is still the truth
    // the caller needs. Letting the secondary failure propagate would report a
    // declined card as an internal error and lose the reason entirely. The
    // order stays pending_payment, so reconciliation will resolve it.
    try {
      await releaseReservation(deps, idempotencyKey, reserved, error);
    } catch (compensationError) {
      deps.logger.error(
        {
          err: compensationError,
          orderId: order.id,
          warehouseId: order.warehouseId,
          originalError: error.message,
        },
        'failed to release reservation after a failed charge; stock is stranded',
      );
    }
    throw error;
  }

  return await deps.db.transaction(async (tx) => {
    const settled = await markPaid(tx, order.id, paymentId);

    if (!settled) {
      // Reconciliation reached this order first. That can only happen when
      // this request outlived the reconciliation threshold, which config
      // validation keeps well above the payment timeout — but it is money, so
      // it is handled rather than assumed away.
      return await resolveLateSettlement(deps, tx, reserved, paymentId);
    }

    const body = toOrderResponse(settled, reserved.warehouse, reserved.lines);
    await recordResponse(tx, idempotencyKey, {
      orderId: order.id,
      status: 201,
      body,
    });
    return body;
  });
}

/**
 * The charge succeeded but the order had already been settled by
 * reconciliation. If reconciliation also found the charge, the outcome agrees
 * and the order is simply returned. If it concluded there was no charge and
 * released the stock, the customer has now paid for a cancelled order: that
 * needs a refund, and it is logged as such rather than silently swallowed.
 */
async function resolveLateSettlement(
  deps: OrderDependencies,
  tx: Transaction,
  reserved: ReservedOrder,
  paymentId: string,
): Promise<OrderResponse> {
  const [current] = await tx
    .select()
    .from(orders)
    .where(eq(orders.id, reserved.order.id));

  if (current?.status === 'paid') {
    return toOrderResponse(current, reserved.warehouse, reserved.lines);
  }

  deps.logger.error(
    { orderId: reserved.order.id, paymentId, status: current?.status },
    'charge captured for an order reconciliation already cancelled; refund required',
  );
  throw new AppError(
    409,
    'order_already_resolved',
    'This order was cancelled before its payment was confirmed',
  );
}

/**
 * The charge's outcome is unknown. The order and its stock stay exactly as
 * they are, the key gets no recorded response (so a retry is told the request
 * is in progress rather than charging again), and reconciliation later asks
 * the gateway what happened.
 *
 * Whatever the gateway client threw is translated here into the one error the
 * caller should see. Left as-is, a connection error from the gateway carrying
 * ECONNRESET was reported to the client as the *database* being unavailable.
 */
async function leavePendingForReconciliation(
  deps: OrderDependencies,
  order: Order,
  cause: unknown,
): Promise<AppError> {
  const indeterminate =
    cause instanceof AppError && cause.code === PAYMENT_INDETERMINATE
      ? cause
      : new AppError(
          504,
          PAYMENT_INDETERMINATE,
          'The payment outcome could not be confirmed; the order will be reconciled',
        );

  // Money in an unknown state is worth more than an info line.
  deps.logger.warn(
    { err: cause, orderId: order.id, totalCents: order.totalCents },
    'charge outcome unknown; order left pending for reconciliation',
  );

  await deps.db
    .update(orders)
    .set({ paymentFailureReason: indeterminate.message, updatedAt: new Date() })
    .where(and(eq(orders.id, order.id), eq(orders.status, 'pending_payment')));

  return indeterminate;
}

/** Compensating transaction for a declined charge. */
async function releaseReservation(
  deps: OrderDependencies,
  idempotencyKey: string,
  reserved: ReservedOrder,
  decline: AppError,
): Promise<void> {
  const { order } = reserved;
  const failure = {
    status: decline.status,
    code: decline.code,
    message: decline.message,
  };

  await deps.db.transaction(async (tx) => {
    const failed = await failAndReleaseStock(tx, order.id, failure.message);
    if (!failed) return;

    // Recording the failure lets a retry of the same key return the same
    // answer instead of attempting a second charge.
    await recordResponse(tx, idempotencyKey, {
      orderId: order.id,
      status: failure.status,
      body: { code: failure.code, message: failure.message },
    });
  });
}

/**
 * Reads an order back, in the same representation POST /orders returns. The
 * distance is recomputed from the coordinates persisted on the order with the
 * same formula selection used, so both endpoints agree.
 */
export async function findOrder(
  db: Database,
  id: string,
): Promise<OrderResponse | null> {
  const [order] = await db.select().from(orders).where(eq(orders.id, id));
  if (!order) return null;

  const warehouse = await distanceToWarehouse(db, order.warehouseId, {
    latitude: order.shippingLatitude,
    longitude: order.shippingLongitude,
  });
  const lines = await loadOrderLines(db, order.id);
  return toOrderResponse(order, warehouse, lines);
}
