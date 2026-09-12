# Existing Systems Analysis — Grocery & Inventory

**Date:** 2026-09-12
**Author:** Lead Agent (logistics programme)
**Status:** Phase 0 deliverable — analysis only, no production code written
**Method:** Both repositories cloned and read at source level. Nothing in this document is
taken from README prose where the code disagrees; where they disagree it is called out.

| Repository | Ref inspected | Role |
|---|---|---|
| `MrMandalShubham/Grocery` | `main` (shallow clone, depth 50) | customer storefront |
| `MrMandalShubham/Inventory` | `main` (shallow clone, depth 50) | stock system of record |

> **No file in either repository was modified.**

---

## 1. Grocery technology stack

| Concern | Choice |
|---|---|
| Framework | Next.js **16.3.2**, App Router, `src/` directory |
| UI | React 19.2.8, Tailwind CSS v4 (`@tailwindcss/postcss`) |
| Language | TypeScript 5 |
| Data | Supabase (`@supabase/supabase-js` ^2.112.4) — Postgres + Supabase Auth |
| Maps | `leaflet` 1.9.4 + `react-leaflet` 5 (serviceability picker) |
| Lint | `eslint` 9 + `eslint-config-next` |
| Tests | **None.** No test runner, no test files, no CI workflow |
| Migrations | **None.** A single hand-applied `schema.sql` at the repo root |
| Env template | **None.** No `.env.example`; variables discovered by reading code |
| Deploy | Vercel implied (stock `create-next-app` README, unmodified) |

**Code quality:** early-stage. The README is untouched `create-next-app` boilerplate and
describes nothing about this application. `AGENTS.md` is an auto-generated Next.js block.
There is no error tracking, no structured logging, and no health endpoint.

### Environment variables actually referenced

| Variable | Used in | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `src/lib/supabase.ts` | falls back to a placeholder string |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `src/lib/supabase.ts` | falls back to a placeholder string |
| `INVENTORY_API_URL` | `src/services/inventory.ts` | server-side only |
| `INVENTORY_API_KEY` | `src/services/inventory.ts` | server-side only, correctly not `NEXT_PUBLIC_` |

The Supabase placeholder fallbacks mean a misconfigured deploy **starts successfully and
fails at runtime** rather than failing fast.

---

## 2. Inventory technology stack

| Concern | Choice |
|---|---|
| Framework | Next.js **16.3.3**, App Router, no `src/` directory |
| UI | React 19.2.8, Tailwind CSS v4 |
| Language | TypeScript **7.0.2**, ESM (`"type": "module"`) |
| Data | Postgres via the **raw `pg` driver** (^8.13.1). Deliberately *not* `supabase-js` |
| Auth | **Its own**: `platform.sign_in`, bcrypt hashes in `platform.credential` |
| Migrations | 52 numbered SQL files + a custom runner (`scripts/migrate.mjs`) |
| Tests | `node --test` with `tsx`; **17 phase suites** under `tests/` |
| Jobs | `pg_cron` (`scripts/schedule-jobs.mjs`) + a Node webhook worker |
| Storage | Pluggable driver: `local` (dev) or `supabase` Storage (prod) |
| Env template | `.env.example`, 4.4 KB, heavily annotated |
| Docs | `docs/` (9 numbered design docs) + a 31 KB `STOREFRONT-API.md` |

**Code quality:** high, and markedly higher than Grocery's. Migrations carry long rationale
comments explaining *why* a decision was made and which bug it prevents — `0037`, for
example, documents a real Postgres function-overload trap introduced by `0035`. There is a
verification script (`db-verify`), smoke scripts for both API surfaces, and `npm run check`
(`db:reset && test`) as a single gate.

**Conclusion: Inventory, not Grocery, sets the engineering conventions for this estate.**
The logistics system should be built to Inventory's standard.

---

## 3. Grocery architecture

```
src/
  app/          App Router pages: /, /login, /wholesale-login, /account,
                /orders, /checkout, /search, /category/[id], /product/[id],
                /out-of-service
    actions.ts  the only server actions (3 of them)
  components/   Header, BottomNav, CartDrawer, ProductCard, MapPicker,
                LocationSelector, OrderPipeline, ...
  contexts/     CartContext (client cart), RoleContext (B2C/B2B + user)
  services/
    inventory.ts   the Inventory HTTP client (server-side)
    orders.ts      reads orders from Supabase
  lib/
    supabase.ts    single browser client, anon key
    distance.ts    haversine
  config/
    stores.ts      HUB + SH1/SH2/SH3 lat-lngs, MAX_DELIVERY_RADIUS_KM = 10
```

**Shape:** a thin, client-heavy Next app. There is **no `app/api/` directory** — Grocery
exposes **no HTTP API of its own**. All writes happen either directly from the browser
through `supabase-js` under RLS, or through the three server actions.

**Serviceability** is a Grocery concern today: `MapPicker` + `calculateDistanceKM` against
`STORE_LOCATIONS`, a 10 km radius, and an `/out-of-service` page that logs to a
`service_requests` table.

> ⚠ `src/app/actions.ts` inserts into `public.service_requests`, **which does not exist in
> `schema.sql`.** The insert error is caught and logged, so the feature fails silently.

