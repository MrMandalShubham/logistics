# Phase 2 — Receive Delivery-Ready Orders · Verification

**Date:** 2026-09-12 · **Status:** **PASS** · **Owner:** Lead Agent
**Analysis:** [`phase-2-analysis.md`](phase-2-analysis.md)

What was run, and what actually happened. Where this disagrees with the analysis, **this is
what was built.**

---

## 1. Commands executed

| Command | Result |
|---|---|
| `npm run db:reset` | 6 migrations applied from empty |
| `npm run db:verify` | **11/11 checks passed** |
| `npm test` | **90 tests, 90 pass, 0 fail** |
| `npm run check` | **PASS** |
| `npx tsc --noEmit` | **exit 0** |
| `npm run build` | **PASS** — 17 routes |
| `npm run locations:sync` | 3 locations from live Inventory |
| `npm run demo:order` | signed ingest, `201` |
| `npm run demo:order` (repeat) | idempotent replay, same delivery |
| `npm run demo:order -- --no-address` | `422 address_not_deliverable`, stored |
| Manual HTTP | 18 scenarios incl. 6 security paths |

---

## 2. Test results

```
ℹ tests 90        (41 from Phase 1, 49 added)
ℹ pass 90
ℹ fail 0
ℹ suites 16
ℹ duration_ms 2247
```

| Suite | Covers |
|---|---|
| payload validation (10) | required fields, address + geocode, item quantities, forward compatibility |
| webhook signatures (5) | valid, wrong secret, tampered body, stale timestamp, malformed header |
| ingest (10) | creation, tracking ids, duplicate, **5 concurrent**, unknown/inactive location, hold recording, reservation ids |
| state machine (8) | **SQL/TypeScript mirror agreement**, legal + illegal transitions, terminal states, double-admit, history+audit counts, location refusal |
| visibility (8) | dispatcher scoping, admin, rider, cascade to address/items/timeline, inbound-event isolation |
| inbound journal (4) | rejection recorded with payload, replay permission, replay marking, never-throws |
| hold expiry (3) | lapsing listed, distant excluded, cancelled dropped |

---

## 3. Database verification

```
PASS  schemas present  (delivery, identity, integration, ops)
PASS  RLS enabled on every table  (16 tables)
PASS  every RLS table has a policy  (15 tables)
PASS  audit log refuses UPDATE / DELETE
PASS  credential table is unreadable
PASS  external systems registered  (GROCERY, INVENTORY)
PASS  permissions seeded  (admin:12 dispatcher:5 rider:1)
PASS  delivery timeline refuses UPDATE / DELETE
PASS  address requires a geocode and a delivery

11/11 checks passed
```

Three checks are new this phase: the delivery timeline's immutability (both directions) and
the address NOT NULL/FK constraint. The RLS sweep now covers 16 tables, up from 10 — a
Phase 2 table without a policy would have failed the build.

---

## 4. Live integration — real Inventory, real stock

Not a mock. Inventory Core running on `:3100` with its 52 migrations and real seeded stock.

### 4.1 The happy path, end to end

```
1. Reserve real stock in Inventory
   POST /api/inventory/reserve {"order_id":"ORD-LIVE-…","location":"SH1",…}
   -> {"ok":true,"items":[{"reservation_id":"4d005309-…"}]}

2. Send it to logistics, signed
   POST /api/v1/integration/orders.delivery-ready
   -> 201 {"delivery_id":"b7f62736-…","tracking_id":"DLV-2026-000023","status":"RECEIVED"}

3. Logistics verified the hold against Inventory during ingest
```

| | logistics `delivery` row | Inventory `order status` |
|---|---|---|
| status | `held` | `held` |
| expiry | `2026-09-12 09:43:00.845+00` | `2026-09-12T09:43:00.845Z` |

The expiry matches to the millisecond because logistics read it from Inventory rather than
computing it.

### 4.2 Idempotent replay

Sending the identical order again:

```
201 {"delivery_id":"b7f62736-…","tracking_id":"DLV-2026-000023",
     "as_of":"2026-09-12T09:13:02.520Z"}      <- the ORIGINAL as_of, replayed verbatim
```

