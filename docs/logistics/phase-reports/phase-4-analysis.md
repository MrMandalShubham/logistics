# Phase 4 — Rider Delivery App · Analysis

**Date:** 2026-09-12 · **Status:** proposed, **awaiting approval before any code is written**
**Owner:** Lead Agent
**Depends on:** [Phase 3 verification](phase-3-verification.md)

---

## 0. Recommendation up front: split this phase

The brief's Phase 4 is: *login, online/offline, assigned tasks, task details, pickup,
navigation, customer contact, arrived, OTP, photo proof, completion, failed delivery, return
task, **offline mode, synchronisation***.

That is two different jobs, and the second is where the subtle bugs live:

| | Work | Risk |
|---|---|---|
| **4a — execution** | the rider does a delivery, online, and the sale is finally committed to Inventory | mostly linear; each step is a guarded transition |
| **4b — offline** | service worker, IndexedDB outbox, replay, conflict handling | a completion that arrives an hour late, after a dispatcher marked it failed |

Bundling them means reviewing a state machine and a distributed-sync problem in one pass, and
the sync problem deserves its own verification with its own failure tests.

**I propose Phase 4a now, Phase 4b next.** If you would rather keep it as one phase, say so and
I will scope it as one — it will simply be a much larger review.

Everything below is **4a**.

---

## 1. Objective

A rider does the job: sees what they have been given, collects it, goes to the door, proves
the handover, and completes it — and **the sale is finally written to Inventory's ledger.**

That last clause is the one that matters beyond this phase. Since the analysis in Phase 0,
nothing in this estate has ever called `commit`. Every order ever placed has held stock for
thirty minutes and then quietly given it back. **Phase 4a is where that stops.**

---

## 2. User value

The first phase a customer would notice, if they could see it — and they cannot until Phase 5.

- A rider has a screen that tells them what to do next.
- A parcel handed over is proven handed over.
- Inventory finally learns that goods left the building, so stock figures start being true.

---

## 3. Scope (Phase 4a)

| # | Deliverable | Detail |
|---|---|---|
| 3.1 | **Rider task list** | `/api/v1/me/*` — the Phase 3 gap: RLS allows it, the route gate did not |
| 3.2 | **Rider app shell** | mobile-first pages: my tasks, task detail, the step buttons |
| 3.3 | **Pickup** | `ACCEPTED → PICKUP_PENDING → PICKED_UP`, confirmed against the package list |
| 3.4 | **Navigation** | a maps deep link to the customer's geocode. No vendor, no SDK |
| 3.5 | **Customer contact** | the phone number, behind an explicit flag, audited every time it is revealed |
| 3.6 | **Arrived + OTP** | `OUT_FOR_DELIVERY → ARRIVED`; a 6-digit code generated at arrival |
| 3.7 | **Completion** | `DELIVERED`, requiring a valid OTP |
| 3.8 | **Photo proof** | optional, metadata + a pluggable store; **private**, never public |
| 3.9 | **Failed delivery** | `ARRIVED → DELIVERY_FAILED` with a reason code |
| 3.10 | **Reschedule / return required** | the two exits from a failure. Phase 6 completes them |
| 3.11 | **Rider location** | captured **only** between `PICKED_UP` and a terminal state |
| 3.12 | **Outbound queue** | Inventory's `0035` design, ported |
| 3.13 | **The commit** | `DELIVERED` → `commit` → **verify** → or raise `INVENTORY_HOLD_LOST` |
| 3.14 | **Assignment closure** | **Q25** — a trigger, not a remembered call |
| 3.15 | Tests | `tests/phase4.test.mjs` |

### Out of scope for 4a

- **Offline mode and synchronisation.** Phase 4b.
- The full exception taxonomy, support notes, return-to-store completion. **Phase 6.**
- Outbound status to Grocery. **Phase 5** (the queue is built here; Grocery is its second consumer).
- Signature capture, COD, batching, ETA.

---

## 4. The three decisions I want settled

### 4.1 Q25 — what closes an assignment

Raised in Phase 3 verification. Nothing sets `COMPLETED`, so a rider fills to capacity and
never empties.

| | Approach | Notes |
|---|---|---|
| A | Each completion function closes it | One forgotten call and a rider is stuck forever |
| **B** *(recommended)* | **A trigger on `delivery.delivery`**: when status becomes terminal, close any live assignment | Cannot be forgotten by a future phase. The same reasoning as the audit trigger and Inventory's event triggers |

