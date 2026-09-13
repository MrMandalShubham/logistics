# Phase 5 — Customer Status Integration · Verification

**Date:** 2026-09-13 · **Status:** **PASS** (against a stub receiver) · **Owner:** Lead Agent
**Analysis:** [`phase-5-analysis.md`](phase-5-analysis.md)

---

## 1. Commands

| Command | Result |
|---|---|
| `npm run db:reset` | **10** migrations from empty |
| `npm run db:verify` | **11/11** |
| `npm test` | **241 tests, 241 pass, 0 fail** |
| `npx tsc --noEmit` | clean |
| `npm run build` | PASS — `/integration` added |
| `npm run live:phase5` | one order end to end against a signing receiver |
| Grocery `npm run build` | PASS — `/api/logistics/status` added |

```
ℹ tests 241        (211 from Phases 1–4b, 30 added)
ℹ pass 241
ℹ fail 0
```

| Suite | Covers |
|---|---|
| mapping (6) | all 15 statuses answered; nothing produced that Grocery's CHECK or `OrderPipeline` would refuse; `RETURNED → CANCELLED` explicit; `RECEIVED` and the two return-transit states say nothing; an unmapped reason still makes a sentence |
| change detection (6) | four "being packed" transitions → **one** event; `PICKED_UP`/`OUT_FOR_DELIVERY` → one between them; `ARRIVED` adds none; `DELIVERED` always sends; **a failure is never swallowed**; the delivery records what Grocery was told |
| payload (4) | monotonic sequence and `occurred_at`; rider first name only, no surname, no number; **the delivery code never appears**; no customer name, phone or address |
| sending (5) | one timeline row → one event, enforced by a unique index; the timestamp is inside the MAC; a body edited in flight fails; the scheme matches Grocery's and Inventory's byte for byte; **a broken queue cannot roll back a delivery** |
| notifications (4) | a record per change, linked to its queue row; the worker's result lands through a definer function; the email channel records intent and sends nothing; a rider cannot read the log |
| outbound health (2) | counts come from a definer function, not a blind SELECT; dead letters name the delivery |
| sign-out (3) | an empty outbox is safe to wipe; **unsent work is never discarded silently**; the warning counts jobs, not just events |

---

## 2. The number this phase exists for

One order, eight logistics transitions, drained after each:

```
order ORD-3d59ad2f  ->  delivery 6f1e…

dispatcher admits it               logistics: READY_FOR_ASSIGNMENT   claimed 1, delivered 1
dispatcher assigns Asha            logistics: ASSIGNED               claimed 0
Asha accepts                       logistics: ACCEPTED               claimed 0
Asha taps PICKUP_PENDING           logistics: PICKUP_PENDING         claimed 0
Asha taps PICKED_UP                logistics: PICKED_UP              claimed 1, delivered 1
Asha taps OUT_FOR_DELIVERY         logistics: OUT_FOR_DELIVERY       claimed 0
Asha taps ARRIVED                  logistics: ARRIVED                claimed 0

   support reads the code out: 782207  (never sent to Grocery)

Asha enters the code               logistics: DELIVERED              claimed 2, delivered 1, dead 1
```

What the customer's order page said:

```
PAID       packed            seq=2   We have your order and it is being packed.
SHIPPED    out_for_delivery  seq=6   Your order is on its way.
DELIVERED  delivered         seq=9   Delivered. Thank you.

3 events for an 8-transition journey.
```

Five of the eight transitions changed nothing the customer could see and sent nothing.
Sending them would have cost five requests, five retry budgets and five rows to repeat what
somebody already knew — and buried the two that matter.

The `dead 1` is the Inventory commit: this was a synthetic order that Inventory never
reserved, so the commit correctly 404'd and died rather than recording a phantom sale.

Reproduce with `npm run grocery:stub` in one terminal and `npm run live:phase5` in another.

---

## 3. The bug the tests found

The first run produced **four** "being packed" events instead of one. `notified_key` came
out as:

```
PAID|packed|admitted
```

Every transition carries a `reason_code`, and almost all of them are internal bookkeeping —
`admitted`, `assigned`, `accepted`, `pickup`. Putting those in the comparison key made every
key unique, which defeated the suppression completely.

