# Phase 4b — Offline Rider App · Analysis

**Date:** 2026-09-12 · **Status:** proposed, **awaiting approval before any code is written**
**Owner:** Lead Agent
**Depends on:** [Phase 4a verification](phase-4a-verification.md)

---

## 1. Objective

A rider in a lift, a basement or a village with no signal can still do the job, and nothing
they did is lost when the phone reconnects.

---

## 2. The question this phase turns on

**Can a rider complete a delivery while offline?**

The OTP is verified by comparing a hash held on the server. A phone with no signal cannot do
that. So there are three options, and the choice decides what this phase is worth.

| | Approach | Consequence |
|---|---|---|
| A | **Completion requires signal.** Offline covers only the earlier steps | The most valuable offline action is the one you cannot do. A rider in a basement is stuck at the door with a parcel and a customer in front of them |
| B | **Ship the hash to the device** and verify locally | A 6-digit code behind a SHA-256 is a million guesses — seconds of offline brute force. It hands the rider exactly what the whole design withholds |
| **C** *(recommended)* | **Capture now, verify on sync.** The rider takes the code, the outbox holds it, the server checks it when the phone reconnects | The handover happens on time. The proof is checked slightly later |

**C is the only honest option.** B defeats Phase 4a's central rule; A makes the feature
decorative.

### What C means precisely

- The rider's screen says **"waiting to sync"**, not "delivered". It does not lie about what
  the server knows.
- On sync the server runs the **same** `verify_otp` it always has. Nothing is weakened.
- If the code verifies → `DELIVERED`, timestamped **when the rider captured it**, not when the
  phone reconnected.
- If it does not → the delivery stays `ARRIVED` and a `PROOF_DISPUTED` exception is raised for
  a human. The parcel is gone either way; the open question is whether the proof was good, and
  that is a person's call.

---

## 3. Scope

| # | Deliverable | Detail |
|---|---|---|
| 3.1 | **Outbox** | append-only queue in IndexedDB; every action stamped with a **client-generated event id** at capture |
| 3.2 | **Sync endpoint** | `POST /api/v1/me/sync` — a batch of captured events, replayed server-side |
| 3.3 | **Server-side idempotency** | `integration.rider_event`, unique on the client event id. Replay is free |
| 3.4 | **Ordered replay** | applied in **capture** order, not arrival order |
| 3.5 | **Conflict handling** | an event that cannot be applied becomes an exception for a human — never silently dropped, never blindly forced |
| 3.6 | **Service worker** | caches the shell and the rider's current tasks so the app opens with no signal |
| 3.7 | **Offline UI** | a clear banner, per-task sync state, a manual "sync now" |
| 3.8 | **Testable core** | the outbox and replay logic as **pure modules**, tested in `node --test` (§5) |
| 3.9 | Tests | `tests/phase4b.test.mjs` |

### Out of scope

- **Photo proof offline.** There is still no storage driver (Q26), so there is nothing to
  upload to. Queuing megabytes of image against an unbuilt store would be guessing twice.
- Background sync while the app is closed. A service worker's `sync` event is unreliable
  across browsers; the app syncs when opened or when connectivity returns.
- Offline dispatch or admin. Staff are at desks.
- Map tiles offline.

---

## 4. The conflicts, and what happens

Each is a real sequence, not a hypothetical.

| # | What happened | Response |
|---|---|---|
| **C1** | Rider completes offline; dispatcher reassigned the delivery meanwhile | **Conflict.** The parcel was handed over by somebody who no longer holds the assignment. `ASSIGNMENT_SUPERSEDED` exception, CRITICAL, and the new rider's offer is withdrawn. A person decides |
| **C2** | Rider completes offline; dispatcher already marked it failed | **Conflict.** Two contradictory accounts of the same doorstep. `CONFLICTING_OUTCOME`, CRITICAL |
| **C3** | Rider completes offline; the delivery was cancelled | **Conflict.** Something was handed to somebody. `DELIVERED_AFTER_CANCEL`, CRITICAL |
| **C4** | The same event syncs twice (flaky connection) | **Not a conflict.** Idempotent on the client event id; the second is a no-op returning the first result |
| **C5** | Steps arrive out of order | Sorted by capture time before applying. A step whose state has already been passed is a **no-op**, not an error |
| **C6** | The OTP fails at sync | `PROOF_DISPUTED`, delivery stays `ARRIVED` (§2) |
| **C7** | Rider signs in on a second device with a stale outbox | Same idempotency. Events already applied return their original outcome |
| **C8** | An outbox item is days old | Applied, and flagged `STALE_SYNC` if older than the configured window. Somebody should know a delivery was completed 26 hours ago |

