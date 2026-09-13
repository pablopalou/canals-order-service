import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Money is stored as integer cents. Floating point is never acceptable for
 * money: 0.1 + 0.2 !== 0.3 and rounding errors compound across order lines.
 *
 * Per-unit prices fit comfortably in 32 bits. Order totals do not: a 200-line
 * order of a high-priced SKU passes 21 million dollars, where an integer
 * column overflows and the insert fails. Totals are therefore 64-bit, which
 * JavaScript can still represent exactly (Number.MAX_SAFE_INTEGER is about
 * 90 trillion dollars in cents).
 */
const cents = (name: string) => integer(name);
const totalCents = (name: string) => bigint(name, { mode: 'number' });

const createdAt = timestamp('created_at', { withTimezone: true })
  .notNull()
  .defaultNow();

export const customers = pgTable('customers', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  createdAt,
});

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sku: text('sku').notNull().unique(),
    name: text('name').notNull(),
    priceCents: cents('price_cents').notNull(),
    createdAt,
  },
  (t) => [check('products_price_positive', sql`${t.priceCents} > 0`)],
);

export const warehouses = pgTable(
  'warehouses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    latitude: doublePrecision('latitude').notNull(),
    longitude: doublePrecision('longitude').notNull(),
    createdAt,
  },
  (t) => [
    check('warehouses_lat_range', sql`${t.latitude} between -90 and 90`),
    check('warehouses_lon_range', sql`${t.longitude} between -180 and 180`),
  ],
);

/**
 * On-hand stock per (warehouse, product). Rows are locked FOR UPDATE while an
 * order reserves them, and the CHECK constraint is the last line of defence
 * against overselling if application-level locking is ever bypassed.
 */
export const inventory = pgTable(
  'inventory',
  {
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id, { onDelete: 'restrict' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    quantity: integer('quantity').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.warehouseId, t.productId] }),
    // Warehouse selection filters by the products in the cart, so the lookup
    // starts from product_id; the PK index (warehouse_id first) can't serve it.
    index('inventory_product_id_idx').on(t.productId),
    check('inventory_quantity_non_negative', sql`${t.quantity} >= 0`),
  ],
);

export const orderStatus = pgEnum('order_status', [
  'pending_payment',
  'paid',
  'payment_failed',
]);

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id, { onDelete: 'restrict' }),
    status: orderStatus('status').notNull().default('pending_payment'),

    shippingLine1: text('shipping_line1').notNull(),
    shippingLine2: text('shipping_line2'),
    shippingCity: text('shipping_city').notNull(),
    shippingState: text('shipping_state').notNull(),
    shippingPostalCode: text('shipping_postal_code').notNull(),
    shippingCountry: text('shipping_country').notNull(),
    // Resolved by the geocoding provider at order time and persisted, so the
    // warehouse choice stays auditable even if the provider later disagrees.
    shippingLatitude: doublePrecision('shipping_latitude').notNull(),
    shippingLongitude: doublePrecision('shipping_longitude').notNull(),

    totalCents: totalCents('total_cents').notNull(),
    currency: text('currency').notNull().default('USD'),

    // PCI: the PAN is never persisted or logged. Only the last four digits are
    // kept, which is what a support agent needs to identify the card.
    cardLast4: text('card_last4').notNull(),
    paymentId: text('payment_id'),
    paymentFailureReason: text('payment_failure_reason'),
    // How many times reconciliation has looked at this order without being
    // able to settle it. Surfaces an order the gateway will not answer about.
    reconciliationAttempts: integer('reconciliation_attempts')
      .notNull()
      .default(0),

    createdAt,
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('orders_customer_id_created_at_idx').on(t.customerId, t.createdAt),
    // Reconciliation only ever looks for orders stuck in pending_payment.
    // A partial index holds just those rows, so it stays tiny however many
    // settled orders the table accumulates.
    index('orders_pending_payment_updated_at_idx')
      .on(t.updatedAt)
      .where(sql`${t.status} = 'pending_payment'`),
    check('orders_total_positive', sql`${t.totalCents} > 0`),
    check('orders_card_last4_format', sql`${t.cardLast4} ~ '^[0-9]{4}$'`),
    check('orders_currency_format', sql`${t.currency} ~ '^[A-Z]{3}$'`),
  ],
);

/**
 * Unit price is a snapshot taken when the order is placed. Joining to
 * products at read time would silently rewrite order history whenever the
 * catalogue price changes.
 */
export const orderItems = pgTable(
  'order_items',
  {
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    quantity: integer('quantity').notNull(),
    unitPriceCents: cents('unit_price_cents').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.orderId, t.productId] }),
    check('order_items_quantity_positive', sql`${t.quantity} > 0`),
    check('order_items_unit_price_positive', sql`${t.unitPriceCents} > 0`),
  ],
);

/**
 * Idempotency records for POST /orders. The UI calls this endpoint on a user
 * click, so double submits and client retries are expected traffic, and a
 * retry must never place a second order or charge a second time.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    key: text('key').primaryKey(),
    // Guards against a client reusing one key for a different payload.
    requestFingerprint: text('request_fingerprint').notNull(),
    orderId: uuid('order_id').references(() => orders.id, {
      onDelete: 'cascade',
    }),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    createdAt,
  },
  (t) => [
    // Reconciliation starts from an order and needs the key it was placed with.
    index('idempotency_keys_order_id_idx').on(t.orderId),
    // Retention deletes settled keys by age. Keys still awaiting an outcome
    // are never candidates, so they are left out of the index entirely.
    index('idempotency_keys_settled_created_at_idx')
      .on(t.createdAt)
      .where(sql`${t.responseStatus} is not null`),
  ],
);
