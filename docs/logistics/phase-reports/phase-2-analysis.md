# Phase 2 — Receive Delivery-Ready Orders · Analysis

**Date:** 2026-09-12 · **Status:** proposed, **awaiting approval before any code is written**
**Owner:** Lead Agent
**Depends on:** [Phase 1 verification](phase-1-verification.md) ·
[Integration contract](../02-integration-contract.md) · [Open questions](../03-open-questions.md)

---

## 0. What the live probe established

Before designing anything, I ran the reserve/status pair against the running Inventory. Three
facts settle the shape of this phase:

```
POST /api/inventory/reserve
  -> { "items": [ { "sku": "…", "reservation_id": "9ed3c3bc-…" } ] }     ids ARE returned

GET /api/inventory/order/phase2-probe-001
  -> { "status": "held",
       "items": [ { "sku": "…", "status": "held",
                    "expires_at": "2026-09-12T09:31:42.354Z" } ] }        expiry IS readable
                                                                          ids are NOT

GET /api/inventory/order/no-such-order  -> 404 "Nothing was ever reserved for …"
```

1. **The hold can be verified at ingest.** `held` vs `released` vs 404 is exactly the check
   the delivery-ready definition needs (analysis §15.3 condition 2).
2. **`expires_at` is readable**, so a hold about to lapse can be monitored even when it cannot
   be confirmed.
3. **`reservation_id` is returned by `reserve` and never again.** Q4 stands: logistics cannot
   confirm a hold unless someone forwards those ids. Phase 2 is designed around that rather
   than blocked by it (§9.3).

The probe reservation was released afterwards; Inventory holds no stray state.

---

## 1. Objective

Accept a delivery-ready order from Grocery, exactly once, and turn it into a logistics delivery
record with a read-only snapshot of everything a rider will need — then show it to a dispatcher
in a queue with a full timeline.

At the end of Phase 2 an order can enter logistics and be seen. **It still cannot be assigned
to anybody** — that is Phase 3.

---

## 2. User value

First real value in the programme:

- A dispatcher can see what is waiting to go out, per shop, with what is in the bag.
- An order that arrives malformed is visible and replayable rather than silently lost.
- Every delivery has a timeline from its first moment, so "what happened to this order" is
  answerable before there is anything complicated to answer about.

---

## 3. Scope

| # | Deliverable | Detail |
|---|---|---|
| 3.1 | **Delivery schema** | `delivery`, `delivery_address`, `delivery_item`, `delivery_status_history` |
| 3.2 | **Inbound endpoint** | `POST /api/v1/integration/orders.delivery-ready` — bearer key + HMAC + idempotent |
| 3.3 | **Order reference** | `external_order_id` unique; `tracking_id` `DLV-YYYY-NNNNNN` issued by us |
| 3.4 | **Read-only snapshot** | address, contact, items, amounts — captured, never recalculated |
| 3.5 | **Hold verification** | at ingest, `GET /api/inventory/order/:id` must say `held`; record `hold_expires_at` |
| 3.6 | **Delivery timeline** | every transition with actor, reason, correlation id |
| 3.7 | **Admin delivery queue** | server-rendered list + detail, permission-gated, location-scoped |
| 3.8 | **Admission gate** | `RECEIVED → READY_FOR_ASSIGNMENT`, dispatcher action |
| 3.9 | **Retry & failure** | `integration.inbound_event` with dead-lettering and admin replay |
| 3.10 | **Hold-expiry monitor** | a report of deliveries whose inventory hold is lapsing (the Q4 mitigation) |
| 3.11 | **Tests** | `tests/phase2.test.mjs`, extending the Phase 1 harness |

### Simplifications carried forward from the "keep it simple" direction

| Contract said | Phase 2 builds | Why |
|---|---|---|
| A Grocery poller as an interim scaffold | **Dropped.** A signed `npm run demo:order` script posts a realistic payload instead | The poller needs Grocery Supabase credentials that do not exist, tests nothing the endpoint does not, and I said it would be deleted. A dev script is simpler and exercises the *real* path |
| Separate `integration.inbound_event` + `dead_letter` tables | One table with a `status` column | A dead letter is a failed inbound event, not a different kind of thing |
| Outbound event queue | **Not in this phase** | Nothing consumes it until Phase 5 |
| Full 15-state machine | Enum defined, only Phase 2 transitions permitted | One CHECK constraint now avoids a migration later; the guard function only allows what exists |

---

## 4. Out of scope

