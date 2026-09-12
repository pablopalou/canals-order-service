import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import { findEligibleWarehouses } from '../src/domain/warehouse-selection.ts';
import { closeDatabase, db, productId, resetDatabase } from './helpers.ts';

/** Philadelphia: near Newark, far from Dallas, further still from Los Angeles. */
const PHILADELPHIA = { latitude: 39.9526, longitude: -75.1652 };

const line = (sku: string, quantity: number) => ({
  productId: productId(sku),
  quantity,
});

describe('warehouse selection', () => {
  beforeEach(resetDatabase);
  after(closeDatabase);

  it('prefers the closest warehouse when several can fill the order', async () => {
    const eligible = await findEligibleWarehouses(
      db,
      [line('CU-ELB-050', 2)],
      PHILADELPHIA,
    );

    assert.equal(eligible[0]?.name, 'Newark NJ');

    const distances = eligible.map((w) => w.distanceKm);
    assert.deepEqual(distances, [...distances].sort((a, b) => a - b));
  });

  /**
   * The rule that is easy to get wrong: nearest overall is not the answer,
   * nearest *among those that can fill every line* is. Newark is 121 km away
   * and stocks the elbow, but has no torch kit, so Dallas wins at 2088 km.
   */
  it('skips closer warehouses that are missing a line', async () => {
    const eligible = await findEligibleWarehouses(
      db,
      [line('CU-ELB-050', 2), line('TORCH-KIT', 1)],
      PHILADELPHIA,
    );

    assert.deepEqual(
      eligible.map((w) => w.name),
      ['Dallas TX', 'Los Angeles CA'],
    );
  });

  it('requires one warehouse to cover the whole order, not several combined', async () => {
    // Newark is the only source of flux, Dallas and LA the only sources of
    // torch kits. Between them they hold everything; individually, neither does.
    const eligible = await findEligibleWarehouses(
      db,
      [line('FLUX-8OZ', 1), line('TORCH-KIT', 1)],
      PHILADELPHIA,
    );

    assert.deepEqual(eligible, []);
  });

  it('excludes warehouses that stock the product but not enough of it', async () => {
    // Newark holds exactly twelve.
    const enough = await findEligibleWarehouses(
      db,
      [line('WIRE-12-500', 12)],
      PHILADELPHIA,
    );
    assert.ok(enough.some((w) => w.name === 'Newark NJ'));

    const tooMany = await findEligibleWarehouses(
      db,
      [line('WIRE-12-500', 13)],
      PHILADELPHIA,
    );
    assert.ok(!tooMany.some((w) => w.name === 'Newark NJ'));
  });
});
