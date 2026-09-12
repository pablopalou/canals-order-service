/**
 * A single error type carrying the HTTP status and a stable machine-readable
 * code. A class hierarchy per failure mode would be more ceremony than the
 * handful of cases here justify, and callers only ever branch on `code`.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;

/**
 * Postgres classes 08 (connection exception) and 57P01 (admin shutdown), plus
 * the driver's own connection failures. All of them mean the database is
 * momentarily unreachable rather than that the request was wrong.
 */
const TRANSIENT_CONNECTION_CODES = new Set([
  '08000', // connection_exception
  '08003', // connection_does_not_exist
  '08006', // connection_failure
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08004', // sqlserver_rejected_establishment_of_sqlconnection
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
]);

export function isTransientDatabaseError(error: unknown): boolean {
  const code = postgresErrorCode(error);
  if (code !== undefined && TRANSIENT_CONNECTION_CODES.has(code)) return true;

  // The driver reports a pool that could not hand out a connection as a plain
  // Error with no code, so the message is the only signal available.
  for (let current = error; current instanceof Error; current = current.cause) {
    if (
      /connection terminated|timeout exceeded when trying to connect|client has encountered a connection error/i.test(
        current.message,
      )
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Walks the cause chain looking for a Postgres error code. Drivers and query
 * builders wrap errors, so the code is rarely on the error actually thrown.
 */
export function postgresErrorCode(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}
