# Phase 7 — Scheduling, Retention and Reports · Analysis

**Date:** 2026-09-13 · **Status:** proposed, **awaiting approval before any code is written**
**Owner:** Lead Agent
**Depends on:** [Phase 6 verification](phase-6-verification.md) ·
[Scope §7–8](../01-logistics-scope.md) · [Open questions](../03-open-questions.md)

---

## 0. The finding: the OTP is in a journal, in plaintext, forever

Phases 4a and 4b spent considerable effort on one property: **a rider never learns the
customer's code from this system.** `delivery.delivery_otp` stores only a SHA-256 hash, its
RLS policy is literally `using (false)` so nobody can read the table at all, and `mint_otp` has
`EXECUTE` revoked from `PUBLIC` and from `authenticated` so a rider cannot call it.

Then the offline sync journal writes the code down:

```
select action, payload from integration.rider_event where action='complete';

 complete | {"otp":"000000"}
 complete | {"otp":"000000"}
```

`integration.rider_event.payload` is the raw event body a phone sent, kept indefinitely, and
its read policy admits anyone with `deliveries:read` — every admin and every dispatcher — plus
the rider themselves.

### How bad, stated accurately

Not a live credential. By the time a row exists the code has been consumed or rejected, and it
expires in fifteen minutes regardless. The rider typed it, so they already knew it.

What it actually is: **a customer's one-time code, persisted in cleartext with no expiry, in a
table whose careful sibling stores only hashes.** It gives staff a permanent list of codes
against deliveries and names, it survives every retention rule we are about to write, and it
makes the "we never store the code" claim untrue. It should not be there.

**Fix:** redact `otp` out of the payload on write, keeping `{"otp":"******"}` so the journal
still records *that* a code was submitted and a replay still recognises the event. Plus a
one-off pass over existing rows.

The same applies to `integration.inbound_event.payload`, which keeps the raw Grocery order
including the customer's name, phone and address — that one is retention rather than redaction,
because a replay genuinely needs it.

---

## 1. Objective

The system currently depends on somebody remembering to run three commands. Phase 7 makes it
run on its own, makes it say so when it does not, stops it hoarding personal data forever, and
gives an operator the numbers the scope document has been promising since Phase 0.

---

## 2. Q29: three jobs nobody schedules

| Job | Today | What happens when it does not run |
|---|---|---|
| `expire:assignments` | `npm run` by hand | An unanswered offer holds a delivery in `ASSIGNED` looking dispatched while nobody carries it |
| `outbound:drain` | `npm run` by hand | No commit to Inventory, no status to Grocery. The customer's page freezes and the ledger stays silent |
| hold expiry | **does not exist** — there is an index and a comment | A rider is sent to a shop for stock whose hold lapsed |

Phase 6 was asked not to add a fourth. Retention would be the fourth. So this phase builds the
thing that runs all of them.

### 2.1 Shape — the decision I want

| | Approach | Notes |
|---|---|---|
| **A** *(recommended)* | One always-on worker process, `npm run worker`, running each job on its own interval | Q15's default, and Inventory's `webhook-worker.mjs` header already documents why: serverless is billed by wall-clock and killed mid-flight |
| B | OS cron / Task Scheduler entries | Nothing to write, and nothing to see. No record of a run, no way to ask "did it?" |
| C | In-app timers inside Next.js | Dies with a redeploy, multiplies with instances, and holds a pool per instance |

**A.** One process, one place to look, and it can be watched.

### 2.2 The part that matters more than the scheduler

A scheduler that silently stops is worse than no scheduler, because everything looks fine. So
every run writes to **`ops.job_run`** — job, started, finished, outcome, what it did — and the
health endpoint gains a check that fails when a job's last success is older than its interval
allows.

> "The drain has not succeeded for 41 minutes" is the sentence that makes this phase worth
> building. Without it, the first sign is a customer ringing about an order that says "packed"
> two days later.

Each job also takes a **Postgres advisory lock**, so running the worker twice — during a
deploy, or because somebody forgot — does not double-drain the queue.

---

## 3. Q12: retention

