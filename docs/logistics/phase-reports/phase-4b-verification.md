# Phase 4b — Offline Rider App · Verification

**Date:** 2026-09-12 · **Status:** **PASS** · **Owner:** Lead Agent
**Analysis:** [`phase-4b-analysis.md`](phase-4b-analysis.md)

---

## 1. Commands

| Command | Result |
|---|---|
| `npm run db:reset` | 9 migrations from empty |
| `npm run db:verify` | **11/11** |
| `npm test` | **211 tests, 211 pass, 0 fail** |
| `npm run check` | **PASS** |
| `npx tsc --noEmit` | clean |
| `npm run build` | PASS |
| Live HTTP | out-of-order replay, offline completion, replay, conflict |

```
ℹ tests 211        (177 from Phases 1–4a, 34 added)
ℹ pass 211
ℹ fail 0
```

| Suite | Covers |
|---|---|
| outbox — ordering (3) | capture order beats queue order, sequence breaks ties, dedupe |
| outbox — retry & staleness (4) | backoff grows and is capped, stale window, offline plans nothing, batch cap |
| outbox — folding results (6) | APPLIED and NOOP leave, **an unanswered event stays**, conflicts leave but are surfaced, partial responses, awaiting-sync flag |
| sync — idempotency (2) | same event twice applies once, replay returns the original outcome |
| sync — ordering (2) | an already-passed step is a **no-op not an error**, a shuffled journey replays correctly |
| sync — offline completion (5) | good code applies with **capture-time `delivered_at`**, bad code raises `PROOF_DISPUTED`, commit enqueues, backdated and future clocks both clamped |
| sync — conflicts (7) | C1 reassigned, C2 already failed, C3 cancelled, C7 second device, C8 stale, illegal transition, out-of-window location |
| sync — ownership (3) | another rider **rejected not conflicted**, non-rider refused, unknown delivery refused |
| conflicts are visible (2) | `open_conflicts()` lists them, a rider sees only their own events |

---

## 2. Live: a rider does the whole job with no signal

The queue was drained badly on purpose, so the events arrived in the wrong order:

```
sent as:     ARRIVED, PICKUP_PENDING, OUT_FOR_DELIVERY, PICKED_UP
applied as:  PICKUP_PENDING -> PICKED_UP -> OUT_FOR_DELIVERY -> ARRIVED
summary:     { received: 4, applied: 4, noop: 0, conflicts: 0, rejected: 0 }
delivery is now: ARRIVED
```

Replaying them as they *happened* rather than as they *arrived* is what keeps the server's
state machine agreeing with the world.

### The completion, captured 45 minutes before it was reported

```
captured_at   2026-09-12T15:45:26.484948Z
delivered_at  2026-09-12 15:45:26.484948+00      <- the same instant
status        DELIVERED
commit_status pending
```

Recorded when the rider delivered it, not when the phone found signal. Every duration and SLA
figure would otherwise be wrong by however long the rider was out of contact.

Sending the identical event again — the flaky-connection case — returned `APPLIED` with
`replayed: true`, and no second row.

---

## 3. Live: the conflict that matters

The sequence that made this phase worth splitting out:

```
1. rider one accepts, then goes into a basement
2. dispatch hears nothing and gives the job to rider two
3. rider one surfaces and syncs
```

What rider one was told:

> **This delivery was given to somebody else while you were offline. Dispatch has been told —
> do not hand it over again.**

What it produced:

```
status         CONFLICT
conflict_code  ASSIGNMENT_SUPERSEDED

delivery_exception:  ASSIGNMENT_SUPERSEDED  CRITICAL
  "Rider reported "step" at 16:30:42, but the assignment was superseded."

open_conflicts():
  DLV-2026-000110  RDR-003  step  ASSIGNMENT_SUPERSEDED
```

Nothing was silently applied. Nothing was silently discarded. Both accounts of the doorstep
survive, and a person decides — which is the whole rule of this phase.

---

## 4. Design decisions that held up

### The OTP was not weakened

The code travels in the outbox and is verified on the server by the **same `verify_otp`** every
online delivery goes through. Shipping the hash to the device — the obvious way to make
completion work offline — would have turned a six-digit code into a few seconds of offline
brute force, handing the rider exactly what Phase 4a withholds.

A bad code raises `PROOF_DISPUTED`, leaves the delivery `ARRIVED`, and tells a person. The
parcel is gone either way; whether the proof was good is not a decision for a queue.

