# Phase 4a — Rider Execution · Verification

**Date:** 2026-09-12 · **Status:** **PASS** · **Owner:** Lead Agent
**Analysis:** [`phase-4-analysis.md`](phase-4-analysis.md) (4a scope; 4b is offline sync)

---

## 1. The headline

**This estate has written its first ledger entry.**

Since the Phase 0 analysis, nothing here had ever called `commit`. Every order ever placed
held stock for thirty minutes and quietly gave it back; Inventory was never told that goods
left a building.

```
stock before   86
rider delivers 3 units, OTP verified
drain          commit verified, ledger_ids [10]
stock after    83
Inventory      { "status": "delivered", "items": [{ "status": "consumed" }] }
```

---

## 2. Commands

| Command | Result |
|---|---|
| `npm run db:reset` | 8 migrations from empty |
| `npm run db:verify` | **11/11** (24 tables under RLS) |
| `npm test` | **177 tests, 177 pass, 0 fail** |
| `npm run check` | **PASS** |
| `npx tsc --noEmit` | clean |
| `npm run build` | PASS |
| `npm run outbound:drain` | commits and verifies |
| Live HTTP | full rider journey + both failure paths |

## 3. Tests

```
ℹ tests 177        (130 from Phases 1–3, 47 added)
ℹ pass 177
ℹ fail 0
```

| Suite | Covers |
|---|---|
| state machine (4) | mirrors agree across 15 statuses, DELIVERED terminal, carrying window, every rider step legal |
| happy path (4) | accepted → delivered, timeline complete, OTP proof, photo reference |
| ownership (5) | **another rider cannot step, complete, fail or locate** — even holding the right code; staff may act for a rider |
| the OTP (9) | **a rider cannot issue one**, **cannot call mint_otp either**, arriving mints silently, wrong code counts, five locks, expiry, single use, rotation, cross-delivery refused |
| the commit (12) | enqueued once, deduplicated, SENDING on claim, fatal → DEAD, retryable → backoff, stuck reclaimed, **direct writes refused**, failure raises CRITICAL, operator view agrees with worker, rider cannot drain, **a failed delivery commits nothing** |
| failed delivery (4) | reason required, exception raised, **assignment stays live**, becomes reschedule or return |
| location (3) | **refused before pickup**, accepted while carrying, refused after delivery |
| assignment closure (3) | Q25 — closed on DELIVERED and CANCELLED, and by **trigger** on a direct status write |
| proof visibility (3) | OTP table unreadable by anyone, proof needs the permission, rider cannot read the queue |

---

## 4. The verification that earns its place

The most important thing built in this phase is the second call after a commit. Proven live by
letting a hold lapse and delivering anyway — exactly what will happen on a real order until
Grocery PR #1 is merged.

**What Inventory's commit endpoint said:**

```json
{ "ok": true,
  "already_committed": true,
  "items": [ { "sku": "PRD-2026-000001", "quantity": 1, "status": "RELEASED" } ] }
```

`ok: true`. `already_committed: true`. And the item status is **`RELEASED`** — the stock went
back on the shelf and was never reduced. A system that believed that response would have
recorded a sale that did not happen, silently, forever.

**What logistics did instead:**

```
[outbound] outbound job dead — INVENTORY_HOLD_LOST: commit reported success but the hold
           for ORD-LOST-… is released — the stock was never reduced. A person must reconcile this.

 tracking_id     | status    | commit_status | code                | severity
 DLV-2026-000090 | DELIVERED | failed        | INVENTORY_HOLD_LOST | CRITICAL
```

Three things to note:

1. **The delivery still says DELIVERED.** The parcel was handed over; that is a fact about the
   world and no bookkeeping failure un-does it.
2. **The commit is marked `failed`, not `verified`.** Nobody will mistake this for a sale.
3. **It is CRITICAL and it stopped retrying.** Retrying a released hold could never help, so
   it became a person's problem instead of a queue item.

The predicted failure from Phase 0 §14.2, reproduced deliberately and caught.

---

## 5. The full rider journey, live

Against real Inventory with real reserved stock.

```
onboard rider        RDR-012, one-time password, forced change
rider signs in       permissions [deliveries:execute, deliveries:respond, locations:read]
goes online          themselves
assign + accept
step                 -> PICKUP_PENDING
step                 -> PICKED_UP
step                 -> OUT_FOR_DELIVERY
step                 -> ARRIVED   "Ask the customer for their 6-digit code."

rider asks for the code   -> 403 forbidden, "rider does not hold deliveries:read"
support issues it         -> 145953
rider enters 000000       -> 422 otp_wrong, attempts_left 4
rider enters 145953       -> 200 DELIVERED

drain                     -> commit verified, ledger_ids [10]
```

**Isolation, checked live:**

```
rider GETs a delivery they do not hold  -> 404 "That task is not yours."
rider's own task list                   -> only theirs, and NO phone number in the payload
```

The phone is revealed only by `POST .../contact`, one task at a time, and every reveal writes
an audit row naming the rider.

