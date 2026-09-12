# Phase 5 — Customer Status Integration · Analysis

**Date:** 2026-09-12 · **Status:** proposed, **awaiting approval before any code is written**
**Owner:** Lead Agent
**Depends on:** [Phase 4b verification](phase-4b-verification.md) ·
[Integration contract](../02-integration-contract.md)

---

## 0. What is already built, and what is missing

The outbound queue went in with Phase 4a and already declares `GROCERY` as a target. Ask it to
send something there today and it answers:

```ts
if (job.target === "GROCERY") {
  return { ok: false, error: "the Grocery receiver arrives in Phase 5" };
}
```

So the machinery — dedupe, backoff, dead-lettering, crash recovery — exists and is tested. What
is missing is a receiver, and **Grocery has no HTTP API at all.**

That is the whole of this phase: something to send, somewhere to send it, and a customer who
can finally see where their order is.

---

## 1. Objective

A customer watching their order sees it move: packed, out for delivery, arriving, delivered —
and sees a real reason when it does not.

---

## 2. This phase needs a second Grocery change

PR #1 made Grocery *send*. Nothing makes it *receive*. Three additive changes:

| # | Change | Why |
|---|---|---|
| 5.G1 | `POST /api/logistics/status` — signed, idempotent | Grocery has no API; there is nowhere to deliver a status |
| 5.G2 | Replace the ternary at `services/orders.ts:54` | It maps every non-`PAID` status to **"Delivered"**. Accurate statuses would land in a UI that cannot render them |
| 5.G3 | Show the delivery code on the order page | §4 |

**5.G2 is the one to notice.** Today:

```ts
status: o.status === "PAID" ? "placed" : "delivered"
```

Logistics could publish perfectly accurate statuses into that and a customer would see
"Delivered" while a rider was still on a bicycle. **Phase 5 is pointless without it.**

I propose **Grocery PR #2** carrying all three, written the same way as PR #1 — reviewed by
you, merged by you.

---

## 3. What gets sent, and when

One event type, `delivery.status_changed`, as the contract specifies. One subscription for
Grocery to implement rather than fourteen.

### Only when the customer's view actually changes

Logistics has fifteen statuses; Grocery has six and the pipeline has four. Several logistics
transitions map to the *same* customer-visible state:

```
RECEIVED, READY_FOR_ASSIGNMENT, ASSIGNED, ACCEPTED, PICKUP_PENDING
        -> all still "PAID" / packed
```

Sending five events that say the same thing is noise that costs retries and hides the ones that
matter. **So an event is enqueued only when the mapped `(external_status, pipeline_step)` pair
differs from the last pair sent** — a small piece of state on the delivery, checked at enqueue.

| Logistics | Grocery `orders.status` | pipeline | notify |
|---|---|---|:--:|
| RECEIVED → PICKUP_PENDING | `PAID` | `placed` → `packed` | one event |
| PICKED_UP, OUT_FOR_DELIVERY, ARRIVED | `SHIPPED` | `out_for_delivery` | one event |
| DELIVERED | `DELIVERED` | `delivered` | yes |
| DELIVERY_FAILED, RESCHEDULE_REQUIRED | `SHIPPED` | `out_for_delivery` | yes, with a reason |
| RETURNED | `CANCELLED` ⚠ | — | yes |
| CANCELLED | `CANCELLED` | — | yes |

> ⚠ **C-02 again.** Grocery's `orders.status` CHECK has no `RETURNED`, so a completed return
> collapses to `CANCELLED`. The true reason travels in `reason_code` and stays accurate in the
> logistics timeline. Widening Grocery's CHECK is a V2 conversation, not a Phase 5 one.

`ARRIVED` is worth its own pipeline step one day. It does not get one now, because adding a
fifth step to `OrderPipeline` is a Grocery UI change and this phase already asks for three.

---

## 4. The decision I want your view on: the OTP

Q10 has been open since Phase 0. The code is generated at `ARRIVED`, and support currently
reads it down the phone. Phase 5 is the first moment logistics can reach the customer.

| | Approach | Notes |
|---|---|---|
| **A** *(recommended)* | The `ARRIVED` event carries the code; Grocery shows it on the order page and clears it once delivered | The customer is already looking at that page. No provider, no cost, no new channel |
| B | Keep the manual relay | Works, does not scale past a handful of deliveries a day |
| C | SMS | No provider exists anywhere in this estate. A real option, and a procurement decision rather than a build one |

**What A costs, stated plainly:** the plaintext code lives briefly in Grocery's database. That
is the same exposure as sending it by SMS or email, and Grocery already holds the customer's
address and phone. Mitigations: sent only at `ARRIVED`, short TTL, **cleared on delivery**,
never logged, and the code rotates if support re-issues it.

**What A does not change:** the rider still never sees it. That rule is untouched.

---

## 5. Notifications

The brief asks for "notification integration". There is **no email or SMS provider anywhere in
this estate**, so I will not pretend to one.

What Phase 5 builds:

- `ops.notification` — what was sent, to whom, on what channel, with what outcome.
- A **`customer_app` channel** that is real: pushing the status to Grocery *is* the
  notification, and it is recorded as one.
