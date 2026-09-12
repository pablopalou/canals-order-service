import { sql } from 'drizzle-orm';
import type { Database, Transaction } from './client.ts';
import { customers, inventory, products, warehouses } from './schema.ts';

/**
 * Deterministic fixture data, shared by the seed script and the test suite so
 * the scenarios documented in the README and the ones under test cannot drift
 * apart. IDs are fixed so the curl examples run verbatim on a fresh database.
 */

export const CUSTOMERS = [
  {
    id: '30000000-0000-4000-8000-000000000001',
    name: 'Atlantic Plumbing Supply',
    email: 'orders@atlanticplumbing.example',
  },
  {
    id: '30000000-0000-4000-8000-000000000002',
    name: 'Cascade Mechanical',
    email: 'purchasing@cascademech.example',
  },
];

export const PRODUCTS = [
  { sku: 'CU-ELB-050', name: '1/2 in Copper 90 Degree Elbow', priceCents: 189 },
  { sku: 'CU-PIPE-050-10', name: '1/2 in x 10 ft Copper Pipe, Type L', priceCents: 3450 },
  { sku: 'PVC-TEE-075', name: '3/4 in PVC Tee, Schedule 40', priceCents: 129 },
  { sku: 'BALL-VLV-100', name: '1 in Brass Ball Valve', priceCents: 1875 },
  { sku: 'WIRE-12-500', name: '12 AWG THHN Wire, 500 ft Spool', priceCents: 8990 },
  { sku: 'BRK-20A', name: '20A Single Pole Circuit Breaker', priceCents: 1240 },
  { sku: 'PEX-050-100', name: '1/2 in PEX-A Tubing, 100 ft Coil', priceCents: 4599 },
  { sku: 'SOLD-LF-1LB', name: 'Lead-Free Solder, 1 lb', priceCents: 2799 },
  { sku: 'TORCH-KIT', name: 'MAPP Gas Torch Kit', priceCents: 6499 },
  { sku: 'FLUX-8OZ', name: 'Water-Soluble Flux, 8 oz', priceCents: 899 },
].map((product, index) => ({
  ...product,
  id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
}));

export const WAREHOUSES = [
  { id: '20000000-0000-4000-8000-000000000001', name: 'Newark NJ', latitude: 40.7357, longitude: -74.1724 },
  { id: '20000000-0000-4000-8000-000000000002', name: 'Atlanta GA', latitude: 33.749, longitude: -84.388 },
  { id: '20000000-0000-4000-8000-000000000003', name: 'Chicago IL', latitude: 41.8781, longitude: -87.6298 },
  { id: '20000000-0000-4000-8000-000000000004', name: 'Dallas TX', latitude: 32.7767, longitude: -96.797 },
  { id: '20000000-0000-4000-8000-000000000005', name: 'Los Angeles CA', latitude: 34.0522, longitude: -118.2437 },
];

export const productIdBySku = new Map(PRODUCTS.map((p) => [p.sku, p.id]));
export const warehouseIdByName = new Map(WAREHOUSES.map((w) => [w.name, w.id]));

/**
 * Stock is uneven on purpose, so that the selection rule is observable:
 *  - TORCH-KIT is stocked only in Dallas (one unit) and Los Angeles, so an
 *    order combining it with a common SKU cannot be filled by the warehouse
 *    nearest to an east coast address.
 *  - FLUX-8OZ exists as a single unit in a single warehouse, which is what
 *    the concurrency scenario races on.
 */
export const STOCK: Record<string, Record<string, number>> = {
  'Newark NJ': {
    'CU-ELB-050': 120, 'CU-PIPE-050-10': 40, 'PVC-TEE-075': 200, 'BALL-VLV-100': 35,
    'WIRE-12-500': 12, 'BRK-20A': 80, 'PEX-050-100': 25, 'SOLD-LF-1LB': 60, 'FLUX-8OZ': 1,
  },
  'Atlanta GA': {
    'CU-ELB-050': 90, 'CU-PIPE-050-10': 20, 'PVC-TEE-075': 150, 'BALL-VLV-100': 10,
    'WIRE-12-500': 5, 'BRK-20A': 40, 'SOLD-LF-1LB': 30,
  },
  'Chicago IL': {
    'CU-ELB-050': 300, 'CU-PIPE-050-10': 75, 'PVC-TEE-075': 400, 'BALL-VLV-100': 60,
    'WIRE-12-500': 30, 'BRK-20A': 150, 'PEX-050-100': 50, 'SOLD-LF-1LB': 90,
  },
  'Dallas TX': {
    'CU-ELB-050': 45, 'PVC-TEE-075': 60, 'BRK-20A': 25, 'SOLD-LF-1LB': 15, 'TORCH-KIT': 1,
  },
  'Los Angeles CA': {
    'CU-ELB-050': 200, 'CU-PIPE-050-10': 50, 'PVC-TEE-075': 180, 'BALL-VLV-100': 22,
    'WIRE-12-500': 18, 'BRK-20A': 70, 'PEX-050-100': 35, 'SOLD-LF-1LB': 40, 'TORCH-KIT': 3,
  },
};

export const INVENTORY = Object.entries(STOCK).flatMap(([warehouseName, stock]) =>
  Object.entries(stock).map(([sku, quantity]) => ({
    warehouseId: warehouseIdByName.get(warehouseName)!,
    productId: productIdBySku.get(sku)!,
    quantity,
  })),
);

/** Replaces all catalogue and inventory data with the fixture above. */
export async function applySeed(executor: Database | Transaction): Promise<void> {
  await executor.execute(
    sql`truncate table order_items, idempotency_keys, orders, inventory, products, warehouses, customers restart identity cascade`,
  );
  await executor.insert(customers).values(CUSTOMERS);
  await executor.insert(products).values(PRODUCTS);
  await executor.insert(warehouses).values(WAREHOUSES);
  await executor.insert(inventory).values(INVENTORY);
}
