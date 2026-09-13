-- Every checkout rewrites an inventory row, and those updates can only happen
-- in place (HOT, without touching any index) when the row's page has free
-- space. At the default fillfactor of 100 pages are packed full, so every
-- stock decrement also writes index entries and leaves bloat behind. Measured
-- on a copy of this table: 0% of updates in place at 100, 26% at 80 when every
-- row is rewritten at once, and more in steady state as vacuum reclaims space.
--
-- This applies to pages written from now on. An existing large table only
-- benefits after a rewrite (pg_repack, or VACUUM FULL in a maintenance window).
ALTER TABLE "inventory" SET (fillfactor = 80);
