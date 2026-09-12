# Initial Analysis — Specialist Agent Reports

**Date:** 2026-09-12 · **Phase:** 0 · **Status:** analysis complete, no code written
**Source of fact:** [`00-existing-systems-analysis.md`](../00-existing-systems-analysis.md)

Each section is that specialist's read of the evidence and their recommendation. The Lead
Agent's decisions are at the end; where a specialist was overruled it is stated.

---

## Product Manager Agent

**Read.** The estate has a working front half and no back half. A customer can browse, add to
cart and place an order. After that, nothing happens — literally nothing: no status ever
changes, no one is dispatched, and thirty minutes later the inventory hold silently expires.
The customer's order screen shows a four-step pipeline in which two steps are unreachable and
every non-`PAID` status renders as "Delivered".

**Product consequence.** This is not a system needing a delivery *feature*. It is a system in
which the fulfilment half does not exist. That is good news for scope clarity: there is no
legacy delivery behaviour to preserve or migrate.

**Scope defined.** Delivery journeys, admin/dispatcher/rider workflows, exceptions, returns,
V1/V2 split, 18 acceptance criteria and 12 operational KPIs — all in
[`01-logistics-scope.md`](../01-logistics-scope.md).

**Flagged to the Lead.**
- We are promising a customer tracking experience that Grocery's UI cannot currently render
  (the `services/orders.ts` ternary). Publishing accurate statuses that the customer never
  sees is wasted work — Q3 must include that one-line fix.
- There is no promised delivery window anywhere. Without one, "on-time" is undefined and the
  SLA KPI cannot be computed. Raised as **Q8**; recommend a flat configurable promise for V1.
- COD is disabled in checkout, so V1 has no cash to handle. I recommend we do **not** build
  cash workflows on speculation (**Q6**).

---

## Integration Architect Agent

**Read.** Inventory's integration surface is genuinely good: scoped SHA-256 API keys, per-key
rate limits and quotas, mandatory idempotency keys on writes, RLS applied identically to the
dashboard and to third parties, and a webhook system with queue-time dedupe, `SKIP LOCKED`
claiming, exponential backoff, dead-lettering and crash reclamation. Grocery's is nonexistent:
no API, no webhooks, no events, no tests.

**The central finding.** `src/services/inventory.ts` defines `commitInventory`,
`releaseInventory` and `orderStatus`, and **not one of them is ever called**. Inventory's own
documentation says *"Call this on delivery, not on payment"* and lists *"Commit fires on
delivery"* on its go-live checklist. Nothing in the estate delivers, so nothing ever commits.
Every sale reserves stock, holds it for thirty minutes, and hands it back as `expired`. The
ledger has no record that anything was ever sold.

**This is the logistics system's core integration obligation, not a side quest.**

**Two traps found by reading the code.**

1. **`POST /api/inventory/commit` reports success for a hold that was released.** The route's
   zero-row branch returns `already_committed: true` whether the reservations are `CONSUMED`
   or `RELEASED`. Combined with the universal 30-minute expiry above, logistics would hit this
   on its *first* delivery: commit returns 200, stock is never reduced, and nobody notices.
   **Mandatory mitigation:** verify with `GET /api/inventory/order/:id` after every commit and
   require `status === "delivered"`. Recorded as **R-03** and written into the contract as a
   non-negotiable rule.

2. **The 30-minute TTL is shorter than a delivery.** The fix already exists in Inventory:
   `confirm_reservation()` sets `expires_at = NULL` — *"a paid hold does not lapse."* Logistics
   must confirm on ingest. That needs reservation ids, which Grocery discards and
   `order_status` does not return. Raised as **Q4**; my recommendation is that Inventory add
   the missing `confirm_order(order_ref)` sibling to `reserve_order`/`commit_order`/
   `release_order`.