Defaults from the open-questions doc, with what I actually propose:

| Data | Default | Proposal |
|---|---|---|
| `fleet.rider_location` | 30 days | **Delete.** A named worker's movement trace, and 30 days is already generous |
| `delivery.delivery_proof` | 90 days | Delete rows; there is no store yet (Q11), so nothing to unlink |
| `delivery.delivery_address` | purge 180 days after terminal | **Anonymise, do not delete** — see below |
| `delivery.delivery_item` | not specified | Anonymise `name` at the same time; keep `sku` and `quantity` for reports |
| `integration.inbound_event.payload` | not specified | **Redact after 180 days** — it holds the whole order, address included |
| `integration.rider_event.payload` | not specified | **Redact the OTP immediately** (§0); redact the rest at 180 days |
| `ops.notification.payload` | not specified | Redact at 180 days |
| `ops.audit_log` | 7 years | **Do not purge in V1** — see below |

### 3.1 Anonymise rather than delete

Deleting `delivery_address` would cascade nothing but would silently break every report that
joins to it and every historical question of the form "which pincodes fail most often".
Blanking the name, phone, address lines and instructions while keeping the pincode and a
coarse geohash keeps the operational history and removes the person.

A deleted row also loses the fact that a delivery *had* an address, which is the difference
between "we removed personal data on schedule" and "this record is broken".

### 3.2 The audit log cannot be purged, and I propose leaving it that way

`ops.audit_log` has `ops.refuse_mutation()` triggers on UPDATE **and DELETE**. Purging it means
disabling a trigger that exists specifically to make the log trustworthy.

Seven years is longer than this system has existed, so nothing is due. I propose V1 does not
build an audit purge at all, and that when one is eventually needed it is a deliberate,
documented, admin-only operation rather than a job that runs at 3am.

Two audit rows do contain PII in their `before`/`after` JSON — ingest and address changes. I
propose the retention job redacts *those specific keys* via a definer function that the trigger
permits, rather than opening the table generally. **This is the one place I want a clear yes**,
because it is a deliberate hole in an append-only table, however narrow.

### 3.3 Dry run first

The purge refuses to run without `--confirm` on its first invocation for a given day, and
`--dry-run` prints counts per table. A retention job is the one piece of scheduled work that
destroys data on purpose; it should be boring to inspect before it is trusted.

---

## 4. Reports

Scope §8 lists twelve KPIs and AC-18 asks for a stuck-deliveries report. All of it is
computable from `delivery_status_history`, which is insert-only — so the numbers cannot drift
from what happened.

`/reports`, reading definer functions (the RLS trap, for the sixth time):

- **Stuck deliveries** (AC-18) — open, no transition for > 60 minutes, oldest first. The one
  that earns its place: it is the only report that tells you about a problem nobody has
  reported yet.
- **The funnel** — counts by status, today and this week.
- **Latencies** — assignment, pickup, delivery duration, as p50/p90 from the timeline.
- **Failures by reason**, **return rate**, **first-attempt success**.
- **Commit and release health** — verified, pending, failed. Target 100%, and the one number
  where anything less is a stock discrepancy.
- **Integration error rate** — dead-lettered ÷ total.

### What I cannot compute, and will say so on the page

**On-time rate.** It needs `promised_to`, which logistics accepts and **Grocery never sends** —
`lib/delivery/ingest.ts:172` reads a `promised_window` that is absent from every real payload,
so `promised_to` is null on every delivery. That is **Q8**, still open.

I propose the report shows the row with "no promised window is set on any order (Q8)" rather
than a plausible-looking zero. **Rider utilisation** is similarly out: it needs shift data
this system does not hold.

---

## 5. Scope

| # | Deliverable |
|---|---|
| 7.1 | `0012_operations.sql` — `ops.job_run`, retention functions, report functions, OTP redaction |
| 7.2 | **Redact the OTP from the rider-event journal**, going forward and retroactively |
| 7.3 | `scripts/worker.mjs` — the supervisor: intervals, advisory locks, a run journal |
| 7.4 | `scripts/expire-holds.mjs` — the job that was never written |
| 7.5 | `scripts/retention.mjs` — `--dry-run`, `--confirm` |
| 7.6 | Health check: a job whose last success is too old **fails** the deep check |
| 7.7 | `/reports` |
| 7.8 | `tests/phase7.test.mjs` (~35) |

