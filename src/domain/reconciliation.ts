import { eq, inArray, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../db/client.ts';
import { idempotencyKeys, orders } from '../db/schema.ts';
import type { PaymentGateway } from '../services/payments.ts';
import {
  failAndReleaseStock,
  loadOrderLines,
  markPaid,
  recordResponse,
  toOrderResponse,
  type Order,
  type OrderResponse,
} from './order-settlement.ts';
import type { Logger } from './orders.ts';
import { runPeriodically, type Scheduled } from '../scheduler.ts';
import { distanceToWarehouse } from './warehouse-selection.ts';

/**
 * Resolves orders left in `pending_payment`.
 *
 * An order ends up there when the outcome of its charge is unknown — the
 * gateway timed out, or the process died between charging and settling. The
 * reserved stock stays held so a customer is never charged for units that
 * were given away, but held forever it would starve everyone else. This asks
 * the gateway what actually became of each charge and settles accordingly.
 */

export type ReconciliationDependencies = {
  db: Database;
  payments: PaymentGateway;
  logger: Logger;
};

export type ReconciliationOptions = {
  /**
   * Only orders untouched for at least this long are considered. It must be
   * comfortably longer than the payment timeout: if reconciliation asked about
   * a charge still on its way to the gateway, it would be told none exists,
   * release the stock, and watch the charge land a moment later.
   */
  olderThanMs: number;
  /** Upper bound on orders claimed per pass. */
  batchSize: number;
};

export type ReconciliationReport = {
  claimed: number;
  /** The gateway had the charge: the order is now paid. */
  paid: number;
  /** The gateway had no charge: the order is cancelled and its stock back. */
  released: number;
  /** The gateway could not be asked; the order will be tried again. */
  unresolved: number;
  /** Something else settled the order between the claim and now. */
  skipped: number;
};

/**
 * An order the gateway has not been able to tell us about after this many
 * passes is not going to resolve itself, and someone should look at it.
 */
const ESCALATE_AFTER_ATTEMPTS = 10;

const CANCELLED_REASON =
  'The gateway holds no charge for this order; cancelled by reconciliation';

export async function reconcilePendingOrders(
  deps: ReconciliationDependencies,
  options: ReconciliationOptions,
): Promise<ReconciliationReport> {
  const claimed = await claimStuckOrders(deps.db, options);
  const report: ReconciliationReport = {
    claimed: claimed.length,
    paid: 0,
    released: 0,
    unresolved: 0,
    skipped: 0,
  };

  // One at a time on purpose: a pass is not latency sensitive, and a burst of
  // parallel lookups is exactly what a struggling gateway does not need.
  for (const order of claimed) {
    report[await reconcileOrder(deps, order)]++;
  }

  return report;
}

/**
 * Claims a batch of stuck orders so that no other reconciler works on them.
 *
 * Every replica runs reconciliation, so claiming has to be safe under
 * concurrency without holding anything open during the gateway calls that
 * follow. `for update skip locked` makes concurrent claims pass over rows
 * another pass is already claiming instead of waiting for them, and bumping
 * `updated_at` in the same statement acts as a lease: a claimed order does not
 * look stuck again until another full threshold has passed. If this process
 * dies mid-pass, its orders simply become eligible again.
 */
async function claimStuckOrders(
  db: Database,
  { olderThanMs, batchSize }: ReconciliationOptions,
): Promise<Order[]> {
  const result = await db.execute(sql`
    with stuck as (
      select id from orders
      where status = 'pending_payment'
        and updated_at < now() - (${olderThanMs}::integer * interval '1 millisecond')
      order by updated_at
      limit ${batchSize}::integer
      for update skip locked
    )
    update orders as o
    set updated_at = now(),
        reconciliation_attempts = o.reconciliation_attempts + 1
    from stuck
    where o.id = stuck.id
    returning o.id
  `);

  const ids = (result.rows as Array<{ id: string }>).map((row) => row.id);
  if (ids.length === 0) return [];

  return await db.select().from(orders).where(inArray(orders.id, ids));
}

async function reconcileOrder(
  deps: ReconciliationDependencies,
  order: Order,
): Promise<'paid' | 'released' | 'unresolved' | 'skipped'> {
  const [record] = await deps.db
    .select({ key: idempotencyKeys.key })
    .from(idempotencyKeys)
    .where(eq(idempotencyKeys.orderId, order.id));

  if (!record) {
    // Without the key there is nothing to ask the gateway about, and guessing
    // either way is how money goes missing.
    deps.logger.error(
      { orderId: order.id },
      'pending order has no idempotency key; it cannot be reconciled automatically',
    );
    return 'unresolved';
  }

  let charge: Awaited<ReturnType<PaymentGateway['findCharge']>>;
  try {
    charge = await deps.payments.findCharge(record.key);
  } catch (error) {
    const context = {
      err: error,
      orderId: order.id,
      attempts: order.reconciliationAttempts,
    };
    if (order.reconciliationAttempts >= ESCALATE_AFTER_ATTEMPTS) {
      deps.logger.error(
        context,
        'gateway still cannot confirm this charge after repeated attempts; needs attention',
      );
    } else {
      deps.logger.warn(context, 'could not reach the gateway to reconcile; will retry');
    }
    return 'unresolved';
  }

  return await deps.db.transaction(async (tx) => {
    if (charge) {
      const settled = await markPaid(tx, order.id, charge.paymentId);
      if (!settled) return 'skipped';

      await recordResponse(tx, record.key, {
        orderId: order.id,
        status: 201,
        body: await rebuildResponse(tx, settled),
      });
      deps.logger.info(
        { orderId: order.id, paymentId: charge.paymentId },
        'reconciled: charge confirmed, order paid',
      );
      return 'paid';
    }

    const cancelled = await failAndReleaseStock(tx, order.id, CANCELLED_REASON);
    if (!cancelled) return 'skipped';

    // The client was last told the outcome was unknown. A replay of its key now
    // gets the real answer instead of "in progress" forever.
    await recordResponse(tx, record.key, {
      orderId: order.id,
      status: 402,
      body: {
        code: 'payment_not_completed',
        message:
          'The payment could not be confirmed, so the order was cancelled. No charge was made.',
      },
    });
    deps.logger.info(
      { orderId: order.id },
      'reconciled: no charge found, order cancelled and stock released',
    );
    return 'released';
  });
}

/**
 * The same response the original request would have returned. The request
 * that chose the warehouse is gone, so the distance is recomputed from the
 * coordinates persisted on the order, with the same formula selection uses.
 */
async function rebuildResponse(
  tx: Transaction,
  order: Order,
): Promise<OrderResponse> {
  const warehouse = await distanceToWarehouse(tx, order.warehouseId, {
    latitude: order.shippingLatitude,
    longitude: order.shippingLongitude,
  });
  const lines = await loadOrderLines(tx, order.id);
  return toOrderResponse(order, warehouse, lines);
}

export type Reconciler = Scheduled;

/**
 * Runs reconciliation on an interval. Across processes, the claim is what
 * keeps two passes off the same order.
 */
export function startReconciler(
  deps: ReconciliationDependencies,
  options: ReconciliationOptions & { intervalMs: number },
): Reconciler {
  return runPeriodically(
    'reconciliation',
    options.intervalMs,
    async () => {
      const report = await reconcilePendingOrders(deps, options);
      if (report.claimed > 0) {
        deps.logger.info({ ...report }, 'reconciliation pass complete');
      }
    },
    deps.logger,
  );
}