- **Assignment, riders, dispatch board.** Phase 3.
- **Any rider-facing anything.** Phase 4.
- **Outbound status to Grocery.** Phase 5 — and blocked on Q3 regardless.
- **`commit` / `release` to Inventory.** Phase 4/6, with their callers. Phase 2 only *reads*.
- **Confirming reservations.** Blocked on Q4; mitigated by §9.3, not faked.
- **Exceptions, returns, proof, OTP.** Phases 4 and 6.
- **Editing a delivery address inside logistics.** Deliberate — see §9.2.
- Anything Grocery or Inventory owns.

---

## 5. Existing systems affected

| System | Effect |
|---|---|
| **Grocery** | **None.** It cannot call us yet (Q1/Q3). The endpoint is built and waiting; the demo script stands in |
| **Inventory** | **Two read-only calls**: `GET /api/locations` (Phase 1, unchanged) and **new** `GET /api/inventory/order/:id` at ingest. No writes |

**Prerequisite:** the Inventory key gains **`stock:read`** alongside `catalog:read`.
Still **not** `reservations:write` — nothing in Phase 2 writes to Inventory.

```sql
select api_key from platform.create_api_client(
  'Logistics Core', ARRAY['catalog:read','stock:read'], '{}', 'LIVE');
```

---

## 6. Logistics modules affected

| Module | Change |
|---|---|
| `delivery` | **created** |
| `integration` | `inbound_event` added; `api_client` unchanged |
| `identity` | 5 permission rows added. No schema change |
| `ops` | audit vocabulary extended. No schema change |
| `fleet` | still not created — Phase 3 |

---

## 7. Files to change

New unless marked. Nothing in Grocery or Inventory.

```
db/migrations/
  0005_delivery.sql          delivery, address, item, status_history, transition guard
  0006_inbound.sql           integration.inbound_event + permissions + grants

lib/
  delivery/ingest.ts         the one ingest command, source-agnostic
  delivery/states.ts         the state machine, mirroring the DB guard
  inventory.ts               MODIFIED - add getOrderStatus() (read-only)
  webhooks.ts                sign()/verify(), ported verbatim from Inventory

app/api/v1/
  integration/orders.delivery-ready/route.ts
  integration/inbound-events/route.ts              list, admin
  integration/inbound-events/[id]/retry/route.ts   replay, admin
  deliveries/route.ts                              list
  deliveries/[id]/route.ts                         detail + timeline
  deliveries/[id]/admit/route.ts
  deliveries/[id]/cancel/route.ts

app/(admin)/
  deliveries/page.tsx        the queue
  deliveries/[id]/page.tsx   detail + timeline

scripts/
  demo-order.mjs             sign and post a realistic payload

tests/
  phase2.test.mjs
```

`app/api/health/route.ts` — bump `EXPECTED_MIGRATIONS` to 6.

---

## 8. Database changes

### 0005 — delivery

```sql
create table delivery.delivery (
  id                uuid primary key default gen_random_uuid(),

  -- The idempotency guarantee at the DATA layer, not just in the
  -- wrapper. Two concurrent ingests of one order cannot both insert,
  -- whatever the application believes.
  external_order_id text not null unique,
  tracking_id       text not null unique,        -- DLV-2026-000001

  external_customer_id text,
  status            text not null default 'RECEIVED' check (status in (
                      'RECEIVED','READY_FOR_ASSIGNMENT','ASSIGNED','ACCEPTED',
                      'PICKUP_PENDING','PICKED_UP','OUT_FOR_DELIVERY','ARRIVED',
                      'DELIVERED','DELIVERY_FAILED','RESCHEDULE_REQUIRED',
                      'RETURN_REQUIRED','RETURN_IN_TRANSIT','RETURNED','CANCELLED')),

  pickup_location_code text not null references integration.location_ref(code),

  -- Reference only. Logistics never computes an amount.
  payment_method    text,
  is_prepaid        boolean not null default true,
  amount_to_collect_paise integer not null default 0,
  order_total_paise integer,

  promised_from     timestamptz,
  promised_to       timestamptz,

  -- From GET /api/inventory/order/:id at ingest. Null when the hold
  -- could not be checked; drives the expiry monitor (9.3).
  hold_status       text check (hold_status in ('held','delivered','released','unknown')),
  hold_expires_at   timestamptz,
  hold_confirmed    boolean not null default false,

  placed_at         timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
```

`delivery_address` is a **snapshot**, one row per delivery: recipient, phone, two lines, city,
pincode, `lat`, `lng`, instructions. `delivery_item` likewise: `external_product_id`, `sku`,
`name`, `quantity`, and `reservation_id` **nullable** (Q4).