---

## 4. Inventory architecture

Postgres-first. Business rules live in `SECURITY DEFINER` functions inside schemas; the HTTP
layer is a thin wrapper that authenticates, sets claims, and calls them.

```
Schemas:  platform   locations, users, API clients, webhooks, idempotency, rate limits
          catalog    products, categories, images
          stock      balance, ledger (partitioned by month), reservation, posting
          movement   transfer/import/export ticket lifecycle
          alerting   rules and alerts
          insight    demand, cover, reorder points
          accounting postings, landed cost, charges

app/
  (app)/       operator dashboard (products, stock, movements, counts, receive,
               planning, reports, partners, alerts, locations, finance, import,
               api-keys)
  api/
    v1/*       integrator surface   - envelope responses, MANDATORY Idempotency-Key
    */         storefront surface   - plain arrays, CORS allowlist
lib/
  api/handler.ts     the /api/v1 wrapper (auth, rate limit, scope, idempotency, RLS)
  api/storefront.ts  the /api/* wrapper (auth, rate limit, scope, RLS, CORS)
  webhooks.ts        HMAC signing + the delivery loop
  db.ts              pg pool
```

**The invariant that governs everything:** stock is the sum of an append-only ledger. There
is deliberately **no endpoint that sets a stock number** — every path moves stock by
recording an event (documented at the head of `0050_order_lifecycle.sql`).

An API client runs through *exactly* the same session path as the dashboard: role
`authenticated`, claims set via `request.jwt.claims`, RLS applied. No privileged route exists.

---

## 5. Existing databases

Two **separate** Postgres databases. They share no tables and no foreign keys.

### 5.1 Grocery — Supabase project, `public` schema

Defined entirely by the hand-applied `schema.sql`:

| Table | Purpose |
|---|---|
| `profiles` | `id → auth.users`, `role` ∈ `B2C \| B2B \| ADMIN`, `full_name`, `phone`, `b2b_shop_name`, `b2b_gstin` |
| `addresses` | `user_id`, `label`, `address_line1/2`, `city`, `state`, `pincode`, `is_default` |
| `orders` | see §7 |
| `order_items` | `order_id`, `external_product_id`, `sku`, `name`, `price_at_purchase`, `quantity` |
| `carts` | `user_id`, `external_product_id`, `quantity` |
| `promo_codes` | `code`, `discount_type`, `discount_value`, `min_order_value`, `is_active` |
| `service_requests` | **referenced in code, absent from `schema.sql`** |

A `handle_new_user()` trigger on `auth.users` creates the `profiles` row on signup.

### 5.2 Inventory — Postgres (Supabase-hosted in prod, container in dev)

52 migrations, `0001` → `0052`. Relevant to logistics:

| Object | Purpose |
|---|---|
| `platform.location` | `code`, `name`, `type` ∈ `HUB \| STORE \| WAREHOUSE \| VIRTUAL`, `status` |
| `platform.app_user` | `role` ∈ `operator \| shop_manager \| planner \| finance \| admin` |
| `platform.api_client` | `key_hash` (SHA-256), `key_prefix`, `scopes[]`, `location_ids[]`, `environment`, `rate_limit_per_min` |
| `platform.idempotency_record` | `(api_client_id, key)` → `request_hash`, `status_code`, `response_body` |
| `platform.webhook_subscription` | `event`, `url`, `signing_secret`, `max_attempts`, failure counters |
| `platform.webhook_delivery` | the queue — `PENDING \| SENDING \| DELIVERED \| FAILED \| DEAD` |
| `platform.api_request` | per-request access log |
| `stock.reservation` | `HELD \| CONFIRMED \| CONSUMED \| RELEASED`, `order_ref`, `expires_at`, `idempotency_key` |
| `stock.ledger` | append-only, month-partitioned |
| `stock.balance` | `on_hand`, `reserved`, `allocated`, `damaged` |

---

## 6. Existing inventory schema (availability semantics)

Available-to-promise is computed, never stored:

```sql
available = on_hand - reserved - allocated - damaged
```

Reservation lifecycle (`0019_reservations.sql`):

```
              reserve                confirm                  consume
   (none) --------------> HELD ------------------> CONFIRMED -----------> CONSUMED
                           |  expires_at set        expires_at = NULL     ledger written
                           |                             |
                           +-----------> RELEASED <------+
                              (expired | cancelled | returned)
```

Three facts that matter a great deal to logistics:

1. **`CONSUMED` is the only state that writes to the ledger.** Until then the goods are held
   but still counted on the shelf — which is true, because they are.
2. **`HELD` expires.** Default TTL **1800 s (30 minutes)**, swept every minute by the
   mandatory `sweep-reservations` pg_cron job.
3. **`CONFIRMED` does not expire** — `confirm_reservation()` sets `expires_at = NULL` with the
   comment *"a paid hold does not lapse."* This is the escape hatch for long deliveries.

---

## 7. Existing order schema

`public.orders` (Grocery):

