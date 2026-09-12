import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq } from 'drizzle-orm';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import * as schema from '../src/db/schema.ts';
import { applySeed, productIdBySku, warehouseIdByName } from '../src/db/seed-data.ts';
import { MockGeocodingProvider } from '../src/services/geocoding.ts';
import {
  MockPaymentGateway,
  type PaymentGateway,
} from '../src/services/payments.ts';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
});

export const db = drizzle(pool, { schema });

/** Restores the fixture data. Called before every test for isolation. */
export const resetDatabase = () => db.transaction(applySeed);

let poolClosed = false;

/**
 * Idempotent: a test file with several suites would otherwise close the shared
 * pool when its first suite finishes, and every later suite would fail on a
 * pool that is already gone.
 */
export const closeDatabase = async (): Promise<void> => {
  if (poolClosed) return;
  poolClosed = true;
  await pool.end();
};

export const productId = (sku: string): string => productIdBySku.get(sku)!;
export const warehouseId = (name: string): string => warehouseIdByName.get(name)!;

export const CUSTOMER_ID = '30000000-0000-4000-8000-000000000001';

/** Passes the Luhn check; the mock gateway approves anything not marked. */
export const GOOD_CARD = '4242424242424242';
export const DECLINED_CARD = '4000000000000002';
export const TIMEOUT_CARD = '4000000000000069';

export const PHILADELPHIA = {
  line1: '1600 Market St',
  city: 'Philadelphia',
  state: 'PA',
  postalCode: '19103',
  country: 'US',
};

export async function stockOf(
  warehouseName: string,
  sku: string,
): Promise<number> {
  const [row] = await db
    .select({ quantity: schema.inventory.quantity })
    .from(schema.inventory)
    .where(
      and(
        eq(schema.inventory.warehouseId, warehouseId(warehouseName)),
        eq(schema.inventory.productId, productId(sku)),
      ),
    );
  return row?.quantity ?? 0;
}

export function orderPayload(overrides: {
  items: Array<{ sku: string; quantity: number }>;
  cardNumber?: string;
  customerId?: string;
}) {
  return {
    customerId: overrides.customerId ?? CUSTOMER_ID,
    shippingAddress: PHILADELPHIA,
    items: overrides.items.map((item) => ({
      productId: productId(item.sku),
      quantity: item.quantity,
    })),
    payment: { cardNumber: overrides.cardNumber ?? GOOD_CARD },
  };
}

export async function buildTestApp(
  payments: PaymentGateway = new MockPaymentGateway(),
): Promise<FastifyInstance> {
  return buildApp({
    db,
    geocoding: new MockGeocodingProvider(),
    payments,
  });
}
