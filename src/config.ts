import { z } from 'zod';

/**
 * Environment is validated once at startup: a missing or malformed variable
 * should crash the process immediately, not surface as an undefined deep
 * inside a request handler.
 */
const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),

  /**
   * Browser origins allowed to call the API, comma separated. Empty means the
   * UI is served from the same origin (behind the same gateway) and no CORS
   * headers are sent at all, which is the safest default.
   */
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.url({ protocol: /^https?$/ }))),

  /** Connection pool and query budgets, tuned per environment. */
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  DB_LOCK_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(30_000),

  /**
   * How long to wait for the payment gateway before giving up. A charge that
   * exceeds this is treated as indeterminate, never as a failure.
   */
  PAYMENTS_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  /** Geocoding has no side effect, so a short budget and a retryable 503. */
  GEOCODING_TIMEOUT_MS: z.coerce.number().int().positive().default(3_000),

  /** Mocked payment gateway behaviour, see src/services/payments.ts */
  PAYMENTS_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0),
  PAYMENTS_LATENCY_MS: z.coerce.number().int().min(0).default(120),

  /**
   * Reconciliation of orders whose charge outcome is unknown. An interval of
   * zero disables the in-process scheduler.
   */
  RECONCILE_INTERVAL_MS: z.coerce.number().int().min(0).default(30_000),
  RECONCILE_AFTER_MS: z.coerce.number().int().positive().default(300_000),
  RECONCILE_BATCH_SIZE: z.coerce.number().int().positive().default(50),

  /** Settled idempotency keys are kept this long, then purged. */
  IDEMPOTENCY_RETENTION_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(24 * 60 * 60 * 1000),
  /** How often the purge runs. Zero disables it. */
  IDEMPOTENCY_PURGE_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(0)
    .default(60 * 60 * 1000),
}).refine(
  // Reconciling a charge that may still be on its way to the gateway would be
  // told no charge exists, cancel the order, and then watch the charge land.
  // The threshold has to sit well clear of the longest a charge can take.
  (env) => env.RECONCILE_AFTER_MS >= 2 * env.PAYMENTS_TIMEOUT_MS,
  {
    path: ['RECONCILE_AFTER_MS'],
    message: 'must be at least twice PAYMENTS_TIMEOUT_MS',
  },
);

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const config = parsed.data;
export type Config = typeof config;
