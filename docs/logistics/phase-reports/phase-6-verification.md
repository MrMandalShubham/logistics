# Phase 6 — Exceptions, Reschedules and Returns · Verification

**Date:** 2026-09-13 · **Status:** **PASS** · **Owner:** Lead Agent
**Analysis:** [`phase-6-analysis.md`](phase-6-analysis.md)

---

## 1. Commands

| Command | Result |
|---|---|
| `npm run db:reset` | **11** migrations from empty |
| `npm run db:verify` | **11/11** |
| `npm test` | **279 tests, 279 pass, 0 fail** |
| `npx tsc --noEmit` | clean |
| `npm run build` | PASS — 46 routes, `/exceptions` added |
| `npm run live:phase6` | the full return, against a **real Inventory reservation** |

```
ℹ tests 279        (241 from Phases 1–5, 38 added)
ℹ pass 279
ℹ fail 0
```

| Suite | Covers |
|---|---|
| the return (7) | dispatcher orders it and the rider walks it back; **release fires at `RETURNED` and not before**; a rider cannot skip to `RETURNED`; the assignment closes; the parcel's holder is tracked and cleared; an unverified release raises CRITICAL; the release dedupes by order |
| reschedule (5) | the job returns to the pool and **the parcel does not**; it passes through `RESCHEDULE_REQUIRED` so the timeline shows the decision; the old assignment closes; a rider cannot reschedule their own failure; a returned delivery cannot be rescheduled |
| resolving (6) | a resolution keeps the original account; resolving twice keeps the first reason; a rider is refused; a code is required; CRITICAL first then oldest; the queue is not blind |
| conflicts (10) | ACCEPT, DISCARD, RECONCILE; **a conflict with no exception row can still be resolved**; resolving twice keeps the first decision; an illegal transition is still refused; a note is mandatory; a rider cannot decide; both accounts are audited |
| a disputed proof (6) | `DELIVERED` queues the commit; `DELIVERY_FAILED` does not; the proof is an **OVERRIDE, never an OTP**; a note is mandatory; two outcomes only; the exception closes with the decision |
| the rest of the estate (4) | a return tells the customer with the real reason alongside; the return leg is ranked so a duplicate offline step is a NOOP; every return status is ranked; **a rider's position is still not recorded on the way back** |

---

## 2. Live: the journey with no happy path

Unlike every earlier live check, this one uses a **real Inventory reservation**, so the release
at the end is verified against stock that actually moved rather than against a 404.

```
order ORD-P6-a6b921b8
  reserved 2 x PRD-FIXTURE-A at SH1 -> inventory says "held"

dispatcher admits it                   READY_FOR_ASSIGNMENT
assigns Asha, Asha accepts             ACCEPTED
Asha taps PICKUP_PENDING               PICKUP_PENDING
Asha taps PICKED_UP                    PICKED_UP
Asha taps OUT_FOR_DELIVERY             OUT_FOR_DELIVERY
Asha taps ARRIVED                      ARRIVED
nobody home                            DELIVERY_FAILED
   the parcel is with Asha Menon, and the assignment is still theirs

dispatcher decides: bring it back to SH1
   releases queued so far: 0 (the parcel is still in a bag)

Asha taps RETURN_IN_TRANSIT            RETURN_IN_TRANSIT
Asha hands it back at SH1              RETURNED
   release verified

── Inventory ──
   before: "held"   after: "released"
   logistics records the release as: verified
```

The customer, through the stub receiver:

```
PAID       packed            We have your order and it is being packed.
SHIPPED    out_for_delivery  Your order is on its way.
SHIPPED    out_for_delivery  We could not reach you at the address. We will try again.
CANCELLED  -                 Your order has been returned to the shop.
```

And the record it leaves:

```
CUSTOMER_UNREACHABLE: "rang twice, no answer"
  -> RETURNED_TO_SHOP by Dispatcher: "customer moved; parcel back on the shelf at SH1"

open exceptions remaining: 0
```

Reproduce with `npm run grocery:stub` and `npm run live:phase6`.

> One wording wrinkle worth owning: the third message says "We will try again", which was true
> when it was sent and was then overtaken by the decision to return. The final message corrects
> it. Making the failure message conditional on a decision nobody has made yet would mean
> delaying the one event customers most want, so I have left it.

### The other release case, probed live

While Q4 keeps holds unconfirmable, most holds lapse on their own and Inventory has nothing
left to release. Verified directly:

```
POST /api/inventory/release  ORD-NEVER-EXISTED   ->  404 no_such_order
GET  /api/inventory/order/…  ORD-NEVER-EXISTED   ->  404 not_found
```

`getOrderHold` maps a 404 to `released`, and the handler treats a 404 from release as
"nothing to give back" rather than a failure — so the verification passes and the queue does
not accumulate dead letters for the ordinary case.

---

## 3. Two bugs found, one of them mine from Phase 5

### A dead Grocery status was being recorded as a failed commit

```ts
// before
if (job.delivery_id) {
  await db.query("select delivery.record_commit_result($1,'failed',…)");
}
```

Before Phase 5 every queued job was a commit, so any dead job with a delivery was a stock
discrepancy. Since Phase 5 that is false. A dead status push — Grocery down for six attempts —
would have set `commit_status = 'failed'` and raised `COMMIT_FAILED` against a sale that went
through perfectly well, sending somebody to reconcile a ledger that was correct.

Phase 5's own test did not catch it because it marked the row DEAD with direct SQL, bypassing
the worker. Now branched on `job.event`.

### A whole class of conflict could never be marked resolved

`open_conflicts()` decided whether a conflict was resolved by looking for a **resolved
exception with a matching code**. But 0009 only raises an exception for three conflict codes.
The commonest — `ILLEGAL_TRANSITION`, from the generic handler — raises none, so those
conflicts could be decided by a dispatcher and would still be listed as outstanding. Forever.

