import { config } from './config.ts';
import { db, pool } from './db/client.ts';
import { buildApp } from './app.ts';
import { MockGeocodingProvider } from './services/geocoding.ts';
import { MockPaymentGateway } from './services/payments.ts';

const app = await buildApp({
  db,
  geocoding: new MockGeocodingProvider(),
  payments: new MockPaymentGateway({
    latencyMs: config.PAYMENTS_LATENCY_MS,
    failureRate: config.PAYMENTS_FAILURE_RATE,
  }),
});

await app.listen({ port: config.PORT, host: '0.0.0.0' });

/**
 * In-flight checkouts hold row locks and may have already charged a card, so
 * shutdown drains them before closing the pool rather than cutting them off.
 */
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