Same delivery, same response body, same timestamp. One delivery row exists.

### 4.3 The rejection path, which is the one that will actually happen

```
npm run demo:order -- --no-address

422 {"error":{"code":"address_not_deliverable",
              "message":"delivery_address is required. A parcel needs somewhere to go.",
              "fields":["delivery_address"],
              "recoverable":"This payload has been stored. Fix it at source and
                             an admin can replay it."}}
```

And an order whose stock is not held:

```
422 {"error":{"code":"hold_not_held",
              "message":"Inventory is not holding stock for this order.
                         It was released or never reserved."}}
```

### 4.4 Recovery — the whole reason rejections are stored

```
1. list rejected      -> hold_not_held, ORD-NOHOLD-…, attempts 1
2. replay as-is       -> 422 {"code":"hold_not_held","still_replayable":true}
3. fix upstream       -> reserve the stock in Inventory
4. replay again       -> {"ok":true,"delivery_id":"86092f9f-…",
                          "tracking_id":"DLV-2026-000024","created":true}
```

Nothing was lost between the refusal and the fix. This is the mechanism that makes **Q1**
survivable: when Grocery starts attaching addresses, the accumulated backlog can be pushed
through rather than reconstructed.

### 4.5 Admission and timeline

```
POST /deliveries/:id/admit  -> {"ok":true,"status":"READY_FOR_ASSIGNMENT"}
POST /deliveries/:id/admit  -> {"code":"illegal_transition",
     "message":"READY_FOR_ASSIGNMENT cannot become READY_FOR_ASSIGNMENT. Allowed: CANCELLED"}

timeline:
  2026-09-12T09:13:02  -        -> RECEIVED              | api_client | ingested
  2026-09-12T09:13:47  RECEIVED -> READY_FOR_ASSIGNMENT  | admin      | admitted
```

The refusal names what *is* allowed. "What happened to this order" is now answerable from the
record, with the actor on every line — which nothing in this estate could do before.

### 4.6 The hold-expiry report doing its job

```
GET /api/v1/deliveries/hold-expiry?within_minutes=45

at risk: 7
  DLV-2026-000018  held     expires in  1 min
  DLV-2026-000006  held     expires in 16 min
  DLV-2026-000023  held     expires in 29 min
  DLV-2026-000020  unknown  (never verified)
```

A hold one minute from lapsing, visible before a rider is anywhere near a shop. This is the
**Q4 mitigation, not a fix** — see §7.

### 4.7 Admin queue renders

`GET /deliveries` returns 200 with live rows (`DLV-2026-000022`, `…021`, `…020`), scoped by
the signed-in user's locations through RLS rather than a WHERE clause in the page.

---

## 5. Security verification

Six hostile requests against the inbound endpoint:

| Attempt | Expected | Actual |
|---|---|---|
| No signature | 401 | **401** |
| Bad signature | 401 | **401** |
| Stale signature (`t=1000000`) | 401 | **401** |
| Valid signature, **tampered body** | 401 | **401** |
| No bearer key | 401 | **401** |
| No `Idempotency-Key` | 400 | **400** |
| Key without the scope | 403 | **403** |

The tampered-body case is the one worth noting: a correct signature over a *different* body is
refused, because the MAC covers the raw bytes rather than a re-serialised object.

**Also verified**

- A dispatcher bound to SH1 cannot see SH2's deliveries, addresses, items or timeline.
- A rider sees no deliveries at all.
- A dispatcher cannot read inbound events (the payloads carry customer PII).
- A dispatcher cannot cancel; a dispatcher cannot mark an event replayed.
- A transition on another shop's delivery is refused in the database, not the route.

---

## 6. Two real defects found and fixed

### 6.1 A brand-new API key was rate-limited on its very first request

**Found by:** the manual scope test, which returned `429` where `403` was expected.

`api_client.tokens` defaulted to `0`, and the bucket refills from time elapsed since
`tokens_at` — which at mint is "now", so there was nothing to refill from. Every freshly
minted key was refused until the bucket filled.

**Why the test suite missed it:** the Phase 1 test *"the bucket starts full and drains"* set
`tokens = 5` by hand before testing. It was measuring the refill maths, and in doing so it
papered over the initial condition.