I had put the reason in the key for a real reason: `DELIVERY_FAILED` maps to the *same*
`(SHIPPED, out_for_delivery)` pair as `OUT_FOR_DELIVERY`, so without something to tell them
apart the customer would never learn the delivery failed at all. Both requirements are real;
the fix is that **only a reason the customer is being told counts**:

```sql
v_reason := case
  when new.to_status in ('DELIVERY_FAILED','RESCHEDULE_REQUIRED')
    then coalesce(new.reason_code, new.to_status)
end;
```

The same value is what travels in the payload, so `"reason_code": "admitted"` never reaches a
customer's order history either. Both halves are pinned by tests that fail loudly in opposite
directions.

---

## 4. Decisions, and what they cost

### Q10 — the OTP: **option B**

The delivery code stays exactly as Phase 4a built it, verified on the server, and is **never
sent to Grocery**. Support reads it out.

That drops item 6.4 and deletes risk **P5-04** outright: the plaintext code never enters
Grocery's database. It was the one genuine cost of the recommended option A, and the decision
removes it rather than mitigating it. A test asserts the code and the string `otp` are absent
from every queued payload.

What it does not scale to is volume. Reading codes down a phone is fine at tens of deliveries
a day and is not fine at hundreds. That is a procurement decision (option C), not a build one.

### Q34 — the rider: first name, no number

`Asha`, not `Asha Menon`, and no phone number. There is no number-masking provider in this
estate (Q9), and publishing a worker's real mobile to every customer is not a default to take.
A customer who needs to speak to a rider rings support.

### Q33 — the wording

I drafted it, in `delivery.customer_message()`, in one place so changing the tone is one diff:

> We have your order and it is being packed.
> Your order is on its way.
> Delivered. Thank you.
> We could not reach you at the address. We will try again.
> The parcel was damaged, so we did not hand it over. Contact support.

Plain, not apologetic. **Correct the tone and I will change it** — it is one function.

### Q32 — sign-out clears the outbox

The rider app had no sign-out at all, and the outbox survived on the device indefinitely
holding recipients' names, addresses and door instructions — "key under the blue pot" — for
every job that phone had handled.

It now syncs first, and **refuses to discard unsent work silently**:

> 2 updates on 2 jobs have not reached us yet. Signing out now deletes them and nobody will
> know that work was done. Get signal and send them first.

A plain `store.clear()` would have broken Phase 4b's one rule — an unanswered event stays —
more thoroughly than any bug, and on purpose. The decision is the rider's, made knowingly.

---

## 5. Design decisions worth recording

### The trigger is on the timeline, not on the transitions

Status reaches a customer by five routes: `transition`, `rider_step`, `complete_delivery`,
`fail_delivery` and the offline replay in `apply_rider_event`. Hooking each means five places
to forget, and Phase 6 will add more.

Every one of them writes exactly one row to `delivery_status_history`, which is insert-only and
enforced so by trigger. That makes it the one place a status change cannot hide from. It is not
a shortcut; it is the only position a future route cannot bypass.

### A queue problem must never fail a delivery

The whole trigger body is wrapped and the failure is audited rather than raised. Proven by a
test that puts an unsatisfiable constraint on `outbound_event` and transitions a delivery
anyway — the transition holds.

A rider standing at a door must not lose their work because Grocery's queue had a bad moment.
An event that is not queued is a stale order page; a failed transition is a parcel nobody can
account for.

### A dead status push is not a dead commit

Both appear on `/integration`. Only one is somebody's evening. A dead Inventory commit means
stock left a building and no ledger records it; a dead Grocery status means an order page is
stale while the shopping sits on the doorstep. The code treats them differently on purpose.

### The fourth time, same trap

Every number on the health screen comes from a `SECURITY DEFINER` function. A plain `SELECT`
under RLS as a role with no policy returns zero rows and reports success — on a health screen
"nothing is wrong" and "you cannot see anything" would render identically. A test pins it: the
rider's blind count is 0 while `outbound_health()` sees the queue.

---

## 6. Grocery PR #2 — committed, **not pushed**

Branch `feat/logistics-status-receiver`, commit `dfc5bf5`, stacked on PR #1 so the migrations
stay sequential. Six files:

