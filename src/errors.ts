/**
 * A single error type carrying the HTTP status and a stable machine-readable
 * code. A class hierarchy per failure mode would be more ceremony than the
 * handful of cases here justify, and callers only ever branch on `code`.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;
