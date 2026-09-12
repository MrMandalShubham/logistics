# Logistics Architecture Proposal

**Date:** 2026-09-12 · **Status:** proposed, awaiting approval · **Owner:** Lead Agent
**Companion to:** [`00-existing-systems-analysis.md`](00-existing-systems-analysis.md) ·
[`02-integration-contract.md`](02-integration-contract.md)

---

## 1. Position in the estate

```
   ┌──────────────┐   order.delivery_ready (signed)   ┌───────────────────┐
   │              │ ────────────────────────────────► │                   │
   │   GROCERY    │                                   │    LOGISTICS      │
   │  storefront  │ ◄──────────────────────────────── │   (new system)    │
   │              │   delivery.status_changed         │                   │
   └──────┬───────┘                                   └─────────┬─────────┘
          │                                                     │
          │ reserve (at checkout)                               │ confirm (on ingest)
          │                                                     │ commit  (on delivered)
          │                                                     │ release (on returned)
          ▼                                                     ▼
   ┌─────────────────────────────────────────────────────────────────────┐
   │                          INVENTORY CORE                             │
   │              system of record for stock — unchanged                 │
   └─────────────────────────────────────────────────────────────────────┘
```

Logistics is the **only** system that calls `commit`. Grocery reserves; logistics consumes or
returns. That single division closes the open loop described in analysis §14.1.

---

## 2. Principles

1. **One source of truth per fact.** Stock belongs to Inventory, the customer and payment
   belong to Grocery, the parcel belongs to logistics. Logistics stores snapshots and external
   references, never a second copy of a fact someone else maintains.
2. **The database holds the rules.** Transitions, guards and invariants live in Postgres
   functions under RLS, as in Inventory. The HTTP layer authenticates and delegates.
3. **Everything that leaves the building is queued.** The state change and the *enqueue*
   commit together; the HTTP call happens outside that transaction. A broken subscriber can
   never stop a rider marking a parcel delivered.
4. **Idempotent by construction.** Every inbound write carries a key; every outbound event
   carries an `event_id`; every retry is safe.
5. **Audit is not a feature.** Every transition writes actor, role, from, to, evidence and
   correlation id, or the transition does not happen.
6. **The customer outcome wins.** An Inventory outage queues a commit; it does not trap a
   rider at a door.

---

## 3. Components

| Component | Runtime | Responsibility |
|---|---|---|
| **Logistics API** | Next.js 16 App Router, Node runtime | `/api/v1/*` integration + operations surface |
| **Admin web** | Same Next app, route group `(admin)` | dashboard, queue, dispatch board, exceptions, returns, reports |
| **Rider PWA** | Same Next app, route group `(rider)` | mobile-first, service worker, IndexedDB outbox |
| **Outbound worker** | **Always-on Node process** (never serverless) | drains the outbound queue, signs, retries, dead-letters |
| **Ingest poller** | Same worker process, scheduled | **scaffold only** — polls Grocery until push lands |
| **Scheduled jobs** | pg_cron | stuck-delivery sweep, assignment timeout, OTP expiry, retention purges, queue reclaim |
| **Logistics DB** | Postgres (Supabase, via the **pooler**) | schemas `delivery`, `fleet`, `integration`, `ops` |
| **Proof storage** | Supabase Storage, **private** bucket | photos, signed short-lived URLs |

> The worker is deliberately not a serverless function. Inventory's `webhook-worker.mjs`
> header explains why: billed by wall-clock, killed mid-flight — which is precisely the crash
> the `SENDING` state exists to survive.

---

## 4. Technology

Inventory's stack, for the reasons in analysis §2 and §17.

| Concern | Choice |
|---|---|
| Framework | Next.js 16, App Router, ESM |
| Language | TypeScript, strict |
| Database | Postgres via the raw `pg` driver |
| Migrations | Numbered SQL + Inventory's `migrate.mjs` runner |
| Security | RLS on every table; claims via `request.jwt.claims`; `SET LOCAL ROLE` |
| Machine auth | `lg_live_…` keys, SHA-256 at rest, scoped |
| Human auth | bcrypt credentials, short sessions, device binding for riders |
| Signing | HMAC-SHA256 `t=…,v1=…` over `` `${t}.${body}` ``, 300 s window |
| Tests | `node --test` + `tsx`, phase suites, `npm run check` |
| Jobs | pg_cron |

---

## 5. Schemas

```
delivery    delivery, delivery_address, delivery_item, delivery_package,
            delivery_status_history, delivery_otp, delivery_proof,
            delivery_exception, delivery_return

fleet       rider, rider_credential, rider_shift, rider_availability,
            rider_location, assignment

integration api_client, idempotency_record, inbound_event, outbound_event,
            dead_letter

ops         audit_log, notification, api_request
```

Entity detail is in [`agent-reports/initial-analysis.md`](agent-reports/initial-analysis.md)
(Logistics Domain Architect). Column-level design lands in the Phase 1 analysis.

**Deliberately absent:** product, category, price, stock, purchase order, supplier, customer
account. Logistics holds `external_product_id`, `sku`, `external_customer_id`,
`external_order_id` and `external_location_id` — identifiers it never mints and never mutates.

---

## 6. The state machine

Fifteen states, as proposed in the brief and validated against the evidence, with `RECEIVED`
kept distinct because orders will arrive incomplete until Q1 and Q2 are resolved.