### "Waiting to sync", never "delivered"

The rider's screen reports what the *server* knows. Telling somebody their delivery is done
before it has been accepted would send them away believing something that may later be
disputed — when they are the one person who could still sort it out.

### The device clock is a claim, not evidence

`captured_at` is clamped between the assignment and now. Verified live in both directions:
a 2020 timestamp and a tomorrow timestamp both landed in the plausible window. Unclamped, a
delivery could be backdated into an SLA.

### The testable core

Ordering, dedupe, backoff, staleness and result-folding are pure functions over plain objects,
tested with everything else. What is left untested is a thin IndexedDB adapter and a cache
policy — a deliberate shrinking of the untested surface rather than an accident.

The rule that fell out of it, and the one I would keep above all others:

> **An unanswered event stays in the outbox.** A dropped event is a delivery nobody can account
> for; a duplicate is a wasted request the server already knows how to ignore.

---

## 5. Two scenarios I had to correct, not the code

Both failures in the first run were my test setup, and both taught something:

1. **`delivered_at` clamping.** I captured 45 minutes ago on an assignment created seconds
   earlier, and the clamp correctly pushed it forward. A real 45-minute-old delivery was
   assigned more than 45 minutes ago; the test now backdates the assignment.
2. **`ARRIVED → CANCELLED` is not a legal transition.** Once a rider has the parcel in their
   bag, the way out is a **return**, not a cancellation. So the C3 test now cancels from
   `ACCEPTED`, which is both legal and the realistic sequence: rider accepts, goes offline,
   does the job, and meanwhile the customer rings to cancel.

The second is worth noting as a design confirmation rather than a fix: the state machine
already refused something that would have been wrong.

---

## 6. Known limitations

1. **Photos are still out.** No storage driver (Q26), so there is nothing to upload to.
2. **No background sync.** The app syncs when opened, when connectivity returns, on visibility
   change, and every 30 seconds while open. The service worker's `sync` event is uneven across
   browsers, and relying on it would mean a rider discovering hours later that their completion
   never left the phone.
3. **Conflicts are surfaced, not resolved.** `open_conflicts()` lists them and the exception is
   CRITICAL, but forcing, discarding or reconciling one is Phase 6 (Q30, as agreed).
4. **The service worker caches the shell only**, not task data. Task data is personal and
   belongs to the IndexedDB side where sign-out can clear it — but that also means a
   cold-started app with no signal shows the offline page rather than yesterday's jobs.
5. **`store.clear()` exists but sign-out does not call it.** A rider signing out on a shared
   phone should wipe the outbox. **This is a real gap and should be closed early in Phase 5.**
6. **No live browser test of the service worker.** Verified by reasoning and by the pure tests;
   the devtools offline-toggle pass in §10 of the analysis has not been run.
7. **Still synthetic orders.** Grocery PR #1 unmerged.

---

## 7. Open questions

| # | Status |
|---|---|
| **Q30** | Open as agreed — conflicts raised and visible; resolution is Phase 6 |
| **Q31** | **Resolved** — 24 hours, applied but flagged `STALE_SYNC` |
| **Q26 / Q27 / Q28** | Open |
| **Q29** | Still two unscheduled jobs |
| **Q32** *(new)* | **Sign-out must clear the outbox** (§6.5). Small, and it is customer addresses on a phone |

---

## 8. Definition of done

- [x] 211/211 tests; `npm run check` green
- [x] `db:verify` 11/11; typecheck and build clean
- [x] A rider can work with no signal and lose nothing
- [x] Events replay in **capture** order, proven with a shuffled batch
- [x] **`delivered_at` is the capture time**, proven live
- [x] A device clock is clamped in both directions
- [x] **The OTP is verified on the server, unchanged**
- [x] A bad code raises `PROOF_DISPUTED` and does not deliver
- [x] **Every conflict reaches a human** — proven with a live reassignment race
- [x] An unanswered event is never dropped
- [x] A rider sees only their own synced events
- [x] No file in Grocery or Inventory modified

---

## 9. Result

# PASS

Phase 4 is complete, both halves. A rider can do the job online or offline, the proof holds
either way, and when two accounts of the same doorstep disagree, a person is told rather than
a row being quietly overwritten.

Next is **Phase 5**: telling the customer. The outbound queue built in 4a already has Grocery
as a declared target and is waiting for a receiver — which is **Q3**.