A queue that will not empty is a queue people stop reading, which would have quietly undone
the whole point of Phase 4b surfacing conflicts at all.

The conflict is a property of the rider event, so its resolution now lives there too
(`resolved_at`, `resolved_by`, `resolution_code`, `resolution`), and a matching exception is
still closed when one exists. Two tests pin it — one constructs an `ILLEGAL_TRANSITION`
conflict and asserts no exception row exists before resolving it.

---

## 4. Decisions, as built

### §4.1 — a disputed proof is decided by a person

`resolve_disputed_proof` takes `DELIVERED` or `DELIVERY_FAILED` and a **mandatory** note.
`DELIVERED` enqueues the commit exactly as a normal completion does, or the sale would never
reach Inventory's ledger.

The proof is recorded as **`OVERRIDE`**, not `OTP`. Writing a dispatcher's decision into the
one table whose job is to say what happened at a door, labelled as a verified code, would be a
lie in the worst possible place. 0008's `type` CHECK was widened for it and a `note` column
added, which 0008 had already anticipated.

### §4.2 — dispatcher and admin

`exceptions:resolve`, checked inside the functions rather than on the screen. A rider is
refused even for a conflict they are party to.

### §4.3 — the job goes back to the pool, the parcel does not

`delivery.reschedule` returns `parcel_with_rider_id`, and the server action says it out loud:

> Back in the queue. The parcel is still with the previous rider — the next assignment says to
> collect it from them, not from the shop.

It also closes the previous assignment explicitly, because `READY_FOR_ASSIGNMENT` is not
terminal and 0008's trigger therefore does not. Left open, the rider would sit at capacity for
a job that is no longer theirs.

### §4.4 — release on `RETURNED`, verified by a read

Proven in both directions: zero releases queued at `RETURN_REQUIRED` and at
`RETURN_IN_TRANSIT`, one at `RETURNED`. `delivered` coming back from the verification read is
fatal — `INVENTORY_RELEASE_UNVERIFIED`, CRITICAL — because a release cannot undo a ledger
entry and a parcel on a shelf the ledger has sold is a discrepancy somebody has to count.

---

## 5. Things that turned out to matter

### The return leg had to be ranked

`status_rank()` stopped at `DELIVERED`, which was right when nothing walked the return path.
`apply_rider_event` uses that rank to recognise "you have already passed this step" and answer
NOOP. With a NULL rank the check is skipped, the transition is attempted, it fails because
`RETURN_IN_TRANSIT` cannot become itself — and a duplicate from a flaky connection is reported
to a dispatcher as a **conflict**.

A conflict is two people disagreeing. A phone sending the same thing twice is not that, and
calling it that is how a queue becomes noise.

### The rider is not tracked on the way back

`fleet.record_location` still accepts a position only between `PICKED_UP` and `ARRIVED`, and
`isCarrying` in TypeScript still agrees. Widening it to the return leg would have been a
one-line change and an easy one to justify — the rider is, after all, still carrying a parcel.
Walking back to the shop you work from is not an occasion to track a named worker, and the
test says so.

### No failure buttons on the way back

A return cannot fail. Offering "nobody answered" to a rider walking to the shop they collected
from would be nonsense, so the failure section is hidden for the two return states and the
task screen re-labels the destination.

---

## 6. What is still not true

1. **Q4 keeps the loop open.** `hold_confirmed` has been `false` since Phase 2, so every hold
   expires regardless and both commit and release remain records rather than controls. The
   release is worth having for the ledger entry and so it exists the day Q4 is answered — but
   it does not close a loop Q4 holds open. An Inventory conversation, not a logistics build.
2. **Three unscheduled jobs** (Q29): assignment expiry, outbound drain, hold expiry. All are
   manual `npm run` commands. Phase 7 should own this rather than a fourth being bolted on.
3. **No proof photos** (Q11) — still no storage driver.
4. **Retention** (Q12) is Phase 7 and needs the privacy policy.
5. **Automatic reassignment on decline or timeout** (Q13) — defaults written, enforcement waits
   on Q29.
6. **Still verified against a stub for the customer half.** Grocery
   [PR #1](https://github.com/MrMandalShubham/Grocery/pull/1) and
   [PR #2](https://github.com/MrMandalShubham/Grocery/pull/2) are both open. Migration 001 is
   applied; 002 is not.
7. **Hub returns are V2** (Q14). Returns go to the originating shop.

---

## 7. Definition of done

- [x] 279/279 tests; `npm run check` green
- [x] `db:verify` 11/11; typecheck and build clean
- [x] Every resolution records **who, why, and what the original account said**
- [x] A conflict can be decided — including the class that raises no exception row
- [x] A disputed proof is decided by a person, and recorded as an override not a code
- [x] `release` fires at `RETURNED` only, and is **verified by a read**
- [x] Proven live against a real Inventory hold: `held` → `released`
- [x] A rescheduled job returns to the pool; the parcel's holder is recorded and surfaced
- [x] A duplicate offline return step is a NOOP, not a false conflict
- [x] A rider's position is still not recorded on the way back
- [x] No Grocery or Inventory file changed

---

## 8. Result

# PASS

The unhappy paths are finished. A parcel that could not be handed over goes back to the shop it
came from, Inventory is told and the telling is checked, the customer learns what happened, and
every decision along the way has a person's name and their reason against it.

Two of the three things this system had been accumulating since Phase 4 — unresolvable
exceptions and undecidable conflicts — are closed. The third, the return path that nothing
walked, is walked.

Next is **Phase 7**: the scheduler that Q29 has been deferring, retention, and operational
reports.