**Rejected approach.** Subscribing logistics to an Inventory webhook. The
`webhook_subscription.event` CHECK permits exactly four values, none order-related, and
Inventory has no knowledge of packing state. It is the wrong source, not merely a blocked one.

**Recommended inbound.** A signed, versioned, idempotent push from Grocery, with a
logistics-owned poller as an explicitly temporary scaffold so Phases 1–4 are not blocked. Both
feed one `IngestDeliveryOrder` command with one idempotency key. Full contract in
[`02-integration-contract.md`](../02-integration-contract.md).

**Adopted verbatim from Inventory.** The HMAC scheme (`t=…,v1=…` over `` `${t}.${body}` ``,
300 s tolerance) — signing the timestamp *inside* the MAC is what makes replay bounded. One
scheme across the estate means one `verify()` to trust and one thing for an integrator to learn.

---

## Logistics Domain Architect Agent

**Entities proposed** (logistics database only):

```
delivery                 external_order_id (unique), tracking_id, status,
                         pickup_location_code, external_location_id,
                         promised_from/to, payment_method, amount_to_collect_paise
delivery_address         snapshot: recipient, phone, lines, city, pincode, lat, lng, instructions
delivery_item            snapshot: external_product_id, sku, name, quantity, reservation_id
delivery_status_history  from, to, actor_id, actor_role, reason_code, evidence_ref, occurred_at
delivery_package         package_no, weight_band, fragile, cold_chain
rider                    code, name, phone, status, vehicle_type, home_location_code
rider_credential         bcrypt hash, device binding, lockout counters
rider_shift              start, end, location_code
rider_availability       online/offline transitions
rider_location           delivery_id, lat, lng, accuracy, recorded_at   (active task only)
assignment               delivery_id, rider_id, assigned_by, assigned_at,
                         accepted_at, declined_at, decline_reason, superseded_by
delivery_otp             hash, expires_at, attempts, consumed_at
delivery_proof           type (OTP|PHOTO|SIGNATURE), storage_ref, captured_at, captured_by
delivery_exception       code, severity, raised_by, notes, resolved_at, resolution
delivery_return          reason, return_to_location_code, status, completed_at
notification             channel, template, recipient_ref, status, attempts
integration_inbound      source, event_id, payload, status, error        (dead-letterable)
integration_outbound     target, event_id, payload, status, attempts     (the queue)
idempotency_record       (api_client, key) -> request_hash, status, response
audit_log                actor, action, entity, before, after, correlation_id
```

**State machine.** The suggested statuses from the brief survive contact with the evidence,
with one addition: `RECEIVED` is a genuinely distinct state from `READY_FOR_ASSIGNMENT`,
because the analysis shows orders will arrive **incomplete** — missing an address or a pickup
location (Q1, Q2). `RECEIVED` is where a dispatcher completes and admits them. Without that
state, incomplete orders either get rejected at the door or pollute the assignment queue.

Every transition carries: allowed actor, required permission, required evidence, external side
effect, customer notification, audit event, retry behaviour and manual-override behaviour.
Detailed table to be produced in the Phase 1 analysis document.

**Transaction boundaries.** One transaction per command. The state change, its history row, its
audit row and the **enqueue** of any outbound event commit together. The outbound HTTP call
happens outside that transaction, from the queue — exactly Inventory's split, and for the same
reason: a subscriber's broken endpoint must never be the reason a rider cannot mark a parcel
delivered.

**Explicitly not designed.** Product, price, stock, catalogue, purchase orders, suppliers. The
logistics database holds `external_product_id` and `sku` and nothing that could drift.

---

## Backend Agent