### Out of scope

- **Proof photo storage (Q11).** Still no driver. Retention deletes the rows it would unlink.
- **Answering Q8** (promised windows) or **Q4** (hold confirmation). Both are other systems'.
- Alerting to a channel — there is no provider (same finding as Phase 5). The health endpoint
  says it; something else can watch the endpoint.
- Charts. Numbers in tables.

---

## 6. Security

| # | Risk | Mitigation |
|---|---|---|
| P7-01 | The OTP readable in the journal | §0 — redacted on write, and a one-off pass over what is there |
| P7-02 | A retention job deleting the wrong thing | `--dry-run` by default, counts per table, and it runs in one transaction per table |
| P7-03 | The audit log becoming editable | The purge is a narrow definer function that redacts named PII keys only; the triggers stay |
| P7-04 | Two workers double-draining | A Postgres advisory lock per job |
| P7-05 | A silently dead scheduler | `ops.job_run` plus a deep-health check that **fails** on staleness |
| P7-06 | Reports leaking across locations | Definer functions apply `ops.can_access_location` explicitly |

---

## 7. Tests (~35)

**Redaction (5)** — a completion event stores `******` not the code; the event still replays;
an existing row is redacted by the one-off pass; no other payload key is touched; the code is
absent from every table after a full delivery.

**The job journal (6)** — a run is recorded with its outcome; a failure is recorded as a
failure; staleness is detectable; the health check fails when a job is overdue and passes when
it is not; the advisory lock prevents a second run.

**Retention (10)** — each rule deletes or anonymises what it should and nothing else; a
delivery keeps its pincode and loses its recipient; `--dry-run` changes nothing; a terminal
delivery younger than the window is untouched; the audit redaction touches only named keys; the
audit triggers still refuse a plain DELETE afterwards.

**Reports (10)** — stuck deliveries appear after the threshold and not before; latencies match
a hand-computed timeline; failures group by reason; commit health counts verified separately
from pending; on-time rate reports **"not available (Q8)"** rather than a number; location
scoping holds; a rider cannot read any of it.

**Regression (4)** — the expiry jobs still behave as Phases 3 and 4 proved; the drain is
unchanged; redaction does not break offline replay.

---

## 8. Verification

Run the worker for a few minutes against a seeded database and show `ops.job_run` filling in;
kill it mid-drain and show the advisory lock released and the job recovered; stop it and watch
the deep health check go from pass to fail with the sentence naming the job.

Then a retention dry run against deliveries backdated past each window, followed by a real run,
with before/after counts — and a query proving no OTP remains anywhere in the database.

---

## 9. Open questions

| # | Status |
|---|---|
| **Q29** | Answered by this phase |
| **Q12** | Answered by this phase — **subject to §3.2**, the audit-log hole |
| **Q8** | Open, and it is what makes on-time rate uncomputable |
| **Q4** | Open, and still the reason commit and release are records rather than controls |
| **Q11** | Open — no proof store |
| **Q15** | Taking the default: a separate always-on worker, never serverless |

---

## Approval requested

1. **§0** — redact the OTP from the rider-event journal, retroactively as well as going forward.
2. **§2.1** — one always-on worker process (**A**), with `ops.job_run` and a health check that
   fails on staleness.
3. **§3.1** — anonymise the delivery address snapshot rather than deleting it.
4. **§3.2** — **the one I want an explicit yes on**: a narrow, definer-only redaction of named
   PII keys inside `ops.audit_log`, with the append-only triggers otherwise untouched. Saying
   no is a reasonable answer; it means those rows keep an address for seven years.
5. **§4** — the on-time rate renders as "not available (Q8)" rather than a zero.
6. That **proof storage (Q11) stays out** and Phase 8 takes it with the V2 work.
