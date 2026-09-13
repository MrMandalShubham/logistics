# Phase 6 — Exceptions, Reschedules and Returns · Analysis

**Date:** 2026-09-13 · **Status:** proposed, **awaiting approval before any code is written**
**Owner:** Lead Agent
**Depends on:** [Phase 5 verification](phase-5-verification.md) ·
[Integration contract](../02-integration-contract.md) · [Open questions](../03-open-questions.md)

---

## 0. What the last five phases have quietly accumulated

Three things are raised by the system today and resolved by nothing:

```
delivery.delivery_exception        rows raised by Phase 4a and 4b. Nothing closes them.
integration.open_conflicts()       lists conflicts. Nothing resolves them. (Q30)
delivery.allowed_next('RETURN_REQUIRED') -> ['RETURN_IN_TRANSIT']
                                   a path in the state machine that nothing walks.
```

The comment in `0008_execution.sql` says it outright: `-- Phase 6 completes the return.`

This phase is not new capability. It is finishing the paths the earlier phases deliberately
left open, and building the one screen a dispatcher needs to do their job when something goes
wrong.

---

## 1. Objective

When a delivery does not go to plan — the rider could not hand it over, two accounts of the
same doorstep disagree, the customer cancelled while the parcel was moving — **a named person
decides what happens, the decision is recorded, and both the customer and the inventory ledger
end up telling the truth.**

---

## 2. The finding: nothing ever releases stock

Phase 4a's discovery was that the estate reserved stock and never committed it. Phase 6's is
the mirror.

```
$ grep -rn "inventory.release\|releaseInventory" --include=*.ts --include=*.sql .
lib/inventory.ts:15:  * commitInventory, releaseInventory and orderStatus and calls none of
```

A comment. Nothing else. `POST /api/v1/deliveries/[id]/cancel` transitions the delivery and
tells Inventory nothing; `RETURNED` does the same.

### How bad is it, stated accurately

Not as bad as it sounds, and worth saying so rather than dramatising it:

- Stock is **not** lost. Nothing was ever committed, so Inventory's count was never reduced,
  and the hold expires by itself after 30 minutes.
- What is missing is the **record**. Inventory is never told the outcome, so its order status
  for a returned parcel stays whatever it was, and there is no ledger entry saying goods came
  back.
- Within the 30-minute window, a cancellation holds stock that could be sold.

### The part that is genuinely wrong

`delivery.hold_confirmed` has been `false` since Phase 2, because **Q4** — confirming a hold —
is still open. So every hold this system takes in expires regardless. The reserve is currently
decorative, and the release would be too until Q4 is answered.

**I propose building the release anyway**, because the ledger record is worth having on its
own, and because the day Q4 is answered the release has to exist or a confirmed hold will
never be given back. But I will not claim it closes a loop that Q4 keeps open.

---

## 3. Scope

| # | Deliverable |
|---|---|
| 6.1 | `0011_exceptions.sql` — resolution on `delivery_exception`, the return path, `release` enqueue |
| 6.2 | **Conflict resolution (Q30)** — accept, discard or reconcile, by a named person, recorded |
| 6.3 | **The return workflow** — `RETURN_REQUIRED → RETURN_IN_TRANSIT → RETURNED`, driven by the rider app |
| 6.4 | **`inventory.release`** in `lib/outbound.ts`, with the same verify-after-write discipline as the commit |
| 6.5 | **Reschedule** — `RESCHEDULE_REQUIRED → READY_FOR_ASSIGNMENT`, and what happens to the assignment |
| 6.6 | `/exceptions` — the dispatcher's work queue: what is open, how old, whose it is |
| 6.7 | Rider screens for "I still have the parcel" and "I have brought it back" |
| 6.8 | `tests/phase6.test.mjs` (~35) |

### Out of scope

- **Proof photos (Q11).** Still no storage driver. A separate, self-contained piece of work.
- **Retention (Q12).** Phase 7, and it needs the privacy policy.
- **Automatic reassignment on decline or timeout (Q13).** The defaults are written down; the
  scheduler that would enforce them is Q29, below.
- **Hub returns (Q14).** Returns go to the originating shop.
- **Answering Q4.** Confirming a hold is an Inventory conversation, not a logistics build.

---

## 4. The decisions I need from you

### 4.1 What happens to a disputed proof

`PROOF_DISPUTED` is raised when a rider completes a delivery offline with a code the server
then rejects. Today the delivery stays `ARRIVED` and a human is told. That is correct and it
is also an unfinished sentence — somebody must eventually say what happened.

| | Outcome | Notes |
|---|---|---|
| **A** *(recommended)* | A dispatcher decides: `DELIVERED` or `DELIVERY_FAILED`, with a mandatory note | The parcel is gone either way. Only a person who can ring both parties can resolve it |
| B | Auto-`DELIVERED` after 24 h with no dispute | Optimistic. Quietly converts "we do not know" into "it arrived" |
| C | Auto-`DELIVERY_FAILED` | Pessimistic, and unfair to a rider who did the job with a customer who misread a digit |

**A.** It is slower, and it is the only one that does not invent a fact.

### 4.2 Who may resolve a conflict

| | Approach |
|---|---|
| **A** *(recommended)* | Dispatcher **and** admin. It is operational work and it happens during a shift |
| B | Admin only. Safer, and means nothing gets resolved at 9pm on a Saturday |

Whichever: the resolver's id, the reason and the timestamp are recorded, and
`delivery_exception` stays append-only in spirit — resolving sets `resolved_at` and
`resolution`, it does not delete the row.

