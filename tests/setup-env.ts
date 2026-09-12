/**
 * Tests run against their own database so a failing run can never leave the
 * development data in a surprising state.
 */
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://orders:orders@localhost:5433/orders_test';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
