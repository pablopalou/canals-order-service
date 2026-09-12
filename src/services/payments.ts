import { randomUUID } from 'node:crypto';
import { AppError } from '../errors.ts';

export type ChargeRequest = {
  /**
   * Forwarded to the gateway so that a retry of the same logical charge is
   * recognised upstream too. Retrying without it is how customers get billed
   * twice when a response is lost in flight.
   */
  idempotencyKey: string;
  cardNumber: string;
  amountCents: number;
  currency: string;
  description: string;
};

export type ChargeResult = { paymentId: string };

/**
 * Two failure modes that must never be conflated:
 *
 *  - `payment_declined`: the gateway answered, and the answer was no. No money
 *    moved. Safe to fail the order and release the reserved stock.
 *  - `payment_indeterminate`: the request timed out or the connection dropped.
 *    The charge may or may not have gone through. The order cannot be
 *    silently discarded, because discarding it while the customer was in fact
 *    charged is the worst outcome available.
 */
export const PAYMENT_DECLINED = 'payment_declined';
export const PAYMENT_INDETERMINATE = 'payment_indeterminate';

export interface PaymentGateway {
  charge(request: ChargeRequest): Promise<ChargeResult>;
}

/**
 * Bounds a charge in time.
 *
 * A gateway that never answers is worse than one that refuses: without a
 * bound, the request is held open forever, and so is every resource attached
 * to it. Crucially the timeout resolves to `payment_indeterminate` and not to
 * a decline — we stopped waiting, which says nothing about whether the charge
 * went through.
 */
export function withTimeout(
  gateway: PaymentGateway,
  timeoutMs: number,
): PaymentGateway {
  return {
    async charge(request: ChargeRequest): Promise<ChargeResult> {
      let timer: NodeJS.Timeout | undefined;

      const expiry = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new AppError(
              504,
              PAYMENT_INDETERMINATE,
              `The payment gateway did not respond within ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);
      });

      try {
        return await Promise.race([gateway.charge(request), expiry]);
      } finally {
        // Without this the timer keeps the event loop alive for its full
        // duration after a charge that answered promptly.
        clearTimeout(timer);
      }
    },
  };
}

export type MockPaymentGatewayOptions = {
  latencyMs?: number;
  /** Chaos knob: fraction of charges that time out, in [0, 1]. */
  failureRate?: number;
  random?: () => number;
};

/**
 * Stand-in for a payment processor. Test card suffixes mirror how real
 * sandboxes (Stripe, Adyen) expose deterministic outcomes, so every branch of
 * the checkout flow can be exercised from curl without patching code.
 */
export class MockPaymentGateway implements PaymentGateway {
  private readonly latencyMs: number;
  private readonly failureRate: number;
  private readonly random: () => number;

  /**
   * In-memory stand-in for the gateway's own idempotency store. A real
   * processor keeps this server-side; replaying a key returns the original
   * charge instead of creating a second one.
   */
  private readonly charges = new Map<string, string>();

  constructor(options: MockPaymentGatewayOptions = {}) {
    this.latencyMs = options.latencyMs ?? 0;
    this.failureRate = options.failureRate ?? 0;
    this.random = options.random ?? Math.random;
  }

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    const existing = this.charges.get(request.idempotencyKey);
    if (existing) return { paymentId: existing };

    if (this.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    }

    const suffix = request.cardNumber.slice(-4);

    if (suffix === '0002' || this.random() < this.failureRate) {
      throw new AppError(
        402,
        PAYMENT_DECLINED,
        'The card was declined by the issuer',
      );
    }

    if (suffix === '0069') {
      throw new AppError(
        504,
        PAYMENT_INDETERMINATE,
        'The payment gateway did not respond in time',
      );
    }

    const paymentId = `pay_${randomUUID()}`;
    this.charges.set(request.idempotencyKey, paymentId);
    return { paymentId };
  }
}
