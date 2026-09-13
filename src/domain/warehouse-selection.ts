import { sql } from 'drizzle-orm';
import type { Database, Transaction } from '../db/client.ts';
import type { Coordinates } from '../services/geocoding.ts';

export type RequestedItem = { productId: string; quantity: number };

export type EligibleWarehouse = {
  id: string;
  name: string;
  distanceKm: number;
};

const EARTH_RADIUS_KM = 6371;

/**
 * Checkout almost always takes the first candidate; the rest only matter when
 * a warehouse is drained between this read and the lock. Returning every
 * eligible warehouse cost a sort and a transfer of thousands of rows per
 * checkout on a dense catalogue, for candidates that are never tried. If all
 * ten are drained concurrently the order gets a 409 and the client retries
 * against current stock.
 */
const MAX_CANDIDATES = 10;

/**
 * Great-circle distance, computed in the database so that filtering and
 * ordering happen in one pass instead of pulling every warehouse into the
 * process. Haversine is accurate to well under a percent at these distances
 * and needs no extension, which keeps `docker compose up` enough to run this.
 *
 * At a scale where warehouses number in the thousands rather than the dozens,
 * this becomes PostGIS with a GiST index on a geography column, so that a
 * nearest-neighbour search uses the index instead of scanning every row.
 */
const distanceKm = (destination: Coordinates) => sql<number>`
  ${2 * EARTH_RADIUS_KM} * asin(sqrt(
    power(sin(radians(w.latitude - ${destination.latitude}) / 2), 2)
    + cos(radians(${destination.latitude})) * cos(radians(w.latitude))
    * power(sin(radians(w.longitude - ${destination.longitude}) / 2), 2)
  ))
`;

/**
 * The nearest warehouses that can each fill the entire order on their own,
 * nearest first, up to MAX_CANDIDATES.
 *
 * The whole rule lives in one statement: joining the requested lines against
 * inventory keeps only the rows with enough stock, and the HAVING clause keeps
 * only the warehouses that matched every single line. Iterating warehouses in
 * the application instead would be an N+1 query, and would still be wrong,
 * because "has all the products" is a property of the set, not of one row.
 *
 * Ties are broken by id so the choice is deterministic and reproducible.
 *
 * The `product_id = any(...)` filter repeats what the join against `requested`
 * already implies, and it is not redundant. Given only the join against a
 * VALUES list, the planner does not push the product ids down to the index:
 * with a million inventory rows it read the whole table with a parallel
 * sequential scan on every checkout. Stated as a plain filter, it becomes a
 * bitmap scan of `inventory_product_id_idx` over the handful of rows involved.
 *
 * A covering index including `quantity` would make this an index-only scan and
 * roughly halve it again. It is deliberately not there: `quantity` is the
 * column every checkout writes, and indexing it rules out in-place (HOT)
 * updates, trading a faster read for a more expensive write on the hottest row
 * in the system. Measured, not assumed: HOT updates fell from 26% to 0%.
 */
export async function findEligibleWarehouses(
  executor: Database | Transaction,
  items: RequestedItem[],
  destination: Coordinates,
): Promise<EligibleWarehouse[]> {
  const requestedRows = sql.join(
    items.map((item) => sql`(${item.productId}::uuid, ${item.quantity}::integer)`),
    sql`, `,
  );

  const productIds = sql.join(
    items.map((item) => sql`${item.productId}::uuid`),
    sql`, `,
  );

  const result = await executor.execute(sql`
    with requested (product_id, quantity) as (values ${requestedRows})
    select
      w.id            as id,
      w.name          as name,
      ${distanceKm(destination)} as distance_km
    from warehouses w
      join inventory i on i.warehouse_id = w.id
      join requested r on r.product_id = i.product_id
    where i.product_id = any(array[${productIds}])
      and i.quantity >= r.quantity
    group by w.id
    having count(*) = ${items.length}
    order by distance_km asc, w.id asc
    limit ${MAX_CANDIDATES}
  `);

  return (result.rows as Array<Record<string, unknown>>).map((row) => ({
    id: row.id as string,
    name: row.name as string,
    distanceKm: Number(row.distance_km),
  }));
}

/**
 * Distance from a destination to one particular warehouse, computed with the
 * same formula as selection so the two can never disagree. Used to rebuild an
 * order's response after the fact, when the request that chose the warehouse
 * is long gone.
 */
export async function distanceToWarehouse(
  executor: Database | Transaction,
  warehouseId: string,
  destination: Coordinates,
): Promise<EligibleWarehouse> {
  const result = await executor.execute(sql`
    select w.id as id, w.name as name, ${distanceKm(destination)} as distance_km
    from warehouses w
    where w.id = ${warehouseId}::uuid
  `);

  const row = (result.rows as Array<Record<string, unknown>>)[0];
  if (!row) throw new Error(`warehouse ${warehouseId} does not exist`);

  return {
    id: row.id as string,
    name: row.name as string,
    distanceKm: Number(row.distance_km),
  };
}