**Fix:** `create_api_client` now seeds the bucket to the key's own limit. The masking test was
rewritten and a new one added — *"a NEW key is not rate-limited on its first request"* — which
mints a key and calls straight through with no setup.

Verified live: the scopeless key now returns **403 insufficient_scope**; the correct key
returns **200** on its first call.

### 6.2 A write to the location cache through RLS is a silent no-op

**Found by:** a Phase 2 test that deactivated a location and then watched the ingest succeed
anyway.

`integration.location_ref` has a `SELECT` policy and no write policy. With the table grant in
place, an `UPDATE` through the `authenticated` role matches zero rows and **reports success**.

The behaviour is correct — the cache is written only by `locations:sync`, which runs as the
pool's own superuser — but it is exactly the "grant without a policy" trap documented in
migration `0004`, and it fooled my own test first.

**Fix:** the test now deactivates through `raw()`, with a comment explaining why, and a second
test pins the no-op so that adding a write policy later is a deliberate act rather than a
discovery.

---

## 7. Known limitations

1. **Reservations are still not confirmed.** `reserve` returns `reservation_id` and
   `GET /api/inventory/order/:id` does not, so logistics cannot call `confirm` and a hold
   lapses after 30 minutes. Verified at ingest, expiry recorded, at-risk report shipped — but
   **this is a mitigation, not a fix. Q4 should be resolved before Phase 4 ships a real
   delivery.**
2. **No real order can be ingested yet.** Every order in the estate lacks a delivery address
   (Q1). The endpoint, validation, storage and replay all work; the sender does not exist.
3. **Cancel does not release the inventory hold.** Deferred to Phase 6 with the rest of the
   outbound writes and their retry machinery. The hold lapses on its own — same outcome,
   slower. The response says so explicitly.
4. **No outbound events.** Phase 5, and blocked on Q3 regardless.
5. **The admin screens are read-only.** Admit and Cancel work as API calls; buttons arrive
   with the dispatch board in Phase 3.
6. **Inbound events are never pruned.** They hold customer PII, so a retention sweep belongs
   with Phase 7's job schedule. Noted as a privacy obligation, not just housekeeping.
7. **`promised_from` / `promised_to` are never populated** — nothing supplies them (Q22).
8. **Docker Desktop stopped twice** during this session, taking both databases with it. Not a
   code issue, but it will keep interrupting local runs.

---

## 8. Open questions after Phase 2

| # | Status |
|---|---|
| **Q1** address | **Unchanged and now the critical path.** Everything downstream is built and idle |
| **Q2** pickup location | Contract requires it; demo supplies it. Still unanswered for real orders |
| **Q3** may Grocery change | Needed for Phase 5 |
| **Q4** reservation ids | **Should be resolved before Phase 4.** §7.1 |
| **Q16** Inventory key | **Resolved.** Now `catalog:read` + `stock:read`, verified live |
| **Q21** location coordinates | Still open; bites in Phase 3 |
| **Q22** promised window | Open, minor |

---

## 9. Definition of done

- [x] 90/90 tests pass; `npm run check` green
- [x] `db:verify` 11/11, RLS spanning the delivery schema
- [x] Typecheck and build clean, 17 routes
- [x] A signed order becomes a delivery, exactly once
- [x] Concurrent duplicates yield exactly one delivery
- [x] Hold verified against **live Inventory**, expiry matching to the millisecond
- [x] An Inventory outage flags rather than refuses
- [x] A malformed order is refused, **stored, and replayable** — demonstrated end to end
- [x] The state machine refuses illegal moves and names what is allowed
- [x] SQL and TypeScript state machines proven to agree
- [x] Timeline records every transition with its actor
- [x] Location scoping verified per role
- [x] Six hostile requests refused correctly
- [x] **No file in Grocery or Inventory modified**

---

## 10. Result

# PASS

Phase 2 is complete. An order can enter logistics through a signed, idempotent, verified front
door, and a dispatcher can see it with its full history.

The system is now waiting on one thing it cannot supply itself: **an order with a delivery
address on it.** Everything downstream of that is built and tested.
