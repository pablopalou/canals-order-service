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

Needs Node 22.18 or newer — the service runs TypeScript directly rather than
building first, and that is the version where Node does it without a flag. The
`engines` field enforces it at install time so a wrong version fails with a
clear message rather than a cryptic runtime error.

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
npm test           # 92 tests
npm run lint       # type-aware rules the compiler cannot express
npm run typecheck
```

All four run in CI on every push, along with a production dependency audit and
a build of the runtime image (`.github/workflows/ci.yml`).

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
| 400 | `invalid_order_id` | The id on `GET /orders/:id` is not a UUID |
| 402 | `payment_declined` | The issuer said no. Stock released, order marked `payment_failed` |
| 402 | `payment_not_completed` | Replayed key for an order reconciliation cancelled: the gateway held no charge |
| 404 | `customer_not_found` / `product_not_found` | Unknown id |
| 409 | `no_eligible_warehouse` | No single warehouse holds every line in the required quantity |
| 409 | `request_in_progress` | Same idempotency key, first attempt still running — or its charge outcome is still being reconciled |
| 422 | `address_not_geocodable` | The address could not be resolved |
| 422 | `idempotency_key_reused` | Key already used with a different body |
| 405 | `method_not_allowed` | Path exists under another method; the `Allow` header lists which |
| 413 | `payload_too_large` | Body over 64 KB |
| 415 | `unsupported_media_type` | Body is not JSON |
| 503 | `stock_contended` | Waited too long for a row lock; another order holds the same SKU. Retryable, with `Retry-After` |
| 503 | `database_unavailable` | The database is momentarily unreachable. Retryable, with `Retry-After` |
| 504 | `payment_indeterminate` | Charge outcome unknown. Stock **held**, order left `pending_payment` until [reconciliation](#reconciliation) resolves it |

### `GET /health` and `GET /ready`

Liveness and readiness are separate on purpose. `/health` answers as long as
the process is running and touches nothing else — restarting a container will
not bring a database back, so an outage should not get it killed. `/ready`
checks that the database actually answers, which is what an orchestrator needs
in order to stop routing traffic to an instance that cannot serve it. The
container's healthcheck uses `/ready`.

### `GET /orders/:id`

Not in the brief, but a write-only checkout cannot be verified, and an order
left `pending_payment` by an indeterminate charge has to be inspectable.
Responses carry `Cache-Control: no-store`, since an order holds a shipping
address and part of a card number.

### Test cards

Outcomes are selected by card suffix, the way real sandboxes do, so every
branch is reachable from curl without editing code.

| Card | Outcome |
| --- | --- |
| `4242 4242 4242 4242` | Approved |
| `4000 0000 0000 0002` | Declined |
| `4000 0000 0000 0069` | Times out before reaching the gateway: **nothing charged** |
| `4000 0000 0000 0077` | Charges, then the response is lost: **charged** |

The last two are indistinguishable to the caller — both are a 504 — which is
the entire problem reconciliation exists for.

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

### 5. Reconciliation settles what the request could not

Reconciliation waits five minutes by default. To watch it within seconds,
start the stack with short thresholds:

```bash
PAYMENTS_TIMEOUT_MS=2000 RECONCILE_AFTER_MS=4000 RECONCILE_INTERVAL_MS=1000 docker compose up
```

Place one order with `4000000000000077` (charged, response lost) and one with
`4000000000000069` (never charged). Both answer `504` and both orders sit in
`pending_payment` with their stock reserved. A few seconds later the first is
`paid` and the second is `payment_failed` with its units back on the shelf.
Replaying each order's idempotency key now returns that real outcome instead
of `request_in_progress`.

### 6. Eight customers, one unit

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
process dies mid-flight, the order still exists and reconciliation resolves it
against the gateway, instead of leaving stock decremented with nothing to
explain why.

### Surviving things that fall over mid-request

Each of these was tested by actually doing it, not by reasoning about it.

**The process is killed mid-charge.** The order is already committed as
`pending_payment` with its stock reserved, and the idempotency key exists with
no recorded response. On restart, a client retrying that key is told
`request_in_progress` rather than being charged a second time — verified by
killing the process with SIGKILL during a charge, restarting, and retrying —
and reconciliation later settles the order either way.

**Postgres goes away, including mid-transaction.** An idle connection failing raises an `error` event on
the pool, and a pool with no error listener takes the process down with it —
which would mean every database restart, failover or maintenance window kills
every instance. A pool also only speaks for its *idle* clients: one checked
out for a transaction emits its failure on itself, so a hard kill in the
middle of one was a second way to the same crash. Every connection now carries
an error listener, and the pool discards the broken client and opens a fresh
one on the next query. Killing Postgres outright while a transaction was
blocked on a row lock leaves the caller with a 503, the process alive, and
nothing committed. During the outage `/ready`
reports 503 and requests get `503 database_unavailable` with a `Retry-After`
rather than a 500, and when Postgres comes back the service recovers on its
own without a restart.

**The gateway never answers.** Charges are bounded in time. The timeout
resolves to `payment_indeterminate`, never to a decline — we stopped waiting,
which says nothing about whether the money moved, so the reservation is held
for reconciliation exactly as any other unknown outcome.

**A client hangs up mid-charge.** The order completes anyway, and replaying
the idempotency key hands the caller the finished order rather than starting a
second one — which is the whole point of the key, since a client that gave up
has no idea whether the charge happened.

**Concurrent migrations.** A deploy starts every replica at once and each runs
the migrator, but Postgres DDL is not concurrency safe: even `create schema if
not exists` raises a duplicate key error when two sessions run it at the same
instant. Three replicas from an empty database used to leave two dead on
arrival. Migrations run under an advisory lock, and five simultaneous
instances all succeed.

**A connection held open and never used.** Node does not time out an
incomplete request, so headers followed by silence pinned a socket
indefinitely. A thirty second request timeout closes them, and it does not
bound handler time — a checkout waiting on a slow gateway is unaffected.

**SIGTERM during a charge.** The in-flight order completes and the process
exits zero. Shutdown gives up after ten seconds rather than waiting to be
killed.

### Payment outcomes

Two failure modes that must never be collapsed into one:

- **Declined** — the gateway answered, and the answer was no. No money moved.
  The order is marked `payment_failed` and the reservation is released.
- **Indeterminate** (timeout, dropped connection) — the charge may or may not
  have happened. The reservation is deliberately **not** released and the
  order stays `pending_payment`. Releasing stock while the customer's card was
  in fact debited is the one outcome that costs real money and real trust.
  Reconciliation later asks the gateway what became of it.

### Reconciliation

An order whose charge outcome is unknown holds its stock, correctly — but held
forever it would starve every other customer. A reconciler resolves those
orders by asking the gateway what actually happened.

**It asks rather than retries.** Charging again under the same idempotency key
would be the obvious move, but a charge needs the card number, and that is
never stored. The gateway client therefore exposes a lookup by idempotency key
(real processors support this by payment reference). The consequence of the
PCI decision is a design constraint here, and a good one: reconciliation can
confirm or deny a charge, never create one.

**It waits before asking.** Only orders untouched for `RECONCILE_AFTER_MS`
(five minutes by default) are considered. Asking about a charge still on its
way to the gateway would be told none exists, cancel the order, and then watch
the charge land. Configuration refuses a threshold under twice the payment
timeout.

**It is safe to run on every replica.** Each pass claims a batch with
`for update skip locked`, so concurrent passes step over rows another is
already claiming instead of waiting on them, and the claim bumps `updated_at`
as a lease: a claimed order does not look stuck again until a full threshold
has passed. Nothing is held open during the gateway calls that follow. If a
pass dies partway, its orders simply become eligible again.

**Settlement is guarded.** Every transition out of `pending_payment` is
conditional on the order still being pending, and cancelling gates releasing
the stock. The original request settling late and a reconciler settling the
same order cannot both win, and units are returned at most once. If a charge
does land for an order reconciliation already cancelled — which the threshold
exists to prevent — it is logged as needing a refund rather than swallowed.

For each claimed order:

| The gateway says | Result |
| --- | --- |
| The charge exists | Order `paid`; replaying the key returns it |
| No charge exists | Order `payment_failed`, stock released; replaying the key returns `402 payment_not_completed` |
| Nothing — it cannot be reached | Order left pending and retried next pass; after ten attempts it is logged as needing attention |

It runs every `RECONCILE_INTERVAL_MS` inside the service, never overlapping
itself, and shutdown lets a pass in flight finish before draining requests.

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
- **Everything is bounded**: ten seconds per statement, five waiting for a row
  lock, thirty for an idle transaction, thirty to deliver a request. Neither a
  slow client nor a stuck transaction can hold a resource indefinitely.
- **Control characters are rejected at validation.** A NUL byte cannot be
  stored in a Postgres text column, and letting it get that far turns a bad
  request into a 500.
- **Bodies reaching the prototype chain are refused.** Fastify parses with
  secure-json-parse, and a test asserts it rather than leaving it to luck.
- **Responses carry `X-Content-Type-Options: nosniff`**, and orders carry
  `Cache-Control: no-store` so nothing between here and the caller keeps a copy.
- **No production dependency carries a known advisory** (`npm audit
  --omit=dev` is clean, and CI fails if that changes). The development tree
  reports four moderate advisories, all of them inside `drizzle-kit`, which
  only generates migration files and is in neither the runtime image nor the
  test path.

Known gaps, all of them consequences of having no auth in scope: anyone
holding an order's UUID can read it, error codes distinguish an unknown
customer from an unknown product, and there is no rate limiting. In a real
deployment the endpoint sits behind authentication, orders are scoped to the
authenticated customer, and the write path is rate limited per customer.

### Tooling

Two choices here were not the obvious ones.

**TypeScript 5.9 rather than 7.** TypeScript 7 is the current release and it is
faster, but it replaced the compiler's JavaScript API, and type-aware linting
has not caught up: `typescript-eslint` still declares a peer range of
`<6.1.0`. Installing it anyway needs `--force`, which means the reviewer's
`npm install` fails. Between the newest compiler and a lint rule that catches
forgotten `await`s in a service that holds database locks, the lint rule is
worth more — a floating promise here is silent corruption, not a style
complaint. It found a real one, described below.

**ESLint rather than Biome.** Biome is faster and would replace the formatter
too, but it ships as a platform-specific native binary, which is the exact
dependency shape that already broke `npm install` here once. ESLint is plain
JavaScript. The config does not repeat what the compiler already enforces; it
adds the type-aware rules a type checker cannot express.

The lint run is not decorative. It found that the shutdown handler passed an
`async` function to `process.once`, so a rejection while draining would have
become an unhandled rejection and killed the process mid-drain — precisely
what draining exists to prevent. That path now handles its own failure and
gives up on a timeout rather than waiting for SIGKILL.

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

### Two conventions I considered and did not adopt

**RFC 9457 problem details** (`application/problem+json`) is the standardised
error format, and it would be the right call for a public API with unknown
consumers. This one has a single known consumer, and the envelope here carries
what that consumer needs — a stable machine-readable `code`, a human message,
and a `requestId` to correlate against the logs — in a shape that is easier to
branch on than a `type` URI. Worth revisiting the moment a second consumer
appears.

**A `/v1` prefix.** Versioning earns its place when consumers you cannot deploy
alongside depend on you. This endpoint is called by the same team's UI, where a
breaking change is a coordinated deploy rather than a negotiation. Adding the
prefix now would be ceremony; adding it later is a routing change.

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

The payment mock keeps its charges in memory, per process. That is faithful
enough for one instance, but it is not a shared ledger: scaled to several
replicas, one replica's reconciler would not see a charge another made and
would cancel a paid order, and a retry landing on a different replica would
be charged again. A real gateway is the shared ledger this stands in for. With
the mock, run a single instance.

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

Ninety-two tests across eight files, each covering one thing:

| File | What it holds |
| --- | --- |
| `warehouse-selection` | The rule itself: nearest, nearest *that can fill it*, one warehouse rather than several combined, and not enough stock |
| `checkout` | The endpoint end to end — placing, replaying, both payment outcomes, reading an order back |
| `concurrency` | What cannot be established by reading: simultaneous orders, deadlock ordering, lock contention, stock conservation |
| `validation` | The input boundary: every malformed request a client will send by accident |
| `edge-cases` | What the gateway is actually handed, distance ties, stock boundaries, replays in awkward states |
| `money` | An order total past the 32-bit ceiling |
| `http-semantics` | Location, 405 with Allow, cache and sniffing headers, prototype-chain payloads |
| `resilience` | A gateway that never answers, and the liveness/readiness split |
| `reconciliation` | A lost response confirmed, a missing charge cancelled, recent orders left alone, an unreachable gateway retried and escalated, overlapping passes settling each order once |

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
quantity breaks that equality. The reconciliation tests were also checked
against deliberately broken code — the pending guard removed, the claim
stripped of `skip locked` and its lease, a missing charge treated as paid —
and each mutation is caught. The suite was run five times in a row to
confirm nothing in it is timing-dependent, and it runs against the service's
own connection pool rather than one built for tests — a pool with different
timeouts would be exercising something the service never runs. Pool size and
the statement and lock budgets are configuration, so the suite can shorten the
lock budget without changing what the contention test proves.

---

## What I would do next

In rough order of how much they would matter in production:

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
  on reservation failures, payment latency, 409 rates and the size of the
  reconciliation backlog, and an alert on the "needs attention" log line,
  which today nobody is paged for.
- **Rate limiting and authentication**, per the note above.
- **Expiring idempotency keys.** They are kept forever today; production wants
  a retention window and a sweep, since their only purpose is to cover a
  client's retry window.

## A note on tooling

The brief says AI tools are unrestricted, so for the record: I used an AI
assistant while building this, mostly for scaffolding, and reviewed every line
of the result. The design decisions and their trade-offs are described above
because I want to discuss them, not because a tool suggested them.
