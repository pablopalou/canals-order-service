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
 * Every warehouse that can fill the entire order on its own, nearest first.
 *
 * The whole rule lives in one statement: joining the requested lines against
 * inventory keeps only the rows with enough stock, and the HAVING clause keeps
 * only the warehouses that matched every single line. Iterating warehouses in
 * the application instead would be an N+1 query, and would still be wrong,
 * because "has all the products" is a property of the set, not of one row.
 *
 * Ties are broken by id so the choice is deterministic and reproducible.
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

  const result = await executor.execute(sql`
    with requested (product_id, quantity) as (values ${requestedRows})
    select
      w.id            as id,
      w.name          as name,
      ${distanceKm(destination)} as distance_km
    from warehouses w
      join inventory i on i.warehouse_id = w.id
      join requested r on r.product_id = i.product_id
    where i.quantity >= r.quantity
    group by w.id
    having count(*) = ${items.length}
    order by distance_km asc, w.id asc
  `);

  return (result.rows as Array<Record<string, unknown>>).map((row) => ({
    id: row.id as string,
    name: row.name as string,
    distanceKm: Number(row.distance_km),
  }));
}
