import type { Logger } from './domain/orders.ts';

export type Scheduled = {
  /** Stops scheduling runs and waits for one in flight to finish. */
  stop(): Promise<void>;
};

/**
 * Runs a background task on an interval. Runs never overlap within a process:
 * if one is still going when the next is due, that tick is skipped. A failing
 * run is logged and the next tick tries again — a background task must never
 * take the process down with it.
 */
export function runPeriodically(
  name: string,
  intervalMs: number,
  task: () => Promise<void>,
  logger: Logger,
): Scheduled {
  let inFlight: Promise<void> | null = null;
  let stopped = false;

  const timer = setInterval(() => {
    if (stopped || inFlight) return;
    inFlight = task()
      .catch((error: unknown) => {
        logger.error({ err: error, task: name }, 'background task failed');
      })
      .finally(() => {
        inFlight = null;
      });
  }, intervalMs);

  // A background task alone is no reason to keep the process alive.
  timer.unref();

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      // Let a run that is mid-write finish rather than abandoning it.
      if (inFlight) await inFlight;
    },
  };
}
