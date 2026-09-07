import { sql } from 'drizzle-orm';
import {
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
 */
const cents = (name: string) => integer(name);

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

    totalCents: cents('total_cents').notNull(),
    currency: text('currency').notNull().default('USD'),

    // PCI: the PAN is never persisted or logged. Only the last four digits are
    // kept, which is what a support agent needs to identify the card.
    cardLast4: text('card_last4').notNull(),
    paymentId: text('payment_id'),
    paymentFailureReason: text('payment_failure_reason'),

    createdAt,
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('orders_customer_id_created_at_idx').on(t.customerId, t.createdAt),
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
export const idempotencyKeys = pgTable('idempotency_keys', {
  key: text('key').primaryKey(),
  // Guards against a client reusing one key for a different payload.
  requestFingerprint: text('request_fingerprint').notNull(),
  orderId: uuid('order_id').references(() => orders.id, {
    onDelete: 'cascade',
  }),
  responseStatus: integer('response_status'),
  responseBody: jsonb('response_body'),
  createdAt,
});