### 4.3 Reschedule — same rider, or back to the pool?

| | Approach |
|---|---|
| **A** *(recommended)* | Back to the pool. `RESCHEDULE_REQUIRED → READY_FOR_ASSIGNMENT` closes the assignment; dispatch assigns afresh, possibly to the same person |
| B | Keep the rider. Saves a hand-off, and strands the parcel if they go off shift |

**A**, with one consequence stated plainly: **the rider is still physically holding the
parcel.** "Back to the pool" means the next assignment must tell the new rider to collect it
from whoever has it, not from the shop. I propose recording the parcel's holder on the
delivery so the pickup instruction is accurate rather than assumed.

### 4.4 When does `release` fire?

**On `RETURNED`, not on `RETURN_REQUIRED`.** Telling Inventory stock is available while the
parcel is in a rider's bag would put something on the shelf that is not there. `RETURNED`
means a person confirmed it came back.

Same discipline as the commit: send, then **read `GET /api/inventory/order/:id` and check**.
Inventory's endpoints report success for states that are not the state you asked for, and
Phase 4a already proved it once.

---

## 5. Security

| # | Risk | Mitigation |
|---|---|---|
| P6-01 | A rider resolves their own conflict | Resolution needs `exceptions:resolve`, which no rider role has. Enforced in the function, not the screen |
| P6-02 | A disputed proof resolved to `DELIVERED` with no trace | Resolver id, reason and note are mandatory and audited; the exception row keeps the original account |
| P6-03 | A release sent for a parcel still in a bag | §4.4 — `RETURNED` only, and `RETURNED` requires a person |
| P6-04 | Release reported successful for stock that never came back | Verify-after-write, as with the commit. A mismatch is `INVENTORY_RELEASE_UNVERIFIED`, CRITICAL |
| P6-05 | Resolution used to rewrite history | `delivery_status_history` stays insert-only. A resolution adds a transition; it never edits one |
| P6-06 | A returned parcel's customer left on "on its way" | `RETURNED` maps to `CANCELLED` for the customer (C-02) and Phase 5 sends it |

---

## 6. Tests (~35)

**The return path (7)** — the full walk; a return closes the assignment; `release` is enqueued
at `RETURNED` and **not** at `RETURN_REQUIRED`; an unverified release raises CRITICAL; a
release for a hold that already expired is a success, not an error; returns go to the
originating shop; a rider cannot skip to `RETURNED`.

**Conflict resolution (8)** — each of accept / discard / reconcile; a rider is refused; the
resolver is recorded; resolving twice is a no-op not a second transition; an unresolved
conflict stays listed; the original account survives resolution.

**Disputed proof (5)** — resolved to `DELIVERED` enqueues the commit; resolved to
`DELIVERY_FAILED` does not; a note is mandatory; the customer is told either way; the code
is still never sent.

**Reschedule (5)** — the assignment closes; the parcel's holder is recorded; the new
assignment names where to collect it; the customer is told; a reschedule after a return is
refused.

**Exception queue (5)** — open items listed oldest first; a dispatcher sees only their
locations; resolving removes it; counts match the health screen; a CRITICAL is distinguishable.

**Cancellation (5)** — cancelling before pickup enqueues a release; cancelling after pickup
requires a return instead; `DELIVERED_AFTER_CANCEL` still raises; the customer is told; a
cancelled delivery cannot be rescheduled.

---

## 7. Verification

The scenario worth proving end to end, because it is the one that has no happy path:

```
rider arrives -> nobody home -> DELIVERY_FAILED
dispatcher decides: return
rider carries it back -> RETURN_IN_TRANSIT -> RETURNED
  -> Inventory told, and the telling verified
  -> customer's order page says cancelled, with the real reason
  -> the exception closes, with a name against it
```

Plus the Phase 4b conflict — rider one in a basement, rider two given the job — followed
through to a person actually deciding, which is the half Phase 4b deliberately left out.

> As with Phase 5, the customer-facing half verifies against the stub receiver unless
> **Grocery PR #1 and #2 are merged and migration 002 is run.** Those are now both open PRs.

---

## 8. Open questions

| # | Status |
|---|---|
| **Q30** | Answered by this phase — §4.1, §4.2 |
| **Q4** | **Still open, and now load-bearing.** Until a hold can be confirmed, every reserve expires and both commit and release are records rather than controls. An Inventory conversation |
| **Q29** | **Now three unscheduled jobs**: assignment expiry, outbound drain, and hold expiry. None runs on a timer. I propose Phase 7 owns this rather than adding a fourth |
| **Q11 / Q12** | Open — proof storage and retention |
| **Q13** | Defaults written; enforcement waits on Q29 |
| **Q14** | Taking the default: returns go to the originating shop |

---

## Approval requested

1. **§4.1** — a disputed proof is resolved by a person, not a timer. I recommend **A**.
2. **§4.2** — dispatcher **and** admin may resolve. I recommend **A**.
3. **§4.3** — a reschedule returns the job to the pool, and the delivery records **who is
   holding the parcel** so the next rider is told where to collect it.
4. **§4.4** — `release` fires on `RETURNED` only, and is verified by a read.
5. **§2** — that I build the release **knowing Q4 keeps the loop open**, for the ledger record
   and so it exists when Q4 is answered.
6. That **proof photos (Q11) and the scheduler (Q29) stay out**, and Phase 7 takes the
   scheduler.