Terminal for this purpose: `DELIVERED`, `RETURNED`, `CANCELLED`. A `DELIVERY_FAILED` delivery
is **still the rider's** — they are holding the parcel — so the assignment stays live until it
is rescheduled or returned.

### 4.2 The commit, and the hold that has probably expired

This is the phase's real risk, and it is not hypothetical.

A hold lapses 30 minutes after checkout. Logistics still cannot call `confirm`, because
`reserve` returns the reservation ids and nothing else does (**Q4**) — fixed in Grocery PR #1,
**whose migration has not been run.** So on a real order today, by the time a rider reaches a
door, the hold is very likely `released`.

And `POST /api/inventory/commit` answers `already_committed: true` for a released hold just as
it does for a consumed one (Phase 0 §14.2). Trusting it would mean believing the sale was
recorded when the stock was never reduced.

**Proposed handling, in order:**

```
DELIVERED  (the rider is free to go — this never blocks on Inventory)
   └─ enqueue commit
        ├─ POST /api/inventory/commit
        ├─ GET  /api/inventory/order/:id        ← the verification, not optional
        │     status == "delivered"  -> record ledger ids, commit_verified = true
        │     status == "held"       -> retry
        │     status == "released"   -> raise INVENTORY_HOLD_LOST, alert, human reconciles
        └─ 5xx / timeout -> retry with backoff, then dead-letter
```

**A failed commit must never block a delivery.** The parcel is at the door; the bookkeeping
catches up. But a `released` hold is a genuine stock discrepancy and must be loud.

I expect this to fire in testing. That is the system working.

### 4.3 The OTP has nowhere to go yet

A 6-digit code proves the handover. The customer needs to receive it — and logistics cannot
reach the customer until Phase 5, and there is no SMS provider anywhere in the estate (**Q10**).

| | Approach | Notes |
|---|---|---|
| A | Skip OTP until Phase 5 | Completion with no proof at all, for a whole phase |
| **B** *(recommended)* | Generate it, and let **dispatch/support read it out by phone**. Phase 5 delivers it properly | The code is real and enforced from day one; only its delivery channel is manual |
| C | Let the rider see and enter it | Not proof of anything |

**C is rejected outright** — a code the rider can read is a code the rider can use without ever
meeting the customer.

Under B: hashed at rest, 15-minute TTL, 5 attempts, single use, bound to one delivery.
Visible to `deliveries:read` holders so support can relay it; **never** to the rider.

---

## 5. Existing systems affected

| System | Effect |
|---|---|
| **Grocery** | None. Customer status is Phase 5 |
| **Inventory** | **First write ever made by logistics**: `POST /api/inventory/commit` on delivery, then a verifying read |

**Prerequisite:** the Inventory key gains **`reservations:write`** alongside `catalog:read` and
`stock:read`. Withheld since Phase 1 precisely until something needed it.

```sql
select api_key from platform.create_api_client(
  'Logistics Core', ARRAY['catalog:read','stock:read','reservations:write'], '{}', 'LIVE');
```

---

## 6. Database changes — `0008_execution.sql`

```sql
delivery.delivery_otp        code_hash, expires_at, attempts, consumed_at, delivery_id
delivery.delivery_proof      type (OTP|PHOTO), storage_ref, captured_by, captured_at, meta
delivery.delivery_exception  code, note, raised_by, raised_at        -- Phase 6 extends
fleet.rider_location         delivery_id, lat, lng, accuracy_m, recorded_at
integration.outbound_event   target, event, event_key, payload, status, attempts,
                             next_attempt_at, last_error, response
```

`delivery.delivery` gains `commit_status` (`pending | verified | failed | not_required`),
`commit_ledger_ids jsonb`, `delivered_at`, `failed_reason_code`.

**The widened state machine:**

```
ACCEPTED         -> PICKUP_PENDING, READY_FOR_ASSIGNMENT, CANCELLED
PICKUP_PENDING   -> PICKED_UP, DELIVERY_FAILED, CANCELLED
PICKED_UP        -> OUT_FOR_DELIVERY, DELIVERY_FAILED
OUT_FOR_DELIVERY -> ARRIVED, DELIVERY_FAILED
ARRIVED          -> DELIVERED, DELIVERY_FAILED
DELIVERY_FAILED  -> RESCHEDULE_REQUIRED, RETURN_REQUIRED
RESCHEDULE_REQUIRED -> READY_FOR_ASSIGNMENT, RETURN_REQUIRED
RETURN_REQUIRED  -> RETURN_IN_TRANSIT            (Phase 6 completes it)
DELIVERED        -> (terminal)
```

