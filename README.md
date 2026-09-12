# Order service

A minimal order management API: place an order, pick the warehouse that can
fill it, charge the card.

`POST /orders` accepts a customer, a shipping address and a list of products.
It finds a single warehouse holding every requested line, preferring the one
closest to the shipping address, reserves the stock, and charges the card
through a payment provider. Geocoding and payments are mocked, as the brief
allows; everything behind them is real.

---

## Running it

Requires Docker. Nothing else.

```bash
docker compose up
```

That builds the service, starts Postgres, applies the migrations, seeds the
catalogue, and serves on <http://localhost:3000>. It takes about ten seconds
from a clean checkout. Postgres is published on **5433** so it cannot collide
with an instance you may already be running.

Check it is alive:

```bash
curl localhost:3000/health
```

<details>
<summary>Running the service outside Docker</summary>

```bash
docker compose up -d postgres   # database only
cp .env.example .env
npm install
npm run db:migrate
npm run db:seed
npm run dev
```
</details>

### Tests

```bash
docker compose up -d postgres
npm install
npm test
```

The suite creates and migrates its own database, so it never touches your
development data. It runs on Node's built-in test runner: no test framework,
no bundler, no platform-specific binaries to fail to install.

---

## The API

### `POST /orders`

Requires an `Idempotency-Key` header (8–255 characters). See
[Idempotency](#idempotency) for why it is mandatory rather than optional.

```jsonc
{
  "customerId": "30000000-0000-4000-8000-000000000001",
  "shippingAddress": {
    "line1": "1600 Market St",
    "line2": null,               // optional
    "city": "Philadelphia",
    "state": "PA",
    "postalCode": "19103",
    "country": "US"
  },
  "items": [
    { "productId": "10000000-0000-4000-8000-000000000001", "quantity": 2 }
  ],
  "payment": { "cardNumber": "4242 4242 4242 4242" }
}
```

`201 Created` returns the order, including which warehouse was chosen and how
far away it is. Note there is no price anywhere in the request: prices are
read from the catalogue, never accepted from the client.

| Status | Code | Meaning |
| --- | --- | --- |
| 201 | — | Order placed and paid |
| 400 | `validation_failed` | Malformed body: bad UUID, non-positive quantity, duplicate line, card failing the Luhn check |
| 400 | `idempotency_key_required` / `idempotency_key_invalid` | Header missing, or present but too short |
| 402 | `payment_declined` | The issuer said no. Stock released, order marked `payment_failed` |
| 404 | `customer_not_found` / `product_not_found` | Unknown id |
| 409 | `no_eligible_warehouse` | No single warehouse holds every line in the required quantity |
| 409 | `request_in_progress` | Same idempotency key, first attempt still running |
| 422 | `address_not_geocodable` | The address could not be resolved |
| 422 | `idempotency_key_reused` | Key already used with a different body |
| 503 | `stock_contended` | Waited too long for a row lock; another order holds the same SKU. Retryable |
| 504 | `payment_indeterminate` | Charge timed out. Stock **held**, order left `pending_payment` for reconciliation |

### `GET /orders/:id`

Not in the brief, but a write-only checkout cannot be verified, and an order
left `pending_payment` by an indeterminate charge has to be inspectable.

### Test cards

Outcomes are selected by card suffix, the way real sandboxes do, so every
branch is reachable from curl without editing code.

| Card | Outcome |
| --- | --- |
| `4242 4242 4242 4242` | Approved |
| `4000 0000 0000 0002` | Declined |
| `4000 0000 0000 0069` | Times out (indeterminate) |

Any Luhn-valid number is approved. Numbers failing the Luhn check are rejected
before the gateway is called at all.

---

## Try it

The seed data is fixed, so every command below works verbatim on a fresh
database. Stock is deliberately uneven to make the selection rule observable:

| SKU | Where it is stocked |
| --- | --- |
| `CU-ELB-050` (elbow) | everywhere |
| `TORCH-KIT` | Dallas (**1 unit**) and Los Angeles (3) only |
| `FLUX-8OZ` | Newark only, **1 unit** |

### 1. The nearest warehouse is not always the answer

Ship to Philadelphia. Newark is 121 km away and stocks the elbow, but has no
torch kit, so the order goes to **Dallas, 2088 km away** — the nearest
warehouse that can fill *every* line from its own shelves.

```bash
curl -s -X POST localhost:3000/orders \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: demo-scenario-0001' \
  -d '{
    "customerId": "30000000-0000-4000-8000-000000000001",
    "shippingAddress": {"line1":"1600 Market St","city":"Philadelphia","state":"PA","postalCode":"19103","country":"US"},
    "items": [
      {"productId":"10000000-0000-4000-8000-000000000001","quantity":2},
      {"productId":"10000000-0000-4000-8000-000000000009","quantity":1}
    ],
    "payment": {"cardNumber":"4242424242424242"}
  }'
```

```jsonc
{
  "status": "paid",
  "warehouse": { "name": "Dallas TX", "distanceKm": 2088 },
  "totalCents": 6877,          // 2 × 189 + 6499, priced from the catalogue
  "paymentId": "pay_…",
  "cardLast4": "4242"
}
```

Send it a second time with the same `Idempotency-Key`: you get the same order
id and the same `paymentId` back, and no second charge.

### 2. No single warehouse can fill it

Newark is the only source of flux; Dallas and Los Angeles are the only sources
of torch kits. Between them they hold everything — individually, neither does.

```bash
curl -s -X POST localhost:3000/orders \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: demo-scenario-0002' \
  -d '{
    "customerId": "30000000-0000-4000-8000-000000000001",
    "shippingAddress": {"line1":"1600 Market St","city":"Philadelphia","state":"PA","postalCode":"19103","country":"US"},
    "items": [
      {"productId":"10000000-0000-4000-8000-000000000010","quantity":1},
      {"productId":"10000000-0000-4000-8000-000000000009","quantity":1}
    ],
    "payment": {"cardNumber":"4242424242424242"}
  }'
```

→ `409 no_eligible_warehouse`.

### 3. A declined card releases the stock

Swap the card for `4000000000000002` in scenario 1 and use a new idempotency
key. You get `402`, the order is recorded as `payment_failed`, and the
reserved units go back on the shelf — nobody was charged, so holding them
would starve other customers.

```bash
docker compose exec postgres psql -U orders -d orders \
  -c "select o.status, p.sku, i.quantity as stock_now
      from orders o
      join order_items oi on oi.order_id = o.id
      join products p on p.id = oi.product_id
      join inventory i on i.product_id = p.id and i.warehouse_id = o.warehouse_id
      order by o.created_at desc limit 5"
```

### 4. A timed-out charge does **not** release the stock

Use `4000000000000069`. You get `504`, and the order stays `pending_payment`
with its stock still reserved. See [Payment outcomes](#payment-outcomes).

### 5. Eight customers, one unit

```bash
./scripts/race.sh
```

```
HTTP status codes:
   1 201
   7 409
```

Exactly one order is placed, stock lands on zero, and it never goes negative.
Re-seed with `npm run db:seed` to run it again.

---

## Design notes

### Structure

```
src/
  routes/     HTTP: validation, status codes, error shape
  domain/     order placement and warehouse selection
  services/   third parties behind interfaces (geocoding, payments)
  db/         schema, migrations, fixtures
```

The domain layer never touches HTTP, and the route layer holds no business
rules, so the interesting logic can be read and tested without a server.

### Warehouse selection is one query

Joining the requested lines against inventory keeps only rows with enough
stock; the `HAVING` clause keeps only warehouses that matched *every* line.
Distance is computed in SQL and used to order the result.

Iterating warehouses in the application would be an N+1 query, and would also
be the wrong shape: "has every product" is a property of a set of rows, not of
any single row. Ties break on warehouse id, so the choice is deterministic.

At a scale of thousands of warehouses this becomes PostGIS with a GiST index
on a geography column, so nearest-neighbour search uses the index rather than
scanning every row. Haversine keeps the project runnable with nothing but
`docker compose up`, and is accurate to well under a percent at these
distances.

### Checkout is split around the payment

```
TX #1  reserve stock + insert order as pending_payment   ── commit
       charge the card                                    (no locks held)
TX #2  settle to paid, or compensate
```

Charging is a network call to a third party. Doing it inside the transaction
would hold row locks on inventory for the duration of somebody else's HTTP
request, which is how a checkout endpoint takes a database down under load.

The intermediate `pending_payment` row is what makes this recoverable. If the
process dies mid-flight, the order still exists and can be reconciled against
the gateway, instead of leaving stock decremented with nothing to explain why.

### Payment outcomes

Two failure modes that must never be collapsed into one:

- **Declined** — the gateway answered, and the answer was no. No money moved.
  The order is marked `payment_failed` and the reservation is released.
- **Indeterminate** (timeout, dropped connection) — the charge may or may not
  have happened. The reservation is deliberately **not** released and the
  order stays `pending_payment`. Releasing stock while the customer's card was
  in fact debited is the one outcome that costs real money and real trust.
  Recovery is a reconciliation worker that replays the same idempotency key
  against the gateway, which either returns the original charge or confirms
  none exists.

### Concurrency

`POST /orders` is the endpoint where two customers reach for the same last
unit, so stock is protected at three levels:

1. Inventory rows are locked `FOR UPDATE` before being decremented.
2. Locks are always acquired **ordered by product id**, regardless of the
   order the client listed them in. Two orders sharing products that locked in
   opposite order would deadlock; sorting removes the possibility.
3. `CHECK (quantity >= 0)` on the table, as a last line of defence against any
   future code path that bypasses this one.

Eligibility is computed before any lock is held, so the chosen warehouse can be
drained in between. The reservation re-checks under the lock and falls through
to the next candidate rather than overselling — both behaviours are covered in
`tests/concurrency.test.ts`.

### Security

Nothing here is auth — the brief sets that aside — but the parts that are not
auth were still treated as if this were live:

- **The card number never lands anywhere.** It is validated, handed to the
  gateway, and discarded. The database keeps four digits; the logger redacts
  the field on every path, so a future log line cannot leak one by accident.
- **Prices are server-side.** There is no price field in the request for a
  client to tamper with.
- **The read endpoint lists its columns explicitly** rather than returning the
  row. A handler that publishes whatever the table happens to hold will
  publish the next column somebody adds, and the geocoded coordinates are
  ours, not the customer's business.
- **Errors say what the client did wrong and nothing else.** Unrecognised
  failures are logged in full and returned as an opaque 500 with a request id
  to correlate against.
- **Everything is parameterised.** No string interpolation reaches SQL,
  including the generated `values` lists.
- **The body limit is 64 KB** and orders cap at 200 lines, so a hostile
  payload is rejected before it is parsed.
- **Queries are bounded**: ten seconds per statement, five for a row lock. A
  request cannot pin a connection or a lock indefinitely.

Known gaps, all of them consequences of having no auth in scope: anyone
holding an order's UUID can read it, error codes distinguish an unknown
customer from an unknown product, and there is no rate limiting. In a real
deployment the endpoint sits behind authentication, orders are scoped to the
authenticated customer, and the write path is rate limited per customer.

### Idempotency

The header is **required**, not optional. This endpoint is called by a UI when
a customer clicks "place order", so double submits, browser retries and flaky
connections are ordinary traffic rather than edge cases, and the key is the
only thing standing between a double click and a second charge.

- The key is claimed inside the same transaction as the order, so an attempt
  that rolls back leaves no trace and can be retried.
- A replay of a completed request returns the original response verbatim —
  including the original *failure*, so a declined card is not later reported
  as a success.
- A replay arriving while the first attempt is still running is answered with
  `409 request_in_progress` rather than queued behind it.
- Reusing a key with a different body is rejected with `422` instead of
  silently returning somebody else's order.
- The key is forwarded to the payment gateway, which is what protects against
  a double charge when a response is lost in flight.

Because this lives in Postgres rather than in memory, it survives a restart:
replaying a key after `docker compose restart app` still returns the original
order.

### Data

- **Money is integer cents.** Floating point rounding errors compound across
  order lines. Per-unit prices are 32-bit; order totals are 64-bit, because a
  200-line order of a high-priced SKU passes the 21 million dollar ceiling of
  an integer column, and a valid order must not fail on an overflow.
- **`order_items` snapshots the unit price.** Reading it by joining to
  `products` would silently rewrite historical orders whenever a catalogue
  price changes.
- **Prices come from the catalogue, never the request.** There is no price
  field in the API for a client to set to `1`.
- **Only the last four digits of the card are stored.** The PAN is never
  persisted, and the logger redacts it on every path so a future log line
  cannot leak one.
- **The geocoded coordinates are persisted on the order**, so the warehouse
  choice stays auditable if the provider later returns something else.
- Migrations are reviewed SQL files committed to the repo, applied by a
  migrator. The schema is never pushed straight from the TypeScript
  definitions.

### Mocks

Both third parties sit behind an interface, so a real client can replace them
without touching the checkout logic.

The geocoder is deterministic rather than random: a given address must always
resolve to the same point, otherwise the chosen warehouse is not reproducible
and neither the examples above nor the tests mean anything. Known US metros
map to their real coordinates; anything else is hashed into a point inside the
continental US.

### Tests

The suite runs on `node --test`. An earlier version used a test framework,
until cloning the repository into a temporary directory showed `npm test`
failing on a fresh install: the framework's bundler resolves a native binary
through an optional peer dependency, which npm does not install from a
lockfile ([npm/cli#4828](https://github.com/npm/cli/issues/4828)). It worked
on my machine and nowhere else. Node runs TypeScript and tests on its own, so
the dependency was removed rather than worked around, and `tsx` went with it.

Seventy tests across five files, each covering one thing:

| File | What it holds |
| --- | --- |
| `warehouse-selection` | The rule itself: nearest, nearest *that can fill it*, one warehouse rather than several combined, and not enough stock |
| `checkout` | The endpoint end to end — placing, replaying, both payment outcomes, reading an order back |
| `concurrency` | What cannot be established by reading: simultaneous orders, deadlock ordering, stock conservation |
| `validation` | The input boundary: every malformed request a client will send by accident |
| `edge-cases` | What the gateway is actually handed, distance ties, stock boundaries, replays in awkward states |
| `money` | An order total past the 32-bit ceiling |

The brief says tests are optional and that they trade poorly against reviewer
time, which is why none of them assert framework behaviour for its own sake —
the two that touch 404s and 415s are there because *we* changed those
responses. The suite exists because "production-ready" was the other
instruction, and two of these found real bugs, described in the commits that
fixed them.

The one worth reading is `conserves every unit of stock under mixed concurrent
load`: twenty simultaneous orders over overlapping products, a third of them
on declining cards so compensation runs while others are still reserving, and
afterwards every unit is accounted for —

    stock now + units held by paid orders === stock before

Any lost update, double decrement, or compensation that released the wrong
quantity breaks that equality. The suite was run five times in a row to
confirm nothing in it is timing-dependent.

---

## What I would do next

In rough order of how much they would matter in production:

- **Reconciliation worker.** Orders stuck in `pending_payment` past a
  threshold should be replayed against the gateway and settled or released.
  Today the recovery path is designed for but not implemented, so such an
  order holds its stock indefinitely.
- **Reservation expiry.** Same idea from the other side: a TTL on reservations
  with a sweeper, so no failure mode can strand inventory forever.
- **Retries with backoff** around both third parties, and a circuit breaker so
  a slow gateway sheds load instead of consuming the connection pool.
- **Tokenise the card.** A real integration collects payment details client
  side and sends a token; the number should never reach this service. The
  brief explicitly sets this aside.
- **Split shipments.** "One warehouse per order" is the stated rule, but the
  interesting product question is what to do when no single warehouse can fill
  an order. Today that is a 409; the alternative is proposing a split, which
  is a pricing and fulfilment decision more than a technical one.
- **Observability.** Structured logs are in place; what is missing is metrics
  on reservation failures, payment latency and 409 rates, which are the
  numbers that tell you inventory is misallocated across the network.
- **Rate limiting and authentication**, per the note above.
- **Expiring idempotency keys.** They are kept forever today; production wants
  a retention window and a sweep, since their only purpose is to cover a
  client's retry window.

## A note on tooling

The brief says AI tools are unrestricted, so for the record: I used an AI
assistant while building this, mostly for scaffolding, and reviewed every line
of the result. The design decisions and their trade-offs are described above
because I want to discuss them, not because a tool suggested them.
