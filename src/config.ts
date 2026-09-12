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

  /** Connection pool and query budgets, tuned per environment. */
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  DB_LOCK_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),

  /** Mocked payment gateway behaviour, see src/services/payments.ts */
  PAYMENTS_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0),
  PAYMENTS_LATENCY_MS: z.coerce.number().int().min(0).default(120),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const config = parsed.data;
export type Config = typeof config;
