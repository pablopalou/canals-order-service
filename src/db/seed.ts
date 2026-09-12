import { count } from 'drizzle-orm';
import { db, pool } from './client.ts';
import {
  applySeed,
  CUSTOMERS,
  INVENTORY,
  PRODUCTS,
  WAREHOUSES,
} from './seed-data.ts';
import { products } from './schema.ts';

/**
 * `--if-empty` seeds only a database with no catalogue yet, which is what
 * container start-up wants: repeated `docker compose up` must not wipe the
 * orders placed against the previous run. Without the flag the seed is a
 * deliberate reset back to the documented fixture.
 */
const onlyIfEmpty = process.argv.includes('--if-empty');

if (onlyIfEmpty) {
  const [existing] = await db.select({ value: count() }).from(products);
  if ((existing?.value ?? 0) > 0) {
    console.log('catalogue already present, leaving data untouched');
    await pool.end();
    process.exit(0);
  }
}

await db.transaction(applySeed);

console.log(
  `seeded ${CUSTOMERS.length} customers, ${PRODUCTS.length} products, ` +
    `${WAREHOUSES.length} warehouses, ${INVENTORY.length} inventory rows`,
);
await pool.end();