| File | What |
|---|---|
| `src/app/api/logistics/status/route.ts` | the receiver — signature, idempotency, ordering |
| `migrations/002_logistics_status.sql` | `delivery_step` and friends, `logistics_status_event` |
| `schema.sql` | fresh installs match |
| `src/services/orders.ts` | **the ternary is gone** |
| `src/app/orders/page.tsx` | the message, the rider's first name, a cancelled order's own panel |
| `.env.example` | `LOGISTICS_INBOUND_SECRET` |

`LOGISTICS_INBOUND_SECRET` is deliberately **not** the existing `LOGISTICS_WEBHOOK_SECRET`.
One secret per direction: a leaked receiver secret cannot be used to place orders, and either
rotates without taking the other down. I introduced it as a duplicate of the existing name
first, which would have meant one variable holding two different secrets.

### Verified against the running route

```
no signature at all                    401  {"error":"unauthorized"}
wrong secret                           401  {"error":"unauthorized"}
malformed header                       401  {"error":"unauthorized"}
stale timestamp (7 min old)            401  {"error":"unauthorized"}
body edited after signing              401  {"error":"unauthorized"}
correctly signed, unknown status       400  {"error":"unknown customer_status \"WAT\""}
correctly signed, real shape           503  {"error":"could not record the event"}
GET                                    405  {"error":"POST a signed delivery status here"}
```

The caller only ever sees `unauthorized`; the reason stays in the log:

```
[logistics] rejected a status update: timestamp is 421s away from ours (tolerance 300s)
[logistics] could not record the event: Could not find the table 'public.logistics_status_event'
```

That 503 is migration 002 being unrun — correct, since PR #2 is unreviewed. It is a 5xx and
not a 4xx on purpose: it is our fault and retrying will work, so it must not kill the sender's
queue.

---

## 7. What is still not true

1. **The real end-to-end run has not happened.** Verified against a stub that implements the
   same signature, idempotency and ordering checks as Grocery's route. The real run needs
   **PR #1 and PR #2 merged and migration 002 applied**. Migration 001 *is* applied
   (2026-09-13, verified against the catalog).
2. **Grocery cannot reach its own database from this machine.** `NEXT_PUBLIC_SUPABASE_URL` is
   unset, so `src/lib/supabase.ts` falls back to `placeholder.supabase.co`.
3. **No email or SMS provider exists**, so those channels record intent and send nothing. The
   `customer_app` channel is real: pushing the status to Grocery *is* the notification.
4. **`RETURNED` still collapses to `CANCELLED`** (C-02). Grocery's `orders.status` CHECK has no
   `RETURNED`. The true status stays accurate in the logistics timeline.
5. **`ARRIVED` has no step of its own.** A fifth `OrderPipeline` step is a Grocery UI change.
6. **Two unscheduled background jobs** (Q29) — now three, with the outbound drain.
7. **No proof-photo store** (Q26). **No browser offline-toggle test** run.
8. Grocery's browser-set `status: 'PAID'` is unchanged and out of scope. Logistics has never
   treated `PAID` as evidence of payment.

---

## 8. Definition of done

- [x] 241/241 tests; `npm run check` green
- [x] `db:verify` 11/11; typecheck and build clean, both repos
- [x] One event per **customer-visible** change, proven: 3 for an 8-transition journey
- [x] A failure always reaches the customer, though it maps to the same pair as "on its way"
- [x] Every event carries a monotonic sequence; the receiver compares before applying
- [x] **The delivery code never leaves this system**
- [x] No customer name, phone or address travels to Grocery
- [x] A broken queue cannot roll back a delivery, proven with an unsatisfiable constraint
- [x] Notifications recorded, and the worker's result reaches the log
- [x] Dead letters visible and attributable on `/integration`
- [x] **Sign-out clears the outbox, and refuses to discard unsent work silently**
- [x] No Grocery or Inventory file changed outside the reviewed PR branch

---

## 9. Result

# PASS

A customer can now watch their order move, and is told when it does not. The two events that
matter are not buried in five that do not, the delivery code stays where a rider cannot reach
it and a database cannot leak it, and a rider signing out on a shared phone takes the
customers' addresses with them.

What remains is not code. It is merging two reviewed PRs and running one migration, after
which the three systems will have worked together end to end for the first time.

Next is **Phase 6**: exceptions and returns — resolving the conflicts Phase 4b raises and the
failures Phase 5 now reports.
