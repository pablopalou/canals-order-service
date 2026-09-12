import { z } from 'zod';

/**
 * Luhn check digit. It costs nothing and rejects transposed digits before we
 * ever hand the number to the gateway, which turns a class of typos into a
 * clear 400 instead of a decline the customer has to interpret.
 */
const passesLuhn = (digits: string): boolean => {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = digits.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
};

const cardNumber = z
  .string()
  .transform((value) => value.replace(/[\s-]/g, ''))
  .refine((value) => /^\d{13,19}$/.test(value), {
    message: 'Card number must be 13 to 19 digits',
  })
  .refine(passesLuhn, { message: 'Card number failed the Luhn check' });

/**
 * Postgres text columns cannot hold a NUL byte, and a JSON body is perfectly
 * capable of carrying one. Left to the database, it surfaces as a failed
 * insert and a 500 for what is really a bad request. Other C0 control
 * characters have no business in an address either.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

const nonEmpty = (max = 200) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !CONTROL_CHARACTERS.test(value), {
      message: 'Must not contain control characters',
    });

export const addressSchema = z.object({
  line1: nonEmpty(),
  line2: nonEmpty().nullish(),
  city: nonEmpty(100),
  state: nonEmpty(50),
  postalCode: nonEmpty(20),
  country: nonEmpty(2).toUpperCase(),
});

export const createOrderSchema = z.object({
  customerId: z.uuid(),
  shippingAddress: addressSchema,
  items: z
    .array(
      z.object({
        productId: z.uuid(),
        quantity: z.int().positive().max(10_000),
      }),
    )
    .min(1)
    .max(200)
    // Duplicate lines would double-count in the total while the eligibility
    // query counts distinct products, so they are rejected rather than merged:
    // silently rewriting a customer's cart is worse than telling them.
    .refine(
      (items) => new Set(items.map((i) => i.productId)).size === items.length,
      { message: 'Each product may appear at most once' },
    ),
  payment: z.object({ cardNumber }),
});

export type CreateOrderBody = z.infer<typeof createOrderSchema>;

export const idempotencyKeySchema = z
  .string()
  .trim()
  .min(8, 'Idempotency-Key must be at least 8 characters')
  .max(255);