`delivery_status_history`: `delivery_id`, `from_status`, `to_status`, `actor_id`, `actor_role`,
`reason_code`, `note`, `correlation_id`, `occurred_at`. Insert-only, like the audit log.

**The transition guard** — one function, the single place a status may change:

```sql
delivery.transition(p_delivery_id uuid, p_to text, p_reason text, p_note text)
```

It refuses a move not in the allowed map, writes the history row and the audit row, and bumps
`updated_at` — all in one transaction. Phase 2 permits only:

```
RECEIVED ──► READY_FOR_ASSIGNMENT ──► (Phase 3)
   │                  │
   └──────────────────┴──────► CANCELLED
```

Everything else raises `ILLEGAL_TRANSITION` naming the allowed set. Later phases widen the map
rather than adding a second code path.

**Tracking id** is issued by a sequence-backed function, `DLV-<year>-<6 digits>`, gapless per
year. Readable over a phone, which matters when a customer rings up.

### 0006 — inbound events

```sql
create table integration.inbound_event (
  id             uuid primary key default gen_random_uuid(),
  source         text not null,               -- 'GROCERY'
  event          text not null,               -- 'order.delivery_ready'
  event_id       text,
  external_order_id text,
  payload        jsonb not null,              -- exactly what arrived
  status         text not null default 'ACCEPTED'
                   check (status in ('ACCEPTED','REJECTED','DEAD','REPLAYED')),
  error_code     text,
  error_detail   text,
  attempts       integer not null default 1,
  correlation_id text,
  received_at    timestamptz not null default now(),
  resolved_at    timestamptz
);
```

**Every** inbound request is recorded, accepted or not. A rejection is `REJECTED` with the
reason; an admin replay sets `REPLAYED`. This is what makes an order that arrives without an
address recoverable rather than lost (§9.2).

RLS on all new tables; `delivery` and its children are location-scoped via
`ops.can_access_location(pickup_location_code)`, so a dispatcher bound to SH1 sees SH1's queue
and no one else's.

---

## 9. The three hard problems, and how Phase 2 handles them

### 9.1 There is still no delivery address anywhere (Q1)

Unchanged since Phase 0: no order in the estate carries one. Phase 2 does **not** pretend
otherwise.

The contract **requires** `delivery_address` with `lat`/`lng`. An order without one is refused
`422 address_not_deliverable` — and recorded as a `REJECTED` inbound event with its full
payload, so that when Grocery starts sending addresses the backlog can be replayed. Nothing is
lost while we wait.

The demo script supplies a well-formed address so the whole path is testable today.

### 9.2 Why a dispatcher may NOT type in a missing address

Tempting, and wrong. The moment logistics accepts a hand-typed address, logistics owns a
customer address that Grocery also owns, and there are two answers to "where does this
customer live". The customer changes theirs in Grocery, and we deliver to the old one.

So: **reject at ingest, keep the payload, replay when fixed.** The boundary holds and no data
is lost. If operations genuinely need a correction workflow, that is a Grocery feature (edit
the order) and a re-send — not a logistics field.

This is the strongest argument I have for resolving **Q1** before Phase 3.

### 9.3 The 30-minute hold, without the ability to confirm it (Q4)

The probe confirmed `reservation_id` is returned by `reserve` and never again, so logistics
cannot call `confirm` and a hold will lapse after 30 minutes — likely before a real delivery
completes.

Phase 2 does three honest things rather than one dishonest one:

1. **Verify at ingest.** `GET /api/inventory/order/:id` must return `held`. `released` or 404
   means the goods are not actually allocated; the order is refused `422 hold_not_held`.
2. **Record `hold_expires_at`** and expose a **hold-expiry report** — deliveries whose hold
   lapses within N minutes. An operator can see the problem before a rider is standing in a
   shop.
3. **Accept `reservation_id` per item if the payload carries it**, storing it ready for the day
   confirm becomes possible. The column exists; nothing calls confirm yet.

What Phase 2 will **not** do is re-reserve. That double-holds real stock, and both holds are
real.

**This remains a known limitation, not a solution.** The fix is Q4 option A (Grocery forwards
the ids) or B (Inventory adds `confirm_order`). Recommended before Phase 4 ships a real
delivery.

---

## 10. APIs

| Method | Path | Auth | Permission / scope |
|---|---|---|---|
| `POST` | `/api/v1/integration/orders.delivery-ready` | key + HMAC | `orders:ingest` |
| `GET` | `/api/v1/deliveries` | session/key | `deliveries:read` |
| `GET` | `/api/v1/deliveries/:id` | session/key | `deliveries:read` |
| `POST` | `/api/v1/deliveries/:id/admit` | session | `deliveries:admit` |
| `POST` | `/api/v1/deliveries/:id/cancel` | session | `deliveries:cancel` |
| `GET` | `/api/v1/integration/inbound-events` | session | `integration:read` |
| `POST` | `/api/v1/integration/inbound-events/:id/retry` | session | `integration:retry` |