```sql
id                    uuid primary key default gen_random_uuid()
user_id               uuid not null -> profiles(id)
status                text not null default 'PENDING'
                      check (status in ('PENDING','PAID','FAILED',
                                        'SHIPPED','DELIVERED','CANCELLED'))
total_amount          numeric not null
discount_applied      numeric default 0
final_amount          numeric not null
payment_method        text not null
razorpay_order_id     text
razorpay_payment_id   text
logistics_tracking_id text          -- present, and never read or written anywhere
created_at            timestamptz not null default now()
```

### What is missing from the order, and why it blocks logistics

| Missing | Consequence |
|---|---|
| **No `address_id`, and no address snapshot of any kind** | There is **no delivery address on any order in the system**. A rider cannot be dispatched. |
| No `location_id` / shop reference | The order does not record which of HUB/SH1/SH2/SH3 fulfils it. That choice lives only in an `inventory_location` **cookie**. Logistics cannot know the pickup point. |
| No contact phone on the order | `profiles.phone` exists, is nullable, and is never collected at checkout. |
| No delivery slot, instructions, or ETA | No customer promise to measure an SLA against. |
| No `updated_at` | Nothing can tell when a status last changed. |

`src/app/checkout/page.tsx` renders a **"Delivery Details"** form — first name, last name,
phone, address textarea — and **every one of those inputs is uncontrolled and discarded.**
None has `value`, `onChange`, or `name`, and none is read in `handlePayment()`.
`src/app/account/page.tsx` lists *"Saved Addresses"* as **"Coming Soon"**, and the
`addresses` table is never queried by any file in the repository.

> **This is the hardest blocker in the estate.** It is not a logistics design question; it is
> a missing input. See §15 and Q1.

---

## 8. Existing order statuses

### 8.1 Database (`orders.status`)

`PENDING` · `PAID` · `FAILED` · `SHIPPED` · `DELIVERED` · `CANCELLED`

There is **no `RETURNED`** value, and no `PACKED`/`READY` value.

### 8.2 What the code actually does with them

- `checkout/page.tsx` inserts `status: 'PAID'` **hard-coded**, before any payment occurs.
- **No file in the repository ever updates `orders.status`.** `PENDING`, `FAILED`, `SHIPPED`,
  `DELIVERED` and `CANCELLED` are unreachable in the running system.
- RLS on `orders` grants `SELECT` and `INSERT` to the owning customer and **defines no
  `UPDATE` policy at all** — so nothing holding the anon key can advance a status even if it
  wanted to.

### 8.3 Customer-facing pipeline (`components/OrderPipeline.tsx`)

A different, four-step vocabulary: `placed` → `packed` → `out_for_delivery` → `delivered`.

`services/orders.ts` bridges them with:

```ts
status: o.status === "PAID" ? "placed" : "delivered"
```

Consequences: `packed` and `out_for_delivery` are **unreachable**, and `PENDING`, `FAILED`,
`SHIPPED` and `CANCELLED` would all render to the customer as **"Delivered"**.

---

## 9. Existing APIs

### 9.1 Grocery

**None.** No `app/api/` directory, no route handlers, no webhook receiver. Grocery is a pure
consumer. Anything that needs to reach Grocery today must go through its Supabase database.

### 9.2 Inventory — two deliberately different surfaces

**A. Integrator surface — `/api/v1/*`** (`lib/api/handler.ts`)
Envelope responses, `X-Api-Version: v1`, **mandatory `Idempotency-Key` on writes**.

`/api/v1/products`, `/products/:id`, `/products/:id/images`, `/stock`, `/movements`,
`/ledger`, `/reservations`, `/reservations/:id/confirm`, `/reservations/:id/consume`,
`/reservations/:id/release`, `/openapi`

**B. Storefront surface — `/api/*`** (`lib/api/storefront.ts`)
Plain arrays at plain paths, CORS allowlist via `STOREFRONT_ORIGINS`.

| Endpoint | Scope | Purpose |
|---|---|---|
| `GET /api/locations` | `catalog:read` | shops and hubs |
| `GET /api/categories` | `catalog:read` | categories with counts |
| `GET /api/products` | `catalog:read` | listing, `?location=` |
| `GET /api/products/:slug_or_sku` | `catalog:read` | detail |
| `POST /api/inventory/reserve` | `reservations:write` | hold the whole order or none of it |
| `POST /api/inventory/commit` | `reservations:write` | **"the order was delivered"** |
| `POST /api/inventory/release` | `reservations:write` | cancelled — stock goes back |
| `GET /api/inventory/order/:order_id` | `stock:read` | `held \| delivered \| released` |
| `GET /api/health` | — | health |

**Request pipeline (both surfaces), in order:** authenticate → rate-limit → scope check →
parse body → idempotency → `BEGIN` → set claims → `SET LOCAL ROLE authenticated` → handler →
`COMMIT` → log. One pooled connection per request.

**Scopes in use:** `catalog:read`, `catalog:write`, `pricing:write`, `stock:read`,
`movements:read`, `reservations:write`, `cost:read`, and `*`.

**API keys:** `ic_live_…` / `ic_test_…`, stored as SHA-256 hashes, per-key scopes, per-key
location allowlist (**empty means all locations**), per-key rate limit and daily quota.
Minted by `npm run key:mint` or `platform.create_api_client()` (admin only).

