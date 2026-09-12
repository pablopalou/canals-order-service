#!/usr/bin/env bash
# Fires N simultaneous orders for the single unit of FLUX-8OZ that exists in
# the seed data. Exactly one must succeed.
set -uo pipefail

HOST="${HOST:-http://localhost:3000}"
ATTEMPTS="${ATTEMPTS:-8}"
CUSTOMER="30000000-0000-4000-8000-000000000001"
FLUX="10000000-0000-4000-8000-000000000010"
RUN="race-$(date +%s)"
OUT="$(mktemp -d)"

payload() {
  cat <<JSON
{"customerId":"$CUSTOMER",
 "shippingAddress":{"line1":"1600 Market St","city":"Philadelphia","state":"PA","postalCode":"19103","country":"US"},
 "items":[{"productId":"$FLUX","quantity":1}],
 "payment":{"cardNumber":"4242424242424242"}}
JSON
}

echo "Firing $ATTEMPTS simultaneous orders for the last unit of FLUX-8OZ..."
for i in $(seq 1 "$ATTEMPTS"); do
  curl -s -o "$OUT/$i.json" -w '%{http_code}\n' \
    -X POST "$HOST/orders" \
    -H 'content-type: application/json' \
    -H "Idempotency-Key: $RUN-$i" \
    -d "$(payload)" >> "$OUT/codes" &
done
wait

echo
echo "HTTP status codes:"
sort "$OUT/codes" | uniq -c
echo
echo "Expected: exactly one 201, the rest 409 (no_eligible_warehouse)."
rm -rf "$OUT"