**The rule:** last-write-wins is never acceptable for a terminal state. Every conflict above
surfaces to a human rather than being resolved by whoever happened to sync last.

---

## 5. Making offline code testable

Client-side sync logic is where subtle bugs live and where a test harness usually cannot
reach. So the structure is chosen for testability rather than convenience:

```
lib/offline/outbox.ts     PURE. enqueue, order, dedupe, retry policy, staleness.
                          No IndexedDB, no fetch — takes and returns plain objects.

lib/offline/store.ts      The thin IndexedDB adapter. Almost no logic.

lib/offline/sync.ts       PURE decision logic: given outbox state and a server
                          response, what next?

app/(rider)/sw.js         The service worker. Cache-first shell, network-first data.
                          Deliberately dull.
```

`outbox.ts` and `sync.ts` are tested in `node --test` alongside everything else. What remains
untestable is a thin adapter and a cache policy, and that is a deliberate shrinking of the
untested surface rather than an accident.

---

## 6. Database changes — `0009_offline.sql`

```sql
create table integration.rider_event (
  id               bigint generated always as identity primary key,

  -- Generated ON THE DEVICE, at capture. This is the idempotency key:
  -- the server never invents it, so a replay is always recognisable.
  client_event_id  uuid not null unique,

  rider_id         uuid not null references fleet.rider(id),
  delivery_id      uuid not null references delivery.delivery(id),

  action           text not null,       -- step | complete | fail | location
  payload          jsonb not null,

  captured_at      timestamptz not null,   -- when the RIDER did it
  received_at      timestamptz not null default now(),

  status           text not null default 'APPLIED'
                     check (status in ('APPLIED','NOOP','CONFLICT','REJECTED')),
  outcome          jsonb,
  conflict_code    text
);
```

Plus `integration.apply_rider_event(...)` — one definer function that classifies and applies,
so the rules live where every other rule in this system lives. New exception codes:
`ASSIGNMENT_SUPERSEDED`, `CONFLICTING_OUTCOME`, `DELIVERED_AFTER_CANCEL`, `PROOF_DISPUTED`,
`STALE_SYNC`.

**One schema change to `delivery.delivery`:** `delivered_at` is already there and is set from
`captured_at` on an offline completion — a delivery that happened at 14:02 and synced at 15:30
is recorded as happening at 14:02. Otherwise every SLA figure is wrong by however long the
signal was out.

---

## 7. The sync endpoint

```http
POST /api/v1/me/sync
{ "events": [
    { "client_event_id": "…", "delivery_id": "…", "action": "step",
      "payload": { "to": "PICKED_UP" }, "captured_at": "2026-09-12T14:02:11Z" },
    { "client_event_id": "…", "delivery_id": "…", "action": "complete",
      "payload": { "otp": "145953" },  "captured_at": "2026-09-12T14:31:40Z" }
] }
```

```json
{ "results": [
    { "client_event_id": "…", "status": "APPLIED", "delivery_status": "PICKED_UP" },
    { "client_event_id": "…", "status": "CONFLICT", "conflict_code": "ASSIGNMENT_SUPERSEDED",
      "message": "This delivery was reassigned while you were offline. Dispatch has been told." }
] }
```

**Per-event results, not a batch pass/fail.** One conflicted event must not discard nine good
ones — and the rider needs to know *which* one needs a conversation.