---

## 10. Existing events and webhooks

Inventory has a **production-grade** webhook system. Grocery has none.

### 10.1 The four events that exist

`platform.webhook_subscription.event` carries a `CHECK` constraint permitting exactly:

```
stock.changed        a balance moved           key: ledger:<id>
stock.low            a low-stock alert opened  key: alert:<id>
movement.closed      a ticket reached its end  key: movement:<id>:<status>
reservation.expired  a hold lapsed             key: reservation:<id>:expired
```

They are raised by **database triggers** (`0036_event_emission.sql`), so a future code path
that moves stock without knowing webhooks exist still raises the event.

> ⚠ **There is no order event, and no `order.*` value is permitted by the CHECK.**
> Subscribing logistics to an inventory event is not possible without a migration to
> Inventory — and it would not help, because Inventory does not know when an order is packed.

### 10.2 Delivery mechanics (reusable as-is)

- Queue in Postgres; HTTP in Node (`lib/webhooks.ts`, `scripts/webhook-worker.mjs`).
- States `PENDING → SENDING → DELIVERED | FAILED | DEAD`. `SENDING` exists so a worker crash
  is distinguishable from a success; `requeue_stuck_deliveries()` reclaims by age.
- Claimed with `FOR UPDATE SKIP LOCKED` — multiple workers are safe.
- **Deduplicated at queue time** by a unique index on `(subscription_id, event_key)`.
- Backoff `10 × 4ⁿ` seconds — 10s, 40s, 2m40s, 10m40s, 42m, 2h50m — then `DEAD`
  (`max_attempts` default 6).
- `emit_event()` swallows its own errors: *a webhook problem is never a reason to fail a
  stock write.*

### 10.3 Signature scheme — adopt this verbatim

```
POST <subscriber url>
content-type: application/json
user-agent: InventoryCore-Webhooks/1
X-Inventory-Event: stock.changed
X-Inventory-Delivery: 41337
X-Inventory-Signature: t=1789012345,v1=<hex hmac-sha256>

{ "id": "41337", "event": "stock.changed", "attempt": 1, "data": { ... } }
```

The signed string is `` `${t}.${body}` `` — the timestamp is **inside** the MAC, not beside
it, so a captured delivery cannot be replayed forever. Tolerance 300 s. `verify()` is
exported from `lib/webhooks.ts` precisely so subscribers can reuse it.

---

## 11. Existing authentication

**Three unrelated mechanisms already exist. A fourth would be one too many.**

| System | Mechanism | Identities |
|---|---|---|
| Grocery customers | **Supabase Auth** (`auth.users`) + `profiles.role` | `B2C`, `B2B`, `ADMIN` |
| Inventory operators | **Own** bcrypt auth: `platform.sign_in`, `platform.credential`, sessions | `operator`, `shop_manager`, `planner`, `finance`, `admin` |
| Inventory machines | **API keys** `ic_live_…`, SHA-256 hashed, scoped and location-bound | per API client |

Inventory's `0022_auth.sql` mints *the same claims shape Supabase Auth would* (`sub`, `role`),
so the two human systems are structurally compatible even though they share no database.

There is also an **env-admin** backdoor (`ADMIN_EMAIL` / `ADMIN_PASSWORD`, `0044`), which
`.env.example` itself documents as having *"no second factor, no bcrypt work factor, and no
lockout counter."* Logistics must not copy that pattern for riders.

---

## 12. Existing customer address model

| Fact | Detail |
|---|---|
| Table | `public.addresses` — `label`, `address_line1`, `address_line2`, `city`, `state`, `pincode`, `is_default` |
| **Geocode** | **None.** No `lat`/`lng` columns |
| **Rows written** | **Never.** No file in the repository inserts, selects or updates this table |
| **Linked to orders** | **No.** `orders` has no `address_id` |
| UI | `/account` shows "Saved Addresses — **Coming Soon**" |
| Checkout | An uncontrolled, discarded address form (§7) |

Grocery *does* capture a lat/lng — in `MapPicker`/`LocationSelector`, for the 10 km
serviceability check — but it is used transiently for that check and for `service_requests`,
and is **never attached to an order.**

---

## 13. Existing payment model

| Fact | Detail |
|---|---|
| Columns | `payment_method text not null`, `razorpay_order_id`, `razorpay_payment_id` |
| Values written | `'RAZORPAY'` (B2C) or `'SHOP_CREDIT'` (B2B) |
| Razorpay | **Not integrated.** No SDK dependency, no key, no order-create call, no signature verification. The two `razorpay_*` columns are never written |
| Status at insert | Hard-coded `'PAID'` — before any payment |
| **COD** | The "Cash on Delivery" radio in checkout is **`disabled`**. There is no COD path, no `amount_to_collect`, and no settlement model |
| B2B | A hard-coded *"Available Balance: ₹50,000"* string. No wallet table, no ledger |

**Implication for logistics:** there is **no cash-collection requirement in V1**, because no
order can be COD. The logistics data model should carry `payment_method` and a nullable
`amount_to_collect` as *read-only reference fields*, so COD later is a configuration change
rather than a schema migration — but no settlement, reconciliation or cash-handling workflow
should be built now. See Q6.