**Recommended stack:** Inventory's, not Grocery's. Next.js 16 App Router, raw `pg`, numbered
SQL migrations with the existing `migrate.mjs` runner, RLS on every table, `node --test`.
Rationale: Inventory is the better-engineered system by a wide margin (52 documented
migrations, 17 test suites, a verification script and a single `npm run check` gate, against
Grocery's zero tests and hand-applied schema file). Matching the weaker convention would be
a choice to be worse.

**Schemas:** `delivery`, `fleet`, `integration`, `ops`.

**Directly reusable, with attribution:** `lib/webhooks.ts` (`sign`, `verify`, `deliverOne`,
`drainOnce`), `scripts/webhook-worker.mjs`, the `0035` queue DDL, the `lib/api/handler.ts`
pipeline shape, `platform.idempotency_record`, `platform.api_client` + `authenticate_api_key`,
`scripts/migrate.mjs` / `db-config.mjs` / `db-verify.mjs`, `tests/harness.mjs`, and
`scripts/schedule-jobs.mjs`. From Grocery, `lib/distance.ts`.

**Not building in Phase 1:** any inventory logic, any catalogue, any pricing, any customer
account feature.

**Note to the Lead.** Grocery's checkout writes the order from the **browser** with the anon
key, and the inventory reserve happens afterwards in a server action with no transaction
spanning them. If the reserve fails, the order row already exists and is `PAID`. Logistics
must therefore expect orders that were never successfully reserved, and must validate against
`GET /api/inventory/order/:id` at ingest rather than trusting that a hold exists.

---

## Admin Frontend Agent

**Screens for V1:** dashboard, delivery queue (filter by location and status), delivery
detail with a full timeline, rider management, dispatch board, assignment and reassignment,
live delivery view, exceptions queue, returns queue, reports, and integration health.

**Findings that change the design.**
- Grocery already ships `leaflet` + `react-leaflet` and a working `MapPicker`. The same
  approach carries the live delivery view without adding a mapping vendor.
- `src/config/stores.ts` holds the only geocodes in the estate (HUB, SH1 Andheri, SH2 Bandra,
  SH3 Dadar). Useful as **seed data**; the authoritative location list must come from
  `GET /api/locations`, or logistics forks a constant and drifts.
- The delivery timeline is the highest-value screen. Because every transition is audited with
  actor, reason and evidence, "what happened to this order" becomes answerable for the first
  time in this estate.

**Permissions.** Every action is permission-gated and the UI hides what the role cannot do —
but the server enforces it regardless. A manual status override is always available to an
admin, always requires a reason, and is always marked as an override in the timeline.

---

## Rider Mobile Agent

**Recommendation: a mobile-first PWA inside the logistics Next app for V1** (Q5). One repo,
one deploy, one auth, installable, no store review. The V1 requirement is location *during an
active delivery*, which foreground periodic pings satisfy; if continuous background
breadcrumbs later become a hard requirement, that is the trigger to move to React Native, and
I would rather make that decision with a stable domain behind us.

**Offline design.** Service worker for the shell, IndexedDB for assigned tasks and an
append-only outbox. Every rider action is captured locally with a **client-generated event
id**, and the server treats that id as the idempotency key. Sync is replay of the outbox in
order.

**The rule I want written down now:** last-write-wins is **not acceptable for `DELIVERED`**. A
completion that arrives late from an offline device must be reconciled against the state
machine, not blindly applied. If the delivery was meanwhile marked failed by a dispatcher, the
conflict is surfaced as an exception for a human, never silently resolved. Recorded as **R-12**.

**Camera and location.** `<input type="file" capture>` for proof photos, resized and
EXIF-stripped client-side before upload. Geolocation API, sampled during an active task only,
never in the background.

---

## QA Agent

**Baseline.** Grocery: **zero tests**. Inventory: 17 phase suites plus smoke and verification
scripts. Logistics adopts Inventory's convention — a phase suite per phase, `npm run check`
as the single gate.

**Test matrix per feature:** happy path, invalid request, missing data, permission failure,
duplicate request, duplicate webhook, retry, timeout, external system failure, invalid state
transition, concurrent action, offline behaviour, audit row written, event published, customer
status synchronised, privacy.

**Delivery completion gets its own suite**, because it is the one transition with irreversible
external effects: correct rider, correct task, correct order, valid unexpired unused OTP, COD
status where applicable, no duplicate completion, customer updated, admin updated, audit event
written, external status event emitted, **inventory commit verified**.

**Three tests I insist on from day one.**

1. **Expired-hold commit.** Reserve, let the hold expire, commit, and assert that logistics
   raises `INVENTORY_HOLD_LOST` rather than believing `already_committed: true`. This is the
   §14.2 trap, and it is reachable on the very first real delivery.
2. **Duplicate ingest.** The same `external_order_id` delivered five times concurrently
   produces exactly one delivery record.
3. **Offline double-completion.** Two devices, same task, one offline; exactly one completion,
   one commit, one customer notification.

**Contract tests** against a Grocery fixture run in logistics CI, because Grocery has no tests
of its own and a change there would otherwise break ingestion silently (**R-10**).

---

## DevOps Agent

**Environment.** A separate logistics deployment and a separate database. Neither existing
database absorbs logistics tables.

**The one thing Inventory has already learned for us,** documented in its `.env.example` and
its worker header, and worth repeating so we do not rediscover it:

- Use the Supabase **pooler** (`…pooler.supabase.com:6543`), not the direct host — the direct
  host is IPv6-only and does not resolve from a serverless function. This broke a deploy once
  already.
- **Do not run the webhook worker on Vercel.** It is billed by wall-clock time and killed
  mid-flight. Run it as a small always-on process, or drive the drain from pg_cron + `pg_net`.

**Jobs:** outbound queue drain, stuck-`SENDING` reclamation, stuck-delivery detection, OTP
expiry, rider-location retention purge, proof-file retention purge, assignment-timeout sweep.

**Secrets:** platform secret store. Both HMAC secrets support a rotation grace window — the
verifier accepts the previous secret for one window, so rotation is not an outage.

**Observability:** structured logs with `correlation_id` on every line; metrics for queue
depth, dead letters, assignment latency, commit failures; alerts on dead letters > 0, stuck
deliveries > 0, and **any** commit verification failure — that last one means real stock is
drifting.

**CI/CD:** format → lint → typecheck → unit → integration → contract → migration → build, with
`npm run check` as the gate. Migrations forward-only, reviewed, and tested against a reset
database. Rollback by redeploying the previous image; a migration that cannot be rolled back
must ship behind a flag.

---

## Security Agent

**Findings in the existing estate** (reported, not ours to fix):
- Grocery's checkout sets `status: 'PAID'` from the **browser**, before any payment. The RLS
  policy permits a customer to insert their own order, so a customer can create a `PAID` order
  for any amount. **Logistics must never treat `PAID` as evidence of settlement.**
- Inventory's env-admin backdoor is documented by its own author as having no second factor,
  no bcrypt work factor and no lockout. We must not copy that pattern for riders.
- Grocery's Supabase client falls back to placeholder credentials rather than failing fast.

**Logistics requirements.**

| Area | Requirement |
|---|---|
| API auth | Bearer keys, SHA-256 at rest, scoped, location-bound, revocable, expiring |
| Human auth | bcrypt, lockout counters, short-lived sessions, device binding for riders |
| Webhook auth | HMAC over `t.body`, 300 s window, constant-time compare, rotation grace |
| Replay | signature window + `event_id` uniqueness + idempotency records |
| Authorisation | a rider may act **only** on their own active assignment; a dispatcher only within their locations; enforced server-side, never by hiding a button |
| Customer PII | snapshot only what a delivery needs; encrypt at rest; purge after retention |
| Rider PII | location **only** during an active task; coarse retention; explicit consent |
| Phone numbers | masked by default (**Q9**); redacted from logs and from the admin UI |
| Proof files | **private** bucket, short-lived signed URLs, EXIF GPS stripped, never public |
| OTP | 6 digits, hashed at rest, 15-min TTL, 5 attempts, single use, bound to the delivery |
| Audit | append-only, actor + role + before + after + correlation id, 7-year retention |
| Logs | no PII, no OTPs, no keys, no signatures |

**The distinction I want understood:** Inventory serves product images from a **public**
bucket, deliberately and correctly — a storefront renders them in an `<img>` tag. Proof-of-
delivery photos are the opposite case. They show someone's front door, sometimes their face,
sometimes a bystander. Copying the public-bucket pattern here would be a serious mistake.

---

## Documentation Agent

**Produced in Phase 0**

| Document | Purpose |
|---|---|
| [`00-existing-systems-analysis.md`](../00-existing-systems-analysis.md) | The 22-section evidence base, with a file-level evidence index |
| [`01-logistics-scope.md`](../01-logistics-scope.md) | Owned vs not owned, journeys, V1/V2, 18 acceptance criteria, 12 KPIs |
| [`02-integration-contract.md`](../02-integration-contract.md) | Identifiers, auth, inbound and outbound payloads, versioning, reliability, event catalogue, config |
| [`03-open-questions.md`](../03-open-questions.md) | 15 questions with options and recommendations; 4 blocking |
| this file | Specialist findings and Lead decisions |

**To be maintained from Phase 1:** API reference, event catalogue, database documentation,
setup guide, runbooks, per-phase analysis and verification reports, and architecture decision
records.

**House style adopted from Inventory:** explain *why*, and name the failure the decision
prevents. Its migration headers are the reason this analysis could be written from source in a
single pass, and that is worth imitating.

---

## Lead Agent decisions

| # | Decision | Basis |
|---|---|---|
| D-01 | Separate repository, separate database, independent deploy | Neither existing DB should absorb logistics; Grocery's is customer-RLS-shaped, Inventory's is a stock system of record |
| D-02 | Build on **Inventory's** toolchain and conventions | It is the materially better-engineered system. Matching Grocery's would be choosing to be worse |
| D-03 | Reuse Inventory's HMAC scheme, queue design and idempotency model verbatim | Proven here, well documented, and one scheme across the estate is one thing to trust |
| D-04 | Logistics owns the `commit` call and **must verify it** with `order_status` | The commit route cannot distinguish "committed" from "released"; unverified commits mean silent stock drift |
| D-05 | Confirm reservations at ingest | The 30-minute TTL is shorter than a delivery. The mechanism already exists in Inventory |
| D-06 | Keep `RECEIVED` distinct from `READY_FOR_ASSIGNMENT`, gated by a dispatcher | Orders will arrive incomplete until Q1/Q2 land. Accepted the Domain Architect's argument |
| D-07 | Rider app is a **PWA** for V1 | Accepted the Rider Agent's reasoning; revisit if background breadcrumbs become a hard requirement |
| D-08 | **No COD workflow in V1**; carry reference fields only | COD is disabled in checkout and no settlement model exists. Building it would be speculation |
| D-09 | Serviceability stays Grocery's in V1 | Avoids two systems disagreeing about whether an address can be served |
| D-10 | Proof files in a **private** bucket, never the public product-image pattern | Accepted the Security Agent's distinction without reservation |
| D-11 | An inventory outage must not trap a rider at a door: the delivery completes, the commit queues and reconciles | Customer outcome beats bookkeeping latency; the ledger is eventually correct either way |
| D-12 | The interim poller is a **scaffold** and is deleted when the push path lands | Stated now so it does not quietly become the architecture |

**Overruled:** none. Where specialists differed (PWA vs native, poller vs push), the
disagreement was about sequencing rather than direction, and both are resolved by shipping the
scaffold explicitly labelled as temporary.

**Escalated to the sponsor:** Q1, Q2, Q3, Q4. Q1 and Q3 are the true gate — **the logistics
system cannot deliver a single real order until an address exists on an order.**