The endpoint is **not** `idempotent: true` in the wrapper sense: idempotency here is per event,
by `client_event_id`, because a batch is not a request that can be replayed as a unit.

---

## 8. Security

| # | Risk | Mitigation |
|---|---|---|
| P4b-01 | Forged `captured_at` — backdating a delivery | Clamped: never before the assignment, never after `received_at`. A device clock is not evidence |
| P4b-02 | A rider syncing events for somebody else's delivery | The same ownership check as 4a, per event, in the database |
| P4b-03 | **Customer addresses and phone numbers cached on a phone** | Cache only *live* tasks; clear on sign-out, on terminal state, and after a TTL. A lost phone should not be a customer list |
| P4b-04 | Replaying a captured sync payload | Client event ids are unique and single-outcome; a replay returns the original result |
| P4b-05 | OTP codes sitting in an outbox on disk | Held only until the event syncs, then removed. Never logged |
| P4b-06 | A completion forced through after cancellation | Refused and raised as C3. The rider is told plainly |

---

## 9. Tests

`tests/phase4b.test.mjs`, roughly 35.

**Outbox, pure (10)** — ordering by capture time, dedupe by event id, retry backoff, staleness
threshold, surviving a serialise/deserialise round trip, never dropping an unsynced event.

**Idempotency (4)** — the same event twice applies once; concurrent duplicate syncs; a replay
returns the original outcome; a second device's stale outbox is harmless.

**Ordering (3)** — out-of-order events apply in capture order; an already-passed step is a
**no-op not an error**; a gap does not block later events.

**Conflicts (8)** — one test per case C1–C8, each asserting the exception code, the CRITICAL
severity, and that **nothing was silently applied or silently dropped**.

**Offline completion (5)** — good code applies and `delivered_at` is the **capture** time; bad
code raises `PROOF_DISPUTED` and leaves it `ARRIVED`; the commit enqueues only on success;
a clock-skewed `captured_at` is clamped.

**Ownership (3)** — another rider's event refused; events for an unassigned delivery refused;
a rider cannot sync as somebody else.

**Cache policy (2)** — a terminal delivery is evicted; sign-out clears everything.

---

## 10. Verification

```bash
npm run check && npx tsc --noEmit && npm run build
npm run db:verify
```

Manual, and the part that matters: open the rider app, **switch the network off in devtools**,
complete a delivery, watch it sit as "waiting to sync", switch the network back on, and watch
it become `DELIVERED` with the earlier timestamp and a queued commit.

Then the unhappy one: go offline, complete, and **have a dispatcher reassign the delivery from
another browser** before reconnecting. Confirm the conflict is raised and visible, and that
nobody's account of events was quietly discarded.

---

## 11. Open questions

| # | Question |
|---|---|
| **Q30** *(new)* | **Who resolves a conflict, and how?** Phase 4b raises them and shows them. The resolution workflow — force, discard, or reconcile — belongs with Phase 6's exception handling. Proposed: raise and surface now, resolve in Phase 6 |
| **Q31** *(new)* | **How stale is too stale?** Proposed **24 hours**: applied, but flagged `STALE_SYNC`, because somebody should know a delivery was completed yesterday and only just reported |
| **Q26** | Photo proof still has no store, so photos stay out of the outbox |
| **Q29** | Two unscheduled jobs, now three counting nothing — still Phase 7 |

---

## Approval requested

**Please confirm:**

1. **§2 option C** — offline completion captures the code and verifies it on sync. The rider's
   screen says "waiting to sync", never "delivered", until the server agrees.
2. **§4** — every conflict raises a CRITICAL exception for a human. Nothing is resolved by
   whoever syncs last.
3. **Recording `delivered_at` as the capture time**, not the sync time.
4. **§5** — the sync logic lives in pure modules so it can be tested, with a deliberately thin
   untested adapter.
5. **Q30** — raise and surface conflicts now; the resolution workflow lands in Phase 6.
6. **Q31** — 24 hours before an outbox item is flagged stale.
7. Photos staying out of scope until Q26 is answered.
