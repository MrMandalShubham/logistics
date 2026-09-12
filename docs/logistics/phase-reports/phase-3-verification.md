# Phase 3 — Admin Dispatch · Verification

**Date:** 2026-09-12 · **Status:** **PASS** · **Owner:** Lead Agent
**Analysis:** [`phase-3-analysis.md`](phase-3-analysis.md)

What was run and what happened. Where this disagrees with the analysis, **this is what was
built.**

---

## 1. Commands executed

| Command | Result |
|---|---|
| `npm run db:reset` | 7 migrations applied from empty |
| `npm run db:verify` | **11/11 passed** (19 tables now under RLS) |
| `npm test` | **130 tests, 130 pass, 0 fail** |
| `npm run check` | **PASS** |
| `npx tsc --noEmit` | **clean** |
| `npm run build` | **PASS** |
| `npm run expire:assignments -- --dry-run` | lists lapsed offers correctly (§6.1) |
| Live HTTP | 14 scenarios, including the two that matter most |

---

## 2. Test results

```
ℹ tests 130        (90 from Phases 1–2, 40 added)
ℹ pass 130
ℹ fail 0
ℹ suites 24
```

| Suite | Covers |
|---|---|
| riders (7) | login + profile in one transaction, starts offline, duplicate code, dispatcher cannot create, rider sees only themselves, **offboarding disables the login** |
| availability (5) | recorded with the actor, self-toggle recorded as self, **a rider cannot toggle another**, suspended cannot go online, the view reflects the latest |
| state machine (2) | SQL/TypeScript mirrors agree across all 15 statuses; ASSIGNED and ACCEPTED now reachable |
| assignment (7) | happy path, offline / suspended / **at-capacity refused with distinct reasons**, un-admitted refused, **5 concurrent assigns yield exactly one** |
| accept & decline (6) | named rider accepts, **a different rider is refused**, decline needs a reason, double-accept refused, expired offer refused, suspended-mid-offer refused |
| reassignment (5) | supersedes rather than edits, works from ACCEPTED, reason required, same-rider refused, **timeline shows taken-back then given-out** |
| offer timeout (4) | unanswered returns to the queue, **dry run agrees with the real sweep**, idempotent, an accepted job is untouched |
| rider visibility (5) | sees only their own delivery, **access ends when the assignment does**, can read the address they must deliver to, cannot assign, cannot read the audit log |

---

## 3. Database verification

```
PASS  schemas present  (delivery, fleet, identity, integration, ops)
PASS  RLS enabled on every table  (19 tables)
PASS  every RLS table has a policy  (18 tables)
PASS  audit log refuses UPDATE / DELETE
PASS  credential table is unreadable
PASS  external systems registered
PASS  permissions seeded  (admin:16 dispatcher:8 rider:2)
PASS  delivery timeline refuses UPDATE / DELETE
PASS  address requires a geocode and a delivery

11/11 checks passed
```

The RLS sweep now spans 19 tables, up from 16 — a `fleet` table added without a policy would
have failed the build.

---

## 4. The two things most likely to go wrong

Both were tested against the running system, not only in SQL.

### 4.1 A rider acting on somebody else's delivery

```
rider RDR-012 -> POST /deliveries/<assigned to RDR-011>/accept

  403 { "code": "not_your_assignment",
        "message": "this delivery is not offered to you" }

then the correct rider:
  200 { "outcome": "ACCEPTED", "status": "ACCEPTED" }
```

Holding `deliveries:respond` says "you are a rider". It does not say "you may accept this" —
that is checked in the database function, so no route can forget it.

### 4.2 Two dispatchers, one delivery

Five concurrent assigns of one delivery to five different riders:

```
fulfilled: 1        live assignments for that delivery: 1
```

The partial unique index `assignment_one_live` decides, not whichever request happened to
arrive first.

---

## 5. Live end-to-end

Against real Inventory on `:3100` with real reserved stock.

```
1. onboard a rider     -> RDR-011, one-time password, must change at first sign-in
2. rider signs in      -> role rider, permissions ['deliveries:respond','locations:read']
3. assign while OFFLINE-> 409 "RDR-011 is offline"
4. rider goes online   -> themselves, recorded as self (changed_by null)
5. assign              -> 201 ASSIGNED
6. dispatch board      -> {waiting, available_riders, out: 1, awaiting_response: 1}
7. wrong rider accepts -> 403 not_your_assignment
8. right rider accepts -> 200 ACCEPTED
9. reassign (accepted) -> 200, first attempt SUPERSEDED "bike broke down"
10. reassign, no reason-> 400 bad_request
11. force lapse + sweep-> returned to the queue
```

The timeline afterwards, which is the point of the whole phase:

```
14:04:45  —                     -> RECEIVED              api_client  ingested
14:04:46  RECEIVED              -> READY_FOR_ASSIGNMENT  admin       admitted
14:04:54  READY_FOR_ASSIGNMENT  -> ASSIGNED              admin       assigned   to RDR-011
14:05:08  ASSIGNED              -> ACCEPTED              rider       accepted   RDR-011
14:05:21  ACCEPTED              -> READY_FOR_ASSIGNMENT  admin       reassigned bike broke down
14:05:21  READY_FOR_ASSIGNMENT  -> ASSIGNED              admin       assigned   to RDR-012
```