---

## 14. Existing status synchronisation

**There is none.** Concretely:

- Grocery → Inventory: one-way, fire-and-forget, at checkout only.
- Inventory → Grocery: **nothing**. Grocery has no endpoint to call and no subscription.
- Nothing updates `orders.status` after insert, in either direction.
- `orders.logistics_tracking_id` is never written.

### 14.1 The open loop — the most important finding in this document

`src/services/inventory.ts` defines four order-lifecycle functions. Grocery calls **one**:

| Function | Defined | Called |
|---|---|---|
| `reserveInventory` | yes | **yes** — via the `reserveOrderInventory` server action in `checkout/page.tsx` |
| `commitInventory` | yes | **never** |
| `releaseInventory` | yes | **never** |
| `orderStatus` | yes | **never** |

So, for every order placed today:

```
checkout -> order row (status PAID) -> reserve -> HELD, expires_at = now + 30 min
                                                       |
                                         30 minutes later, sweep-reservations
                                                       v
                                    RELEASED, released_reason = 'expired'
```

**The stock is never consumed. The ledger entry for the sale is never written.** Inventory
believes every item is still on the shelf. `STOREFRONT-API.md` states the requirement plainly
— *"Call this on delivery, not on payment"* — and lists *"Commit fires on delivery"* on its
go-live checklist. **Nothing in the estate delivers.**

> **This is precisely the gap the logistics system exists to close.** Closing it is not an
> optional extra of the logistics project; it is the project's core integration obligation.

### 14.2 A correctness trap in `POST /api/inventory/commit`

`app/api/inventory/commit/route.ts` returns, when `commit_order()` yields zero rows:

```json
{ "ok": true, "order_id": "...", "already_committed": true, "items": [] }
```

But `commit_order()` yields zero rows for **two different reasons**: the reservations were
already `CONSUMED` (genuinely committed), **or** they were `RELEASED` — including released as
`'expired'`. In the second case the route reports success and the stock is **never reduced**.

Given §14.1 — where *every* hold expires after 30 minutes — this is not a theoretical edge.
It is what logistics will hit on its very first delivery unless the reservation is confirmed.

**Mitigation (logistics-side, no change to Inventory):** after every commit, call
`GET /api/inventory/order/:id` and require `status === "delivered"`. Treat anything else as a
failed commit and raise an integration exception. Recorded as risk **R-03**.

---

## 15. Delivery-ready order definition

### 15.1 What exists today

**Nothing.** There is no packing workflow, no "ready" status, no pick list, and no signal of
any kind that an order is prepared for dispatch. `orders.status` reaches `'PAID'` at insert
and stops there forever.

### 15.2 Where it should come from, in order of preference

| # | Candidate trigger | Available today? |
|---|---|---|
| 1 | An operator marks the order picked & packed at a named shop | **no** — no such workflow in either system |
| 2 | `movement.closed` for an EXPORT ticket | **no** — Inventory movements model transfers between locations, not customer orders |
| 3 | `orders.status → 'SHIPPED'` in Grocery | **no** — nothing ever writes it |
| 4 | Order is `PAID` **and** its inventory reservation is `held` | **yes** — both facts are observable now |

### 15.3 Proposed definition for V1

> An order is **delivery-ready** when all of the following hold:
> 1. `orders.status = 'PAID'`;
> 2. `GET /api/inventory/order/:order_id` returns `status = "held"` — the goods are really allocated;
> 3. a **fulfilment location** is known (the shop the reservation was placed against);
> 4. a **deliverable address with a geocode** is attached to the order.
>
> Conditions 1 and 2 hold today. Condition 3 lives only in a browser cookie. **Condition 4 is
> not satisfiable by any order currently in the system** (§7, §12).

Because (3) and (4) are unmet, V1 must not pretend a fully automatic trigger exists. The
recommended V1 gate is a **dispatcher-confirmed admission**: candidate orders are ingested
into logistics in state `RECEIVED`, and a dispatcher promotes them to `READY_FOR_ASSIGNMENT`
once the address and pickup location are present. Phase 8 can automate the promotion once
Grocery supplies both fields reliably.

---

## 16. Recommended integration point

### 16.1 Inbound — getting orders into logistics

Two mechanisms, feeding **one** internal command (`IngestDeliveryOrder`) with a single
idempotency key (`external_order_id`), so the source is swappable without touching the domain.

**Primary (target): Grocery pushes a signed webhook.**

```
POST  https://logistics.example.com/api/v1/integration/orders.delivery-ready
      X-Logistics-Signature: t=...,v1=...     (Inventory's exact scheme, §10.3)
      Idempotency-Key: <grocery order uuid>
```

This is the correct long-term design: push, signed, idempotent, versioned, and it removes any
need for logistics to hold credentials to Grocery's database. It requires an **additive**
change to Grocery — a server action plus a `LOGISTICS_*` env pair. Grocery must be changed
regardless, because the delivery address does not exist yet (§7).

**Interim (build-and-test unblocker): a logistics-owned poller.**