```
RECEIVED ──► READY_FOR_ASSIGNMENT ──► ASSIGNED ──► ACCEPTED ──► PICKUP_PENDING
                     ▲                    │
                     │  decline/timeout   │
                     └────────────────────┘
                                                          │
                                                          ▼
                              PICKED_UP ──► OUT_FOR_DELIVERY ──► ARRIVED
                                                                    │
                        ┌───────────────────────────────────────────┤
                        ▼                                           ▼
                   DELIVERED                                 DELIVERY_FAILED
              (OTP required)                                        │
              commit + VERIFY                    ┌──────────────────┴──────────────────┐
                                                 ▼                                     ▼
                                      RESCHEDULE_REQUIRED                      RETURN_REQUIRED
                                                 │                                     │
                                    back to READY_FOR_ASSIGNMENT           RETURN_IN_TRANSIT
                                                                                       │
                                                                                       ▼
                                                                                   RETURNED
                                                                                   release

   CANCELLED reachable from any non-terminal state (admin only, reason required) ──► release
```

Each transition declares: **allowed actor · permission · required evidence · external side
effect · customer notification · audit event · retry behaviour · manual-override behaviour.**
The full table is a Phase 1 deliverable.

Only three transitions touch Inventory: `DELIVERED` (commit + verify), `RETURNED` (release),
`CANCELLED` (release). Everything else is logistics-internal.

---

## 7. Request and event flow

**A delivery, end to end**

```
1  Grocery POSTs order.delivery_ready       -> signature, scope, schema, idempotency
2  IngestDeliveryOrder                      -> delivery RECEIVED + snapshot + audit
3  confirm reservations in Inventory        -> the hold stops expiring
4  Dispatcher admits                        -> READY_FOR_ASSIGNMENT
5  Dispatcher assigns                       -> ASSIGNED, rider notified
6  Rider accepts                            -> ACCEPTED    (timeout -> back to 4)
7  Rider confirms pickup                    -> PICKED_UP, Grocery -> SHIPPED
8  Rider departs / arrives                  -> OUT_FOR_DELIVERY, ARRIVED
9  OTP verified                             -> DELIVERED
10 commit to Inventory, then VERIFY         -> order_status must be "delivered"
11 delivery.status_changed to Grocery       -> DELIVERED, pipeline "delivered"
```

Steps 3, 10 and 11 are queued, retried with backoff, and dead-lettered on exhaustion. Step 10's
verification is the mitigation for analysis §14.2 and is non-negotiable.

---

## 8. Offline synchronisation (rider)

- Service worker caches the shell; IndexedDB holds assigned tasks and an append-only outbox.
- Every rider action is stamped with a **client-generated event id** at capture time. The
  server uses it as the idempotency key.
- Sync replays the outbox in order; the server applies each event through the state machine.
- **An illegal transition is not applied and not discarded** — it is raised as an exception for
  a human. Last-write-wins is not acceptable for `DELIVERED` (R-12).
- Proof photos are resized and EXIF-stripped client-side, queued, and uploaded on reconnect;
  the completion is not blocked on the upload.

---

## 9. Security posture

Summarised from the Security Agent's report:

- Server-side authorisation on every action. A rider may act only on their own active
  assignment; a dispatcher only within their locations. Hidden buttons are not a control.
- Proof files in a **private** bucket with short-lived signed URLs — never the public-bucket
  pattern Inventory correctly uses for product images.
- Rider location captured only between `PICKED_UP` and a terminal state.
- Customer phone masked by default (Q9); redacted from logs and the admin UI.
- OTP hashed at rest, 15-minute TTL, 5 attempts, single use, bound to the delivery.
- `PAID` from Grocery is **not** evidence of settlement and must never be treated as such.

---

## 10. Failure modes and responses

| Failure | Response |
|---|---|
| Grocery push fails | Grocery retries; the poller scaffold also catches it; ingest is idempotent |
| Duplicate ingest | Idempotency key → one delivery, replayed response |
| Malformed payload | `422`, dead-lettered immediately, never retried |
| Inventory down at ingest | Delivery created, flagged `reservation_unconfirmed`, retried by the queue |
| Inventory down at commit | **Delivery still completes.** Commit queued, retried, reconciled |
| Commit verification says `released` | `INVENTORY_HOLD_LOST` exception — a human reconciles. Stock was never reduced |
| Grocery status push fails | Retried with backoff, then dead-lettered and shown on integration health |
| Rider offline | Outbox; replayed on reconnect; conflicts surfaced, not auto-resolved |
| Rider unreachable mid-delivery | Stuck-delivery sweep raises it; dispatcher reassigns |
| Worker crash mid-send | `SENDING` rows reclaimed by age, exactly as in Inventory |

---

## 11. What this proposal deliberately does not do

- It does not modify Inventory. Every call it makes uses an endpoint that already exists.
- It does not rebuild anything Grocery owns.
- It does not create a second stock, price or catalogue source.
- It does not build COD, batching, routing, ETA prediction or auto-assignment in V1.
- It does not assume the delivery-ready trigger exists — because it does not (analysis §15).

---

## 12. Approval needed before Phase 1

1. This architecture, in outline.
2. The stack decision (Inventory's conventions, not Grocery's).
3. Separate repository and separate database.
4. The four blocking questions: **Q1** (address), **Q2** (pickup location), **Q3** (may
   Grocery change), **Q4** (reservation ids).

Q1 and Q3 together are the real gate. Phases 1–4 can be built and demonstrated without them
using the poller scaffold and seeded addresses — but **no real order can be delivered until an
address exists on an order.**
