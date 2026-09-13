# Phase 7 — Scheduling, Retention and Reports · Verification

**Date:** 2026-09-13 · **Status:** **PASS** · **Owner:** Lead Agent
**Analysis:** [`phase-7-analysis.md`](phase-7-analysis.md)

---

## 1. Commands

| Command | Result |
|---|---|
| `npm run db:reset` | **12** migrations from empty |
| `npm run db:verify` | **11/11** |
| `npm test` | **312 tests, 312 pass, 0 fail** |
| `npx tsc --noEmit` | clean |
| `npm run build` | PASS — `/reports` added |
| `npm run worker -- --once` | all four jobs ran and recorded |
| `GET /api/health?deep=1` | **503 → 200**, live |

```
ℹ tests 312        (279 from Phases 1–6, 33 added)
ℹ pass 312
ℹ fail 0
```

| Suite | Covers |
|---|---|
| the code is not in the journal (5) | masked on the way in; the key survives; nothing else touched; **a direct INSERT cannot smuggle one in**; no plaintext code in any table after a delivery |
| the scheduler can be watched (6) | a run is recorded; a failure is recorded as a failure; **never-succeeded is overdue, not "no data"**; a success clears it and staleness brings it back; the migration count is not stale; every scheduled job has a handler |
| lapsing holds (2) | flagged once, not once per run; a hold stops mattering once the parcel is in a bag |
| retention (7) | dry run changes nothing; **the address is anonymised, not deleted**; the sku survives and the item name does not; a recent delivery is untouched; **an open delivery is untouched however old**; rider traces deleted; payloads redacted keeping the row |
| the audit log (5) | named keys redacted and **nothing else**; **still append-only afterwards**; the redaction audits itself; no signed-in user can call it; nor reach the purge |
| reports (8) | stuck appears after the threshold and not before; a terminal delivery is never stuck; **on-time says "not available" and why**; latencies from the timeline; commit health separates verified; the funnel counts what exists; a rider reads none of it; the error rate is a rate |

---

## 2. The finding, closed

Phases 4a and 4b keep the customer's code out of reach — a hash in `delivery_otp`, a SELECT
policy of `using (false)`, EXECUTE revoked from `PUBLIC` on `mint_otp`. The offline journal
then wrote the code down in cleartext and kept it indefinitely.

Now:

```
select payload from integration.rider_event where action='complete';
 {"otp":"******"}

rider_event rows holding a real code: 0
```

Three decisions inside that:

- **A trigger on the table**, not a change to `apply_rider_event`. There is one writer today
  and there will be more. A test inserts directly into `rider_event` with a real code and
  proves it comes back masked.
- **The key is kept.** `{"otp":"******"}` still records *that* a code was submitted, which is
  the question somebody asks when a rider says they tried. Deleting the key loses that.
- **A one-off pass** over existing rows, in the migration.

A test greps `rider_event`, `ops.notification`, `outbound_event` and `ops.audit_log` for the
actual code after a real delivery and requires zero hits in all four.

---

## 3. Live: the scheduler, and the check that makes it worth having

```
$ npm run worker -- --once
ran  outbound.drain  claimed 20, delivered 0, retrying 15, dead 5

job                 every    last success              state
assignments.expire  60s      2026-09-13 03:00:35       ok
holds.expire        300s     2026-09-13 03:00:35       ok
outbound.drain      20s      2026-09-13 03:00:36       ok
retention.purge     86400s   2026-09-13 03:00:36       ok
```

Then the drain was aged past its window, and the deep health check was asked:

```
status    : degraded
jobs.ok   : False
detail    : outbound.drain has not succeeded for 2535s (allowed 300s)
HTTP 503
```

And after one run:

```
status : ok
detail : every scheduled job has succeeded within its window
HTTP 200
```

That sentence is the phase. The scheduling was the easy half; a worker that silently stops
leaves every other check green while a customer's order page freezes on "packed" and
Inventory's ledger stays silent, because *nothing fails*.

### A check that had quietly stopped checking

The same probe revealed `EXPECTED_MIGRATIONS = 9` while twelve existed — stale since Phase 5,
so a deployment still running Phase 4's schema would have reported healthy. It was forgotten
twice, so it is now in `lib/migrations.ts` with a test that counts the files in `db/migrations`
and fails when they disagree. Bumping it is still manual; forgetting is no longer silent.

---

## 4. Live: retention

Everything terminal backdated past its window, then a real purge:

```
── one address, before ──
  {"recipient_name":"R Iyer","phone":"+91900111","line1":"12 Hill Rd","line2":"Flat 4",
   "city":"Mumbai","pincode":"400050","lat":"19.061234","lng":"72.831234",
   "instructions":"key under the blue pot"}
  {"sku":"S1","name":"Something personal","quantity":1}

── applied ──
  addresses_anonymised       12
  items_anonymised           12
  inbound_redacted            2
  rider_events_redacted       5
  notifications_redacted     42

── the same address, after ──
  {"recipient_name":"[redacted]","phone":"[redacted]","line1":"[redacted]","line2":null,
   "city":"Mumbai","pincode":"400050","lat":"19.060000","lng":"72.830000",
   "instructions":null}
  {"sku":"S1","name":"[redacted]","quantity":1}

── is the audit log still append-only? ──
  AUDIT_IMMUTABLE: the audit log is append-only
```

