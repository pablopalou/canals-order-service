import { db, pool } from './client.ts';
import {
  applySeed,
  CUSTOMERS,
  INVENTORY,
  PRODUCTS,
  WAREHOUSES,
} from './seed-data.ts';

await db.transaction(applySeed);

console.log(
  `seeded ${CUSTOMERS.length} customers, ${PRODUCTS.length} products, ` +
    `${WAREHOUSES.length} warehouses, ${INVENTORY.length} inventory rows`,
);
await pool.end();