**Inbound validation order** — cheapest and most security-relevant first:

```
signature present & within 300s   -> 401 invalid_signature
bearer key valid, orders:ingest   -> 401 / 403
Idempotency-Key present           -> 400
  same key + same body            -> 200 replay
  same key + different body       -> 422 idempotency_key_reused
schema valid                      -> 422 schema_invalid  (+ field list)
address present with lat/lng      -> 422 address_not_deliverable
pickup location known & active    -> 422 unknown_pickup_location
items non-empty, qty positive     -> 422 schema_invalid
inventory says "held"             -> 422 hold_not_held
                                  -> 201 created
```

Every outcome writes an `inbound_event`. A `4xx` is **never** retried by us — it is a poison
message and goes straight to the record for an admin to look at. Only a `5xx` on our side is
worth the sender retrying.

**Admin UI:** `/deliveries` (queue, filter by status and location) and `/deliveries/:id`
(snapshot, items, hold state, timeline, Admit/Cancel buttons gated on permission). Server
components, no client framework — the interactive dispatch board is Phase 3.

---

## 11. Events

**Still no outbound events.** Phase 5.

Audit vocabulary added:

```
delivery.created          delivery.admitted        delivery.cancelled
ingest.accepted           ingest.rejected          ingest.replayed
hold.verified             hold.check_failed
```

---

## 12. Permissions

New rows in `identity.role_permission`:

| Permission | admin | dispatcher | rider |
|---|:--:|:--:|:--:|
| `deliveries:read` | ✓ | ✓ | |
| `deliveries:admit` | ✓ | ✓ | |
| `deliveries:cancel` | ✓ | | |
| `integration:read` | ✓ | | |
| `integration:retry` | ✓ | | |

A rider still holds only `locations:read`. Riders get delivery permissions in Phase 4, scoped
to *their own assignment* — which does not exist yet.

New scope: `orders:ingest` (already in the Phase 1 vocabulary, first used here).

---

## 13. Security risks

| # | Risk | Mitigation |
|---|---|---|
| P2-01 | Webhook replay | HMAC over `t.body`, 300 s window, plus `event_id` uniqueness and the idempotency record. Three layers, because one is a single point of failure |
| P2-02 | Forged delivery-ready order | Signature **and** bearer key. Either alone is insufficient |
| P2-03 | **Customer PII enters a third database** | Snapshot only what a delivery needs. Phone masked in logs and in list views; full value only on the detail screen, permission-gated. Retention purge belongs with Phase 7 |
| P2-04 | **PII inside `inbound_event.payload`** | The raw payload contains the address. Same RLS as the delivery; admin-only; and the redactor already covers these field names in logs |
| P2-05 | Dispatcher reads another shop's customers | RLS on `pickup_location_code`, asserted per role in tests |
| P2-06 | Timing attack on `external_order_id` | Lookups are indexed equality; unknown returns the same shape as forbidden |
| P2-07 | Oversized payload | Body cap before parse; an order is not megabytes |
| P2-08 | Inventory unreachable at ingest | Refusing everything would make an Inventory blip a Grocery outage. Ingest proceeds with `hold_status='unknown'`, the delivery is flagged, and the expiry monitor surfaces it. **The dispatcher sees it before a rider does** |
| P2-09 | Poison message retried forever | `4xx` is never retried; it is recorded and waits for a human |
| P2-10 | Illegal transition via a crafted request | The DB guard is the enforcement point; the API cannot bypass it |

---

## 14. Tests

`tests/phase2.test.mjs`. Target ~45, on top of Phase 1's 41.

**Ingest — happy and hostile**
1. A well-formed order creates one delivery, one address, N items, one history row.
2. `tracking_id` is issued, unique, and `DLV-<year>-<6>` shaped.
3. **Five concurrent identical ingests produce exactly one delivery** (the unique index, not luck).
4. Same idempotency key + same body replays the original 201 body.
5. Same key + different body → 422 `idempotency_key_reused`.
6. Missing signature → 401. Bad signature → 401. Signature older than 300 s → 401.
7. Valid signature, wrong key → 401. Right key, missing scope → 403.
8. Missing address → 422 `address_not_deliverable`, and an inbound_event is recorded `REJECTED`.
9. Address without `lat`/`lng` → 422.
10. Unknown pickup location → 422. Inactive location → 422.
11. Empty items, zero quantity, negative quantity → 422 each.
12. Unknown field in payload is ignored, not rejected (forward compatibility).