- A **`log` driver** for email/SMS that records intent and sends nothing.

When a provider is chosen, it becomes a driver behind an interface that already has a caller
and a table of records. Building a fake email sender now would be inventing a feature nobody
asked for and nobody could test.

---

## 6. Scope

| # | Deliverable |
|---|---|
| 6.1 | `0010_customer_status.sql` — mapping function, change detection, `ops.notification` |
| 6.2 | Enqueue a `GROCERY` event on every transition that changes the customer's view |
| 6.3 | The `GROCERY` handler in `lib/outbound.ts` — signed, idempotent, retried |
| 6.4 | OTP carried on `ARRIVED`, cleared on `DELIVERED` (pending §4) |
| 6.5 | Notification records |
| 6.6 | Admin: outbound health — what is queued, retrying, dead |
| 6.7 | **Grocery PR #2** — receiver, pipeline mapping, code display |
| 6.8 | `tests/phase5.test.mjs` |
| 6.9 | **Q32 from 4b: sign-out clears the outbox.** Small, overdue, customer addresses on a phone |

### Out of scope

- Widening Grocery's `orders.status` CHECK (C-02).
- An `arriving` pipeline step in Grocery's UI.
- Email or SMS providers.
- Push notifications.
- Exceptions and returns workflow — Phase 6.

---

## 7. Security

| # | Risk | Mitigation |
|---|---|---|
| P5-01 | A forged status update to Grocery | HMAC over `t.body`, 300 s window — the same scheme in the same direction as PR #1's inbound |
| P5-02 | Replay of a captured status | `event_id` unique; Grocery ignores an event older than the status it holds |
| P5-03 | **Out-of-order arrival** marking a delivered order "out for delivery" | Every event carries `occurred_at`; the receiver compares before applying. At-least-once delivery guarantees nothing about order |
| P5-04 | **The OTP in Grocery's database** | §4 — short TTL, cleared on delivery, never logged, rotates on re-issue |
| P5-05 | Status leaking to the wrong customer | Grocery matches on `external_order_id` and its own RLS. Logistics never names a customer in the payload |
| P5-06 | A dead-lettered status leaving a customer stale forever | Surfaced on the admin health screen and replayable, exactly like inbound |

---

## 8. Tests (~30)

**Mapping (6)** — every logistics status maps to a legal Grocery status and pipeline step;
`RETURNED → CANCELLED` is explicit; the mapping table and the SQL agree.

**Change detection (5)** — five internal transitions produce **one** event; `PICKED_UP` and
`OUT_FOR_DELIVERY` produce one between them; `DELIVERED` always produces one; a repeated
transition does not.

**Sending (6)** — signed correctly; retried on 5xx; dead after six attempts; a 4xx is fatal;
dedupe by `event_id`; a Grocery outage does not affect deliveries.

**Ordering (3)** — events carry `occurred_at`; a stale event is identified; the receiver's
comparison logic is a pure function and is tested as one.

**OTP (4)** — carried on `ARRIVED` only; cleared on `DELIVERED`; never in a log line; a
re-issue supersedes what was sent.

**Notifications (3)** — a record per attempt; the log driver sends nothing; failures recorded.

**Q32 (2)** — sign-out clears the outbox; a cleared outbox holds no addresses.

---

## 9. Verification

The full estate, running together:

```
Grocery (PR #1 + #2) -> logistics -> Inventory
```

Place an order in Grocery, watch it appear in the logistics queue, assign it, walk a rider
through — and **watch the customer's order page change** at each step, ending with the code
appearing when the rider arrives and the order showing Delivered afterwards.

That run is the first time the three systems will have worked together end to end.

> **It needs Grocery's migration run and both PRs merged.** Everything since Phase 2 has been
> verified against synthetic orders; this is the phase where that stops being sufficient.

---

## 10. Open questions

| # | Question |
|---|---|
| **Q3** | **Now blocking.** Phase 5 cannot deliver anything without a receiver in Grocery |
| **Q10** | §4 — decide A, B or C |
| **Q33** *(new)* | **Who writes the customer-facing wording?** "Out for delivery" and "We could not reach you" are read by customers. Proposed: I draft plain, non-apologetic copy; you correct the tone |
| **Q34** *(new)* | **Should a customer see the rider's name and number?** The contract sketched first name plus a masked number. With no masking provider (Q9), proposed: **first name only, no number** — a customer who needs to talk to a rider rings support |
| **Q29** | Three unscheduled jobs after this phase |

---

## Approval requested

1. **A second Grocery PR** (§2), carrying the receiver, the pipeline fix, and the code display.
2. **§3** — one event type, sent only when the customer-visible state actually changes.
3. **§4** — which OTP option. I recommend **A**, and the exposure is stated plainly.
4. **§5** — notification records and a real `customer_app` channel; **no invented email/SMS**.
5. **Q34** — rider first name only, no phone number, until a masking provider exists.
6. **Q32 folded into this phase** — sign-out clears the outbox.
7. That the end-to-end verification in §9 **requires merging PR #1 and running its migration** —
   or, if you would rather not yet, that Phase 5 ships verified against a stub receiver and the
   real run waits.