A rider did not silently change. The delivery was taken back and given out again, and both
facts are on the record with who did them.

Assignment history keeps the superseded attempt:

```
RDR-011  SUPERSEDED  bike broke down
RDR-012  OFFERED
```

**Screens:** `/dispatch`, `/riders` and `/deliveries` all return 200 with live rows, scoped by
the signed-in user's locations through RLS rather than a filter in the page.

---

## 6. One real defect found and fixed

### 6.1 The dry run disagreed with the real sweep

Found during live verification:

```
npm run expire:assignments -- --dry-run   ->  "0 offer(s) would be returned"
npm run expire:assignments                ->  "returned 1 offer(s) to the queue"
```

The sweep itself is `SECURITY DEFINER` and sees everything. The dry run selected from the
tables **directly, under row-level security, as a role holding no permissions** — so it saw
nothing and cheerfully reported there was nothing to do.

This is the same silent-no-op class as the Phase 2 location-cache finding: no error, no
warning, a confident wrong answer. Here it is worse, because the dry run exists precisely to
let an operator check before acting.

**Fix:** a `fleet.expiring_assignments()` definer function. Both paths now go through the same
privilege model, so they cannot disagree.

**Regression test:** *"the DRY RUN agrees with the real sweep"* — asserts the sweep returns
exactly the count the dry run listed. Verified live afterwards: `1 offer(s) would be returned`
naming the delivery and rider, then `returned 1 offer(s)`.

---

## 7. Deviations from the analysis

| Analysis said | Built | Why |
|---|---|---|
| ~40 tests | **40** | as planned |
| `app/actions/dispatch.ts` | built | server actions behind the buttons; return a message rather than throwing, so a dispatcher a second too late sees "somebody else took it" rather than an error page |
| — | `fleet.expiring_assignments()` | added by §6.1 |
| — | `clearLoad()` in tests | shared riders hit `max_concurrent` legitimately across tests. Phase 4 will close assignments when a delivery completes; until then the tests do it explicitly |

---

## 8. Known limitations

1. **A rider cannot read their own delivery over the API.** RLS allows it — proven by test —
   but `GET /api/v1/deliveries/:id` requires `deliveries:read`, which riders do not hold, so
   they get a 403. The rider app is Phase 4 and will need a rider-scoped read. **The data
   layer is correct; the route gate is not yet.**
2. **Assignments are never marked `COMPLETED` by the system.** The status exists and nothing
   sets it, because nothing completes a delivery until Phase 4. A rider therefore stays at
   capacity until reassigned or the offer lapses. Correct for this phase, wrong the moment
   Phase 4 lands — and Phase 4 must close them.
3. **The customer still sees nothing.** Assignment is internal until Phase 5.
4. **No map on the dispatch board** (Q21). Inventory exposes no shop coordinates, so a map
   could plot the destination and not the origin. The board is a list.
5. **The timeout sweep is not scheduled.** `npm run expire:assignments` works and
   `-- --loop 30` runs continuously, but nothing runs it automatically. A pg_cron job or a
   worker belongs with the Phase 7 schedule; until then an unanswered offer sits until
   somebody runs it.
6. **Still synthetic orders.** The Grocery migration (PR #1) has not been run, so no real
   customer order has been through this.
7. **No rider shifts or location tracking** — dropped from this phase by agreement.

---

## 9. Open questions after Phase 3

| # | Status |
|---|---|
| **Q1 / Q2 / Q4** | Fixed in code, **Grocery PR #1 open and the migration unrun** |
| **Q21** | Still open; ships as a list. Bites harder in Phase 4 when a rider needs navigation |
| **Q23** | **Resolved** — one delivery per rider by default, `max_concurrent` configurable to 10 |
| **Q24** | **Resolved** — a dispatcher may reassign an accepted delivery with a reason. Verified live |
| **Q25** *(new)* | **What closes an assignment?** Phase 4 must set `COMPLETED` when a delivery reaches a terminal state, or riders silently stay at capacity forever (§8.2) |

---

## 10. Definition of done

- [x] 130/130 tests pass; `npm run check` green
- [x] `db:verify` 11/11, RLS spanning `fleet`
- [x] Typecheck and build clean
- [x] A rider can be onboarded, sign in, and go online
- [x] A dispatcher can assign; an unavailable rider is refused with the reason
- [x] **A rider cannot act on another rider's delivery** — verified live
- [x] **Five concurrent assigns yield exactly one** — verified by test
- [x] Decline and timeout both return the delivery to the queue
- [x] Reassignment supersedes rather than edits, and the timeline shows it
- [x] A rider sees only their own delivery, and loses it when the assignment ends
- [x] Dispatch, riders and delivery screens render with live data
- [x] **No file in Grocery or Inventory modified by this phase**

---

## 11. Result

# PASS

Phase 3 is complete. A delivery can now be given to a named person, accepted, declined,
reassigned or timed out, and the record says who was asked and what they said.

The next thing that happens to a parcel is somebody picking it up — Phase 4. Before that,
**Q25 should be settled**: nothing currently closes an assignment, so Phase 4 must do it or
riders will fill up and never empty.