**Hold verification**
13. Inventory says `held` → 201, `hold_status='held'`, `hold_expires_at` recorded.
14. Inventory says `released` → 422 `hold_not_held`.
15. Inventory 404 → 422 `hold_not_held`.
16. **Inventory unreachable → 201 with `hold_status='unknown'`** and a flag (P2-08).
17. The expiry report lists a delivery whose hold lapses inside the window, and excludes one that does not.

**State machine**
18. `RECEIVED → READY_FOR_ASSIGNMENT` succeeds and writes history with the actor.
19. `RECEIVED → DELIVERED` raises `ILLEGAL_TRANSITION` naming the allowed set.
20. `CANCELLED → READY_FOR_ASSIGNMENT` is refused (terminal).
21. Admitting twice is refused, not silently repeated.
22. Every transition writes exactly one history row and one audit row.
23. Timeline is returned oldest-first with actor and reason.

**Permissions and RLS**
24. Dispatcher bound to SH1 sees only SH1 deliveries; admin sees all.
25. Rider sees no deliveries at all.
26. Dispatcher cannot cancel; admin can.
27. Dispatcher cannot read inbound events.
28. A delivery's address and items are invisible to a role that cannot see the delivery.

**Dead letters**
29. A rejected ingest is listed for an admin with its reason.
30. Replaying a fixed payload creates the delivery and marks the event `REPLAYED`.
31. Replaying an already-successful event does not double-create.

---

## 15. Verification commands

```bash
npm run db:reset
npm run db:verify          # RLS coverage now spans the delivery schema
npm test                   # phase1 + phase2
npm run check              # the gate
npx tsc --noEmit
npm run build
npm run demo:order         # sign and post a realistic delivery-ready order
npm run locations:sync     # unchanged, still green
```

Plus a manual pass: ingest via the demo script, view the queue, open the detail, admit,
confirm the timeline, then reject a bad payload and replay it from the dead-letter screen.

**Live integration:** run against the real Inventory on `:3100` as in Phase 1 — hold verified,
released, and unreachable all exercised against the real service, not a mock.

---

## 16. Rollback strategy

| Scenario | Action |
|---|---|
| Bad deploy | Redeploy previous image. Phase 2 adds no outbound writes — nothing external has changed state |
| Bad migration | Forward-fix. `0005`/`0006` only ADD objects; Phase 1 tables are untouched |
| Abandon Phase 2 | `drop schema delivery cascade` + drop `integration.inbound_event`. Phase 1 still passes |
| Bad ingested data | Deliveries are cancellable, and `inbound_event` holds the original payload for replay |

**Data loss risk: low.** Real customer data enters the system for the first time, so from this
phase on the database is worth backing up. Flagged for DevOps.

---

## 17. Open questions

| # | Question | Effect on Phase 2 |
|---|---|---|
| **Q1** | Delivery address on an order | **Not blocking the build.** Blocks real orders. Rejected payloads are retained and replayable |
| **Q2** | Fulfilment location | Contract requires `pickup.location_code`; demo script supplies it |
| **Q3** | May Grocery be modified | Not needed until Phase 5 |
| **Q4** | Reservation ids | Confirm deferred; expiry monitored instead (§9.3). **Should be resolved before Phase 4** |
| **Q16** | Inventory key | Needs `stock:read` added this phase |
| **Q21** | Location coordinates | Not blocking. Bites in Phase 3 |
| **Q22** *(new)* | How long is the promised delivery window, and who sets it? Phase 2 stores `promised_from/to` from the payload; nothing supplies them yet. Default: leave null and compute an SLA from a flat config in Phase 7 | minor |

---

## Approval requested

Phase 2 will not begin until this is approved.

**Please confirm:**

1. **Scope** (§3) and exclusions (§4) — in particular that Phase 2 ships **no assignment and
   no rider-facing anything**.
2. **Dropping the Grocery poller** in favour of a signed demo script (§3).
3. **§9.2 — a dispatcher may not type in a missing address.** Reject, retain, replay. This is
   the boundary decision I most want you to agree with explicitly.
4. **§9.3 — shipping without reservation confirm**, with verification and expiry monitoring
   instead, as a stated known limitation.
5. **§P2-08 — an Inventory outage does not block ingest**; the delivery is flagged `unknown`
   rather than refused.
6. Adding **`stock:read`** to the Inventory key (§5).