A worker in the logistics service reads Grocery's Supabase directly (service-role key,
**read-only usage**) for `status = 'PAID'` orders not yet ingested. This lets Phases 1–4 be
built and demonstrated with **zero** changes to Grocery, and is deleted once the push path
lands. It is explicitly a scaffold, not the architecture.

> **Rejected: subscribing to an Inventory webhook.** The event `CHECK` constraint forbids any
> `order.*` value, and Inventory has no knowledge of packing state. It is the wrong source.

### 16.2 Outbound — logistics → Inventory (closing the open loop)

Logistics gets its **own** `ic_live_…` key, scoped `reservations:write` + `stock:read`, bound
to the delivery locations.

| Logistics event | Inventory call | Why |
|---|---|---|
| Order ingested (`RECEIVED`) | `POST /api/v1/reservations/:id/confirm` per line | **Stops the 30-minute expiry.** Without this, every delivery longer than 30 min silently loses its hold (§6, §14.2) |
| `DELIVERED` | `POST /api/inventory/commit` | writes the ledger entry — the sale finally exists |
| `RETURNED` / `CANCELLED` | `POST /api/inventory/release` `{reason}` | stock goes back on the shelf |
| after every commit | `GET /api/inventory/order/:id` | verify `status === "delivered"` (mitigates §14.2) |

Confirming needs the per-line `reservation_id`s. Those are returned by `reserve`, and Grocery
currently discards them; `GET /api/inventory/order/:order_id` returns SKU-level status but
**not** reservation ids. See Q4.

### 16.3 Outbound — logistics → Grocery (customer tracking)

Grocery has no API and no `UPDATE` policy on `orders` (§8.2). Two options:

- **(a) Grocery adds `POST /api/logistics/status`** — signed, idempotent by `event_id`.
  Grocery owns its own writes. **Recommended.**
- **(b) Logistics writes to Grocery's Supabase with a service-role key.** Bypasses RLS from
  outside the owning system. Faster, and a boundary violation we would have to live with.

Either way, logistics also writes `orders.logistics_tracking_id` — the column is already
there, unused, and is the obvious join key.

### 16.4 Recommended stance on repository layout

A **separate repository and separate database**, deployed independently. Neither existing
database should gain logistics tables: Grocery's is Supabase-Auth-shaped and RLS-scoped to
customers; Inventory's is a stock system of record whose invariants must not be diluted.

---

## 17. Reusable code

From **Inventory**, adopt rather than reinvent:

| Asset | Reuse |
|---|---|
| `lib/webhooks.ts` — `sign()` / `verify()` | **Verbatim.** Identical scheme for inbound and outbound |
| `lib/webhooks.ts` — `drainOnce()` + `scripts/webhook-worker.mjs` | Verbatim, retargeted at the logistics queue |
| `0035_webhook_delivery.sql` | The whole queue design: `SENDING`, `event_key` dedupe, `SKIP LOCKED`, backoff, `DEAD`, reclaim-by-age |
| `lib/api/handler.ts` | The request pipeline shape: auth → rate-limit → scope → idempotency → RLS transaction → log |
| `platform.idempotency_record` | The `(client, key) → request_hash → response` replay design, including the 422 on key reuse |
| `platform.api_client` + `authenticate_api_key` | Key format, SHA-256 storage, scopes, location binding |
| `scripts/migrate.mjs`, `db-config.mjs`, `db-verify.mjs` | Migration runner and verification harness |
| `tests/harness.mjs` + the phase-suite convention | Test structure and the `npm run check` gate |
| `scripts/schedule-jobs.mjs` | pg_cron scheduling pattern for sweeps |
| `platform.location` | **Reference, do not copy.** Logistics stores `external_location_id` + a code |

From **Grocery**:

| Asset | Reuse |
|---|---|
| `src/lib/distance.ts` (haversine) | Small and correct — copy for radius checks and rider proximity |
| `src/config/stores.ts` | The HUB/SH1/SH2/SH3 coordinates are the only geocodes in the estate. **Seed data only** — logistics reads locations from `GET /api/locations` |
| `components/MapPicker` / `LocationSelector` | Pattern reference for the admin live map |
| `components/OrderPipeline` | The customer-facing vocabulary logistics statuses must map onto |

---

## 18. Conflicts

| # | Conflict | Detail | Resolution |
|---|---|---|---|
| C-01 | **Two order-status vocabularies** | DB `PENDING/PAID/FAILED/SHIPPED/DELIVERED/CANCELLED` vs UI `placed/packed/out_for_delivery/delivered`, joined by a lossy ternary | Logistics owns a third, richer model and publishes an explicit mapping (§20). Do not extend Grocery's CHECK in V1 |
| C-02 | **No `RETURNED` status in Grocery** | A completed return has nowhere to land | Map `RETURNED → CANCELLED` in V1 and keep the true reason in the logistics record. Flag for V2 |
| C-03 | **Three auth systems** | Supabase Auth, Inventory bcrypt, API keys | Logistics adds **one** identity domain (riders + dispatchers) with its own credentials, and integrates machine-to-machine by API key only |
| C-04 | **Reservation TTL vs real delivery time** | 30 min default; a delivery is longer | Confirm reservations on ingest (§16.2). Requires reservation ids — Q4 |
| C-05 | **Fulfilment location lives in a cookie** | `inventory_location`; never persisted on the order | Logistics must receive the location on the inbound contract. Q2 |
| C-06 | **`commit` reports success for released holds** | §14.2 | Verify via `GET /api/inventory/order/:id` after every commit. R-03 |
| C-07 | **Grocery serviceability vs logistics coverage** | Grocery enforces 10 km from `stores.ts`; logistics will have its own zones | V1: logistics treats Grocery's decision as authoritative and does not re-gate. Revisit in Phase 8 |
| C-08 | **Runtime / type-system skew** | Grocery TS 5, Next 16.3.2; Inventory TS 7.0.2, Next 16.3.3, ESM | Build logistics on Inventory's toolchain |

