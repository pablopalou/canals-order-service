import { config } from './config.ts';
import { db, pool } from './db/client.ts';
import { buildApp } from './app.ts';
import { startReconciler } from './domain/reconciliation.ts';
import { MockGeocodingProvider } from './services/geocoding.ts';
import { MockPaymentGateway, withTimeout } from './services/payments.ts';

// One gateway client shared by checkout and reconciliation. With the mock this
// is also what lets reconciliation see the charges checkout made.
const payments = withTimeout(
  new MockPaymentGateway({
    latencyMs: config.PAYMENTS_LATENCY_MS,
    failureRate: config.PAYMENTS_FAILURE_RATE,
  }),
  config.PAYMENTS_TIMEOUT_MS,
);

const app = await buildApp({
  db,
  geocoding: new MockGeocodingProvider(),
  payments,
});

await app.listen({ port: config.PORT, host: '0.0.0.0' });

const reconciler =
  config.RECONCILE_INTERVAL_MS > 0
    ? startReconciler(
        { db, payments, logger: app.log },
        {
          intervalMs: config.RECONCILE_INTERVAL_MS,
          olderThanMs: config.RECONCILE_AFTER_MS,
          batchSize: config.RECONCILE_BATCH_SIZE,
        },
      )
    : null;

/**
 * A rejection nobody awaited is a bug, and Node's default is to terminate on
 * one. Logging it through the same structured logger first means the reason
 * survives in whatever collects the logs, instead of vanishing into stderr.
 */
process.on('unhandledRejection', (reason) => {
  app.log.fatal({ err: reason }, 'unhandled rejection, exiting');
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  app.log.fatal({ err: error }, 'uncaught exception, exiting');
  process.exit(1);
});

/**
 * In-flight checkouts hold row locks and may have already charged a card, so
 * shutdown drains them before closing the pool rather than cutting them off.
 */
async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  try {
    // Reconciliation first, so no new pass starts while requests drain.
    if (reconciler) await reconciler.stop();
    await app.close();
    await pool.end();
    process.exit(0);
  } catch (error) {
    // Handled here rather than left to reject: an unhandled rejection during
    // shutdown would kill the process mid-drain, which is the exact outcome
    // draining exists to avoid.
    app.log.error({ err: error, signal }, 'shutdown failed');
    process.exit(1);
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    // An orchestrator follows SIGTERM with SIGKILL after its grace period.
    // Giving up first, on our own terms, keeps the reason in the logs.
    setTimeout(() => {
      app.log.error({ signal }, 'shutdown timed out, exiting');
      process.exit(1);
    }, 10_000).unref();

    void shutdown(signal);
  });
}