The person is gone. The pincode, the city and a geocode rounded to about a kilometre remain,
so "which areas fail most often" still has an answer and the record does not read as broken.

`npm run retention` defaults to a dry run and prints counts per table; `--confirm` applies.

---

## 5. Two bugs found by writing the tests

### Retention would have crashed on its first real run

`delivery_address.phone` is **NOT NULL** — 0005 made it so because a delivery with half an
address is not a state this system may be in. The purge set it to `null`, which fails the
constraint and takes the whole transaction with it: **no retention would ever have completed**,
and the failure would have surfaced as a job that quietly errored once a day.

The personal columns are now overwritten with `[redacted]`; `line2` and `instructions`, which
are nullable, still simply go.

### A rider could read every report

I added a `reports:read` permission and then checked it in none of the report functions.
Location scoping is not a role check: `ops.can_access_location` passes for a rider, because an
empty `location_codes` means "every location" everywhere in this codebase.

So `stuck_deliveries`, the funnel, the latencies and the outcome rates were all readable by a
rider, complete with customers' tracking ids. Every report function now gates on
`identity.has_permission('reports:read')` alongside its location scoping — the two answer
different questions and both are needed.

---

## 6. §3.2 — the narrow hole in the append-only log

Approved and built. What `ops.redact_audit_pii` does:

- Replaces four named keys — `address`, `delivery_address`, `recipient_name`, `phone` — with
  `[redacted]`, inside `before`/`after` only.
- Nothing else: not the action, actor, entity, timestamp or reason; nothing newer than the
  window; no row deleted.
- The trigger is disabled for the duration of the statement and re-enabled in an exception
  handler as well as on the happy path.
- Every run **audits itself**.

Proven live: an UPDATE is refused before, two keys are redacted, an UPDATE and a DELETE are
both refused afterwards. Neither admin, dispatcher nor rider can call it — `EXECUTE` is revoked
from `PUBLIC` as well as `authenticated`, because Postgres grants to `PUBLIC` by default and
revoking from one role alone does nothing. `mint_otp` taught this codebase that in Phase 4a.

The audit log itself is **not purged**. Seven years is longer than this system has existed, so
nothing is due, and when a purge is eventually needed it should be a deliberate documented
operation rather than a job that runs at 3am.

---

## 7. What the reports will not tell you

**On-time rate** renders as:

```
on-time rate   not available   no promised window is set on any order (Q8 — Grocery sends none)
```

`lib/delivery/ingest.ts:172` reads a `promised_window` that is absent from every real Grocery
payload, so `promised_to` is null on every delivery. A plausible-looking zero would be acted
on; a stated gap will not be. **Rider utilisation** is absent for the same kind of reason — it
needs shift data this system does not hold.

---

## 8. What is still not true

1. **Q4.** `hold_confirmed` has been false since Phase 2. The new `holds.expire` job now warns
   before a hold lapses, which is the most this side can do — commit and release remain records
   rather than controls until Inventory can confirm a hold.
2. **Q8.** No promised window, so no on-time rate and no SLA.
3. **Q11.** No proof store. Retention deletes the rows it would otherwise unlink.
4. **The worker is not deployed anywhere.** It runs; nothing runs it. That is a hosting
   decision (Q15), and the health check now makes forgetting it visible instead of silent.
5. **Still verified against a stub for the customer half.** Grocery
   [PR #1](https://github.com/MrMandalShubham/Grocery/pull/1) and
   [PR #2](https://github.com/MrMandalShubham/Grocery/pull/2) are open; migration 002 unrun.
6. **No alerting.** The health endpoint says it; nothing watches the endpoint. There is still
   no notification provider anywhere in this estate.

---

## 9. Definition of done

- [x] 312/312 tests; `npm run check` green
- [x] `db:verify` 11/11; typecheck and build clean
- [x] **No plaintext delivery code exists anywhere in the database**
- [x] A direct write cannot reintroduce one
- [x] All four jobs run, record their outcome, and hold an advisory lock
- [x] **An overdue job fails the deep health check, by name and by seconds** — proven live
- [x] The expected-migration count can no longer go stale unnoticed
- [x] Retention anonymises rather than deletes, and leaves reports working
- [x] An open delivery is never anonymised, however old
- [x] The audit log is redacted in four named keys and **remains append-only**
- [x] Neither purge nor redaction is reachable by any signed-in user
- [x] A rider can read no report
- [x] On-time rate states its gap rather than inventing a number
- [x] No Grocery or Inventory file changed

---

## 10. Result

# PASS

The system runs itself, says so when it stops, forgets on schedule, and can be asked how it is
doing. The customer's one-time code is no longer written down anywhere.

V1 is feature-complete against [scope §6](../01-logistics-scope.md). What remains is not
logistics code: two Grocery PRs to merge, one migration to run, somewhere to run the worker,
and two questions for other teams — **Q4** (confirming an inventory hold) and **Q8** (a
promised delivery window).

**Phase 8 is the V2 line** — automatic assignment, batching, ETA prediction, live maps, COD.
None of it should start before the three systems have run together in production for a while.