**Screens:** `/me` and `/me/tasks/:id` render for a rider; a task they do not hold returns
"Not your job".

---

## 6. Three real defects found and fixed

### 6.1 The OTP revoke did nothing — PUBLIC still had EXECUTE

`mint_otp` returns the plaintext code. I revoked it from `authenticated` and checked:

```
mint_otp | {=X/postgres, postgres=X/postgres}
                ^^^^ PUBLIC still holds EXECUTE
```

**Postgres grants EXECUTE on every new function to PUBLIC by default**, so revoking from one
role leaves it wide open through the public grant. A rider calling `mint_otp` got *past* the
privilege check and failed on a foreign key — which looks like a refusal and is not one. On a
real delivery id it would have returned the customer's code to the rider, defeating the entire
proof.

**Fix:** `revoke ... from public` as well, applied to the queue internals too.
**Now:** `permission denied for function mint_otp`, ACL `{postgres=X/postgres}`.
**Test:** *"a rider cannot call mint_otp either"*.

### 6.2 The worker wrote to tables it had no business writing to

The drain crashed after successfully committing — the commit landed in Inventory and logistics
never recorded it. Two distinct failures in the same block:

| Write | What happened |
|---|---|
| `UPDATE delivery.delivery` | no UPDATE policy → **zero rows matched, reported success** |
| `INSERT delivery_exception` | no INSERT policy → WITH CHECK violation, crash |

The silent one is the dangerous half: `commit_status` would have stayed `pending` forever with
nothing to say why. Both are now one `delivery.record_commit_result()` definer function —
consistent with every other write in this codebase.

The rule held, by the way. `delivery.delivery` has no UPDATE policy *on purpose*: status moves
through `delivery.transition` and nowhere else. The code that ignored that broke.

**Test:** *"writing the commit result directly does NOT work"*, pinning both behaviours.

### 6.3 The operator view showed an empty queue while it was stuck

`outbound:drain --show` reported **0 events** while three commits sat in `SENDING`. It selected
from the queue table directly, under RLS, as a role holding no permissions.

Identical to the Phase 3 dry-run defect, in a new place. **This is now the third time** the
same shape has appeared: a definer function sees everything, a plain SELECT beside it sees
nothing and says so confidently.

**Fix:** `integration.pending_outbound()`, a definer function, so the operator view and the
worker cannot disagree.
**Test:** *"the operator view agrees with the worker"*.

---

## 7. Known limitations

1. **Offline mode is Phase 4b.** The rider app assumes a connection.
2. **The OTP is relayed by hand.** Support issues it and reads it out; Phase 5 delivers it to
   the customer properly.
3. **Photo proof stores a reference only.** No storage driver yet — `storage_ref` is recorded
   and nothing uploads. Q26 stands; OTP is the proof that counts in 4a.
4. **The phone number is not masked.** Revealed in full, audited. Q27/Q9 stand.
5. **No distance check at completion.** Q28 as agreed — a warning was not built either; it
   belongs with the location work in 4b.
6. **The failure screen is API-only.** `POST .../fail` works; the rider UI for it lands in 4b
   with the offline flows.
7. **Nothing schedules the drain.** `npm run outbound:drain -- --loop 5` runs continuously but
   is not wired to a scheduler. With Phase 3's assignment sweep, that is now **two** jobs
   waiting on Phase 7.
8. **Still synthetic orders.** Grocery PR #1 remains unmerged and its migration unrun.

---

## 8. Open questions

| # | Status |
|---|---|
| **Q4** | **This phase proves why it matters.** A lapsed hold now produces `INVENTORY_HOLD_LOST` — correct, and avoidable only by merging PR #1 so holds can be confirmed |
| **Q25** | **Resolved** — a trigger closes the assignment; `DELIVERY_FAILED` keeps it open. Verified including by direct status write |
| **Q10 / Q26 / Q27 / Q28** | Open as recorded in §7 |
| **Q21** | Navigation works to the customer, not the shop |
| **Q29** *(new)* | **Two background jobs now need scheduling** — the assignment sweep and the outbound drain. Until then an unanswered offer and an unsent commit both wait for somebody to run a command |

---

## 9. Definition of done

- [x] 177/177 tests; `npm run check` green
- [x] `db:verify` 11/11 across 24 tables
- [x] Typecheck and build clean
- [x] A rider can be onboarded, sign in, go online and complete a delivery
- [x] **A rider never sees the OTP** — refused at the route, the function and the grant
- [x] **Another rider cannot act on a delivery**, even holding the code
- [x] **The commit is verified, not believed** — proven against a released hold
- [x] A delivery completes regardless of Inventory's health
- [x] Location refused outside the carrying window
- [x] **Q25 closed by trigger**, proven by direct status write
- [x] **The first ledger entry in this estate's history** — `[10]`
- [x] No file in Grocery or Inventory modified

---

## 10. Result

# PASS

Phase 4a is complete. A rider does the job, proves the handover, and the sale reaches
Inventory's ledger — verified rather than assumed.

Next is **4b**: the offline outbox, and the conflict handling for a completion that arrives an
hour late.
