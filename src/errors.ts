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