---

## 19. Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| **R-01** | **No delivery address exists on any order.** Logistics cannot dispatch without one | **Blocker** | Grocery must persist an address (+ geocode) on the order. No amount of logistics work removes this. Q1 |
| **R-02** | No fulfilment location on the order | High | Carry it on the inbound contract; reject orders without it. Q2 |
| **R-03** | `commit` returns `already_committed: true` for expired/released holds → silent stock drift | High | Confirm on ingest; verify with `order_status` after commit; alert on mismatch |
| **R-04** | Reservation expiry during delivery | Med-High | `confirm_reservation` on ingest (the R-03 mitigation covers this) |
| **R-05** | Grocery has no `UPDATE` policy on `orders` — customer tracking cannot be written | Med-High | §16.3 option (a) preferred; (b) needs an explicit boundary waiver. Q3 |
| **R-06** | No payment is real; `status: 'PAID'` is hard-coded pre-payment | Medium | Logistics must not treat `PAID` as evidence of settlement, and must not build cash handling on it |
| **R-07** | Rider location tracking is continuous personal data (GPS on a named worker) | Medium | Track only during an active task; short retention; coarse history; explicit consent. Security Agent owns |
| **R-08** | Proof-of-delivery photos may capture doorways, faces, bystanders | Medium | Private bucket, short-lived signed URLs, never public, retention policy, strip EXIF GPS |
| **R-09** | Customer address + phone replicated into a third database widens the PII blast radius | Medium | Snapshot only what a delivery needs; purge on terminal state + retention window; encrypt at rest |
| **R-10** | Grocery has **zero tests**; a change there can break ingestion silently | Medium | Contract tests owned by logistics, run in logistics CI against a Grocery fixture |
| **R-11** | Webhook worker is not serverless-safe (Vercel kills mid-flight) | Medium | Inventory documents this; run the logistics worker always-on, or via pg_cron + `pg_net` |
| **R-12** | Offline rider sync produces conflicting terminal transitions | Medium | Client-generated event ids + server-side idempotency; the state machine rejects illegal transitions. Last-write-wins is **not** acceptable for `DELIVERED` |
| **R-13** | `service_requests` table missing while code writes to it — a live silent failure in Grocery | Low | Not a logistics fix. Reported to the owning team |
| **R-14** | 10 km radius and shop coordinates hard-coded in `stores.ts` | Low | Read locations from Inventory; do not fork the constant |

---

## 20. Proposed status mapping

Logistics owns the detailed model. Grocery keeps its coarse one. This table is the contract.

| Logistics status | Grocery `orders.status` | Customer pipeline step | Inventory action | Notify customer |
|---|---|---|---|---|
| `RECEIVED` | `PAID` *(no change)* | `placed` | `confirm` each reservation | no |
| `READY_FOR_ASSIGNMENT` | `PAID` | `packed` | — | no |
| `ASSIGNED` | `PAID` | `packed` | — | no |
| `ACCEPTED` | `PAID` | `packed` | — | no |
| `PICKUP_PENDING` | `PAID` | `packed` | — | no |
| `PICKED_UP` | `SHIPPED` | `out_for_delivery` | — | yes |
| `OUT_FOR_DELIVERY` | `SHIPPED` | `out_for_delivery` | — | yes |
| `ARRIVED` | `SHIPPED` | `out_for_delivery` | — | yes |
| `DELIVERED` | `DELIVERED` | `delivered` | **`commit`** + verify | yes |
| `DELIVERY_FAILED` | `SHIPPED` | `out_for_delivery` | — | yes |
| `RESCHEDULE_REQUIRED` | `SHIPPED` | `out_for_delivery` | — | yes |
| `RETURN_REQUIRED` | `SHIPPED` | `out_for_delivery` | — | no |
| `RETURN_IN_TRANSIT` | `SHIPPED` | `out_for_delivery` | — | no |
| `RETURNED` | `CANCELLED` (C-02) | — | **`release`** `reason=returned` | yes |
| `CANCELLED` | `CANCELLED` | — | **`release`** `reason=cancelled` | yes |

**Notes**

- `packed` and `out_for_delivery` become reachable for the first time — but only if Grocery's
  `services/orders.ts` ternary is replaced by a real mapping. Until then the customer sees
  "Delivered" for every non-`PAID` status. Q3.
- `DELIVERY_FAILED` and `RESCHEDULE_REQUIRED` both hold Grocery at `SHIPPED`. Grocery's
  vocabulary cannot express them; the detail stays in the logistics timeline.