**Rider-only transitions** (`PICKED_UP`, `ARRIVED`, `DELIVERED`, `DELIVERY_FAILED`) carry the
same ownership check Phase 3 established: the database verifies the caller holds the live
assignment, not the route.

**The outbound queue** is Inventory's `0035_webhook_delivery.sql` design: `PENDING → SENDING →
DELIVERED | FAILED | DEAD`, deduplicated at queue time by `event_key`, claimed with
`FOR UPDATE SKIP LOCKED`, exponential backoff `10 × 4ⁿ`, reclaimed by age after a worker dies.
Proven in this estate; no reason to invent another.

**Permissions added:** `deliveries:execute` (rider), `proof:read` (admin, dispatcher, support),
`integration:replay` extended to outbound.

---

## 7. APIs

**Rider-facing** — the Phase 3 gap closed:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/me` | who am I, am I online, what is my load |
| `GET` | `/api/v1/me/tasks` | my live tasks |
| `GET` | `/api/v1/me/tasks/:id` | the task: address, items, navigation link, contact |
| `POST` | `/api/v1/me/tasks/:id/pickup` | at the shop → `PICKUP_PENDING` |
| `POST` | `/api/v1/me/tasks/:id/picked-up` | `{ items_confirmed }` → `PICKED_UP` |
| `POST` | `/api/v1/me/tasks/:id/depart` | → `OUT_FOR_DELIVERY` |
| `POST` | `/api/v1/me/tasks/:id/arrived` | → `ARRIVED`, generates the OTP |
| `POST` | `/api/v1/me/tasks/:id/complete` | `{ otp, photo_ref? }` → `DELIVERED` |
| `POST` | `/api/v1/me/tasks/:id/fail` | `{ reason_code, note }` → `DELIVERY_FAILED` |
| `POST` | `/api/v1/me/tasks/:id/location` | a ping, accepted only while carrying |
| `POST` | `/api/v1/me/tasks/:id/contact` | reveals the phone number, **audited** |
| `POST` | `/api/v1/me/availability` | online / offline |

**Staff-facing:** `GET /api/v1/deliveries/:id/otp` (relay it by phone),
`GET /api/v1/deliveries/:id/proof`, `POST /api/v1/deliveries/:id/reschedule`,
`POST /api/v1/deliveries/:id/return-required`,
`GET /api/v1/integration/outbound-events`, `POST .../:id/retry`.

Every rider route resolves the rider from the **session**, never a parameter. There is no
`rider_id` to tamper with.

---

## 8. The rider app

Mobile-first pages in a `(rider)` route group — one screen at a time, one obvious action.

```
/me                 today: online toggle, my tasks
/me/tasks/:id       the task, and the single next step
```

Big touch targets, current step highlighted, no navigation chrome to get lost in. Server
components with server actions, as elsewhere — **no client framework.**

**Navigation** is a plain `https://www.google.com/maps/dir/?api=1&destination=<lat>,<lng>`
link. No SDK, no key, works on every phone.

> **Q21 again:** we have the customer's geocode (Grocery now sends it) but **not the shop's**,
> so navigation works to the door and not to the pickup. A rider knows where their own shop is,
> so this is liveable — but it blocks any future routing work.

---

## 9. Security risks

| # | Risk | Mitigation |
|---|---|---|
| P4-01 | **A rider completes somebody else's delivery** | Ownership checked in the database on every execute transition, as Phase 3 |
| P4-02 | **A rider completes without meeting the customer** | The OTP is never shown to the rider — that is the entire point of §4.3 rejecting option C |
| P4-03 | OTP brute force | Hashed, 6 digits, 5 attempts, 15-minute TTL, single use, bound to one delivery. Attempts audited |
| P4-04 | **Proof photos are public** | Private store, short-lived signed URLs, EXIF stripped. Never the public pattern Inventory correctly uses for product images |
| P4-05 | A photo of the wrong thing, or of a person | Stored against one delivery, readable only by `proof:read`, retention in Phase 7 |
| P4-06 | **Customer phone harvesting** | Revealed per task, per reveal, **audited with the rider's id**. No bulk endpoint returns phone numbers |
| P4-07 | **Rider location is continuous tracking of a worker** | Accepted **only** between `PICKED_UP` and terminal. Rejected outside that window — enforced, not conventional |
| P4-08 | Double completion | The state machine refuses it; the OTP is single-use; the commit is deduplicated by `event_key` |
| P4-09 | **A commit believed but not made** | §4.2 verification. `already_committed` is never trusted alone |
| P4-10 | A rider marks delivered from home | Optional: compare the location ping at `ARRIVED` against the address. **Proposed as a recorded warning, not a block** — GPS is wrong often enough that blocking would strand honest riders |