- Only `DELIVERED`, `RETURNED` and `CANCELLED` have inventory side effects. Every other
  transition is logistics-internal.
- Every transition writes an audit row and emits `delivery.status_changed`, regardless of
  whether the customer is notified.

---

## 21. Open questions

Tracked in full, with owners and blocking status, in
[`03-open-questions.md`](03-open-questions.md). The blockers:

| # | Question | Blocks |
|---|---|---|
| **Q1** | How does a delivery address (with geocode) get onto an order — wire the checkout form to `addresses`, or have logistics collect it? **Nothing can be dispatched until this is answered.** | Phase 2 |
| **Q2** | How does logistics learn the fulfilment shop, given it currently lives in a cookie? | Phase 2 |
| **Q3** | May Grocery be modified additively (status receiver, real pipeline mapping, address capture)? If not, do we accept service-role writes from logistics? | Phase 5 |
| **Q4** | How does logistics obtain per-line `reservation_id`s in order to confirm holds? | Phase 2 |
| **Q5** | Rider app: mobile-first PWA inside the logistics Next app, or a separate React Native project? | Phase 4 |
| **Q6** | Is COD in scope for V1? (Currently `disabled` in checkout, with no settlement model.) | Phase 4 |

---

## 22. Safe assumptions

Adopted for planning unless contradicted. Each is cheap to reverse.

| # | Assumption | Basis |
|---|---|---|
| A-01 | Logistics is a **new, separate** repository and database | §16.4 |
| A-02 | Built on Inventory's toolchain: Next.js 16 App Router, raw `pg`, numbered SQL migrations, RLS, `node --test` | §2, §17 |
| A-03 | Machine-to-machine auth is bearer API keys, `lg_live_…` / `lg_test_…`, SHA-256 stored, scoped | §9.2, §11 |
| A-04 | Webhook signing reuses Inventory's scheme exactly: `t=…,v1=…` over `` `${t}.${body}` ``, 300 s tolerance | §10.3 |
| A-05 | Idempotency is mandatory on every inbound write; `external_order_id` is the ingest key | §9.2, §10.2 |
| A-06 | Logistics holds a **read-only snapshot** of address, items and amounts — never a second source of truth for stock, price or catalogue | §4 ledger invariant |
| A-07 | Product identity crosses boundaries as `sku` + `external_product_id` | `order_items` already uses exactly this pair |
| A-08 | Fulfilment locations are `HUB`, `SH1`, `SH2`, `SH3`, read from `GET /api/locations`, referenced by `external_location_id` | §5.2, §17 |
| A-09 | **V1 is not COD.** Carry `payment_method` and a nullable `amount_to_collect` as reference fields; build no cash workflow | §13 |
| A-10 | Delivery verification in V1 is an **OTP** plus optional photo proof; signature capture is V2 | scope brief |
| A-11 | Serviceability stays Grocery's decision in V1 (10 km from `stores.ts`); logistics does not re-gate | C-07 |
| A-12 | Riders are a **new identity domain** in the logistics DB — not `profiles`, not `platform.app_user` | §11, C-03 |
| A-13 | Rider location is captured **only during an active delivery task** | R-07 |
| A-14 | Proof files live in a **private** bucket, served by short-lived signed URLs | R-08 |
| A-15 | Every state transition writes an audit row: actor, role, from, to, evidence, correlation id | scope brief |
| A-16 | Currency is INR, stored in **paise as integers**, matching Inventory (`rupees()` converts at the edge) | `lib/api/storefront.ts` |
| A-17 | Timestamps are `timestamptz` in UTC; displayed in IST | both systems |
| A-18 | One delivery task carries exactly one external order in V1. Batching is Phase 8 | scope brief |

---

## Appendix A — file-level evidence index

| Claim | Evidence |
|---|---|
| Grocery has no API | no `app/api/` directory in the file listing |
| Address form discarded | `grocery/src/app/checkout/page.tsx` — inputs have no `value` / `onChange` / `name` |
| Saved addresses unbuilt | `grocery/src/app/account/page.tsx` — "Coming Soon" |
| `logistics_tracking_id` unused | `grep -rn logistics_tracking_id grocery/src` → no hits |
| commit/release never called | `grep -rn "commitInventory\|releaseInventory"` → definitions only, in `services/inventory.ts` |
| Status never updated | `grep -rn "SHIPPED\|DELIVERED"` in `grocery/src` → no write sites |
| Lossy pipeline mapping | `grocery/src/services/orders.ts:54` |
| Commit means delivery | `inventory/docs/STOREFRONT-API.md` §5, and the header comment of `stock.commit_order` |
| 30-minute TTL | `stock.reserve_order(… p_ttl_seconds integer default 1800)` |
| Confirm stops expiry | `0019_reservations.sql:180` — `expires_at = null` |
| Only four webhook events | `0020_api_platform.sql:178` — the `CHECK` on `webhook_subscription.event` |
| Signature scheme | `inventory/lib/webhooks.ts` — `sign()` / `verify()` |
| `commit` masks released holds | `inventory/app/api/inventory/commit/route.ts` — the zero-row branch |