---

## 10. Tests

`tests/phase4.test.mjs`, roughly 50, on top of 130.

**The happy path (6)** — accept → pickup → picked up → depart → arrived → OTP → delivered, with
the timeline and the assignment closed.

**Ownership (5)** — every rider transition refused for a rider who does not hold the
assignment; `/me/tasks` shows only theirs; location and contact refused for others.

**OTP (8)** — generated at `ARRIVED`; **never returned to the rider**; visible to support;
wrong code refused; 5 failures lock it; expired refused; single use; a code from another
delivery refused.

**Commit (8)** — `DELIVERED` enqueues; a verified commit records ledger ids; **`released`
raises `INVENTORY_HOLD_LOST`**; `already_committed` alone is not trusted; Inventory unreachable
retries then dead-letters; **the delivery still completes throughout**; duplicate commits are
deduplicated; the queue is idempotent.

**Failure paths (6)** — fail requires a reason; failed keeps the assignment live (§4.1);
reschedule returns it to the queue; return-required moves it on; a failed delivery does **not**
commit.

**Location (5)** — accepted while carrying; **refused before `PICKED_UP`**; refused after
terminal; refused for another rider's task; recorded with accuracy.

**Assignment closure (4)** — Q25: closed on `DELIVERED`, on `RETURNED`, on `CANCELLED`; **not**
closed on `DELIVERY_FAILED`; the rider's capacity is freed.

**State machine (4)** — mirrors agree; illegal transitions refused; `DELIVERED` is terminal;
Phase 1–3 tests still pass.

---

## 11. Verification

```bash
npm run check && npx tsc --noEmit && npm run build
npm run db:verify
npm run outbound:drain -- --once
```

**Live, against real Inventory:** reserve real stock, ingest, admit, assign, accept, then walk
a rider through to `DELIVERED` and **confirm the ledger entry exists in Inventory** — the first
time in this estate's history that a sale has been recorded.

Then the unhappy one: let the hold expire first, deliver anyway, and confirm
`INVENTORY_HOLD_LOST` is raised rather than a false success.

---

## 12. Rollback

`drop schema`-level rollback is no longer clean: this phase writes to **another system**. A
commit, once made, is a ledger entry in Inventory and is not ours to undo.

| Scenario | Action |
|---|---|
| Bad deploy | Redeploy previous. Queued commits resume; they are idempotent |
| Bad migration | `0008` adds tables and replaces `allowed_next`. Reverting restores Phase 3 |
| **A wrong commit** | **Not reversible from here.** Inventory's ledger is append-only by design; a correction is a stock adjustment made in Inventory by a human |

That asymmetry is the reason for the verification in §4.2 rather than optimism.

---

## 13. Open questions

| # | Question |
|---|---|
| **Q4** | Reservation confirm. **Grocery PR #1 fixes it; the migration is unrun.** Until then expect `INVENTORY_HOLD_LOST` on any delivery slower than 30 minutes |
| **Q10** | OTP delivery channel — manual relay for now (§4.3) |
| **Q21** | No shop coordinates: navigation works to the door, not the pickup |
| **Q26** *(new)* | **Where do proof photos live?** Proposed: a pluggable driver, `local` for development and Supabase Storage (private bucket) for production — mirroring Inventory. Photos are **optional** in 4a; OTP is the proof that counts |
| **Q27** *(new)* | **Is the phone number masked?** No provider exists (Q9). Proposed: reveal the real number behind an audited endpoint, one task at a time, and revisit when a telephony provider is chosen |
| **Q28** *(new)* | **Should a location far from the address block completion?** Proposed **no** — record a warning. GPS is wrong often enough that blocking would strand honest riders at real doors |

---

## Approval requested

**Please confirm:**

1. **The split** — 4a (execution) now, 4b (offline sync) next. Or tell me to do it in one.
2. **Q25 → option B**: a trigger closes the assignment; `DELIVERY_FAILED` keeps it open.
3. **§4.2** — the delivery completes for the rider regardless of Inventory, and a `released`
   hold raises a loud exception rather than a quiet success.
4. **§4.3 → option B**: the OTP is generated and enforced now, relayed by support until
   Phase 5. **Never shown to the rider.**
5. **Q28** — a distant location is a recorded warning, not a block.
6. Granting the Inventory key **`reservations:write`** (§5).
7. That building **Phase 4a before the Grocery migration is run** is acceptable — meaning the
   first real commits will likely hit `INVENTORY_HOLD_LOST` until PR #1 lands.
