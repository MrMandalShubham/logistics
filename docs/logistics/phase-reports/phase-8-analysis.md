# Phase 8 — V2 · Analysis

**Date:** 2026-09-13 · **Status:** proposed, **awaiting approval before any code is written**
**Owner:** Lead Agent
**Depends on:** [Phase 7 verification](phase-7-verification.md) ·
[Scope §6](../01-logistics-scope.md) · [Open questions](../03-open-questions.md)

---

## 0. What I went to check, and what I found

V1 is feature-complete. Scope §6 lists nine things for V2. I costed each of them against what
this estate actually has, and the result is worth reading before choosing what Phase 8 is:

**Seven of the nine are blocked on something logistics cannot build**, and four of those are
blocked on the *same* thing — **nobody in this estate knows where the shops are.**

```
$ curl .../api/locations
HUB Central Warehouse   lat= None  lng= None
SH1 Shop 1 — Andheri    lat= None  lng= None
SH2 Shop 2 — Bandra     lat= None  lng= None
```

`integration.location_ref` has had `lat` and `lng` columns since Phase 1. They have been null
since Phase 1, because the only thing that fills them is a sync from Inventory, and Inventory
has no such field. That is **Q21**, open since Phase 0.

The only geocodes in the estate are four hard-coded pairs in Grocery's `src/config/stores.ts` —
and they list `SH3`, which does not exist in Inventory. So the one source is also wrong.

---

## 1. The nine V2 items, honestly costed

| # | V2 item | Blocked on | Buildable now? |
|---|---|---|:--:|
| 1 | Automatic assignment | **Q21** — no shop coordinates, so "nearest rider to the pickup" has no pickup | no |
| 2 | Rider scoring | Completed-delivery history. There is none: every delivery so far is synthetic | no |
| 3 | Batching + route optimisation | **Q21**, `max_concurrent` defaulting to 1, and a routing provider that does not exist | no |
| 4 | ETA prediction | Historical latencies. `latency_percentiles()` works and has nothing real to chew on | no |
| 5 | Live map to the customer | A map provider, continuous location (deliberately not collected), and Grocery PR #2 merged | no |
| 6 | Signature capture | **Q11** — the same missing proof store that blocks photos | no |
| 7 | COD + cash reconciliation | A real payment model. Grocery's checkout sets `status: 'PAID'` from the browser | no |
| 8 | Logistics-owned delivery zones | **Q21** | no |
| 9 | Rider incentives and payout | Payroll. Not this system, and should not become this system | no |

That is not a reason to stop. It is a very clear statement of what Phase 8 has to be about if
it is to be worth building: **the unblockers, not the features.**

### The one that would change the most

Q21. Shop coordinates unlock items 1, 3 and 8 outright and are a precondition for 4.

And it is genuinely *ours* to fix. "Where does a rider collect from" is a logistics fact, not
an inventory fact. Inventory owns stock; it has never claimed to own geography. Logistics
already has the columns and the admin surface.

The catch, stated plainly: `location_ref` is documented as **"CACHE of Inventory locations.
Never a source of truth; refreshed by locations:sync, never written back."** Letting an admin
type coordinates into it makes part of that row locally-owned. That is a real change to a rule
this system has kept for seven phases, and §3.1 is where I ask about it.

---

## 2. The other thing Phase 8 should probably be

**Nothing is deployed.** The worker runs when somebody types `npm run worker`; no host runs it.
Both Grocery PRs are open; migration 002 is unrun. The three systems have never exchanged a
real order.

Phase 7's health check makes that visible rather than silent, which is the right state to be
in — but it does mean every number in `/reports` is currently describing test data, and items
2 and 4 above stay blocked for exactly as long as that remains true.

---

## 3. Three honest shapes for Phase 8

| | Shape | What you get | What it costs |
|---|---|---|---|
| **A** *(recommended)* | **Unblock and land it** — Q21 coordinates, assignment *suggestions* (dispatcher still decides), deployment notes, and the operational gaps | Items 1, 3, 8 become buildable; dispatch gets materially better today; real data starts accumulating | No headline V2 feature ships |
| B | **Build V2 against synthetic data** — automatic assignment, ETA, scoring | Feels like progress | Every model is fitted to data I generated. ETA and scoring would be confidently wrong, and wrong in a way nobody notices until a customer is told 20 minutes and waits 50 |
| C | **Stop at V1** — deploy, run, revisit in a month | The most information per unit of work | Nothing new is built now |

**A.** It is the version of Phase 8 that is still true in six weeks.

### 3.1 The decision I want on Q21

| | Approach | Notes |
|---|---|---|
| **A** *(recommended)* | Logistics owns pickup coordinates. An admin sets them; `locations:sync` keeps name and type from Inventory and **stops overwriting lat/lng** | Honest about who owns what. Needs the cache comment rewritten, deliberately |
| B | Ask Inventory to add lat/lng to `/api/locations` | Correct in the long run, and not something I can do or schedule |
| C | Copy Grocery's `stores.ts` | Four values, one of which (`SH3`) names a shop Inventory does not have. Copying wrong data into a second place is how estates end up with three answers |

**A**, with **B** as the thing to raise with whoever owns Inventory. If they add the field
later, sync can prefer it and the admin value becomes the fallback.

### 3.2 Assignment: suggestions, not automation

Even with coordinates, I would not ship automatic assignment in Phase 8.

What I propose instead: the dispatch board **ranks** available riders — distance to the
pickup, current load, how long they have been idle — and shows why. The dispatcher still
clicks. That is genuinely useful on day one, it is the thing you would have to build anyway
before automating, and it produces the record you would need to check whether automation would
have chosen well.

Automating the click is a small change once the ranking has been watched for a while. Doing it
first means trusting a scoring function nobody has ever seen make a decision.

---

## 4. Scope, if A

| # | Deliverable |
|---|---|
| 8.1 | `0013_geography.sql` — locally-owned pickup coordinates, distance helpers, rider ranking |
| 8.2 | Admin screen to set and see a location's coordinates, with an audit row per change |
| 8.3 | `locations:sync` keeps name/type from Inventory, **never clobbers a locally-set geocode** |
| 8.4 | Dispatch board ranks riders and **says why** — distance, load, idle time |
| 8.5 | Serviceability: is this address within range of the shop that is fulfilling it? Flagged at ingest, not refused |
| 8.6 | `DEPLOYMENT.md` — the worker as an always-on process, what health to watch, what to alert on |
| 8.7 | `tests/phase8.test.mjs` (~30) |

### Out of scope, and why

- **Automatic assignment** — §3.2. Ranking first.
- **ETA and rider scoring** — no history. Revisit after real orders.
- **Batching and routing** — needs `max_concurrent > 1` as a deliberate operational decision, and a routing provider.
- **Live maps, signature capture, COD, payout** — providers and models that do not exist.
- **Actually deploying** — that is your infrastructure and your credentials, not a code change.

---

## 5. Security

| # | Risk | Mitigation |
|---|---|---|
| P8-01 | A wrong geocode sends riders to the wrong building | Changes are audited with before/after and who; the admin screen shows the current value and its source |
| P8-02 | A stale local geocode silently overriding a correct Inventory one | `source` already distinguishes them; sync prefers Inventory's value **if it ever provides one** |
| P8-03 | Ranking leaking rider positions to a wider audience | Ranking returns a distance band, not coordinates; `deliveries:assign` still required |
| P8-04 | Serviceability becoming a silent refusal | It **flags**, never rejects. An order Grocery accepted is not one logistics may quietly drop |

---

## 6. Tests (~30)

**Geography (8)** — a locally-set geocode survives a sync; Inventory's value wins if one ever
appears; a bad latitude is refused; every change is audited; distance is right for known pairs;
a location without coordinates is reported as such rather than treated as 0,0.

**Ranking (10)** — nearest first; a rider at capacity is excluded with a reason; an
unavailable rider is excluded; ties break on idle time; the reason is returned with each row; a
rider without a recent position is ranked last rather than dropped; no coordinates means no
ranking and an honest message; a dispatcher without `deliveries:assign` gets nothing; riders
cannot see each other's rankings.

**Serviceability (6)** — inside and outside the radius; a missing shop geocode flags "cannot
tell" rather than "out of range"; an out-of-range order is **still ingested**; the flag reaches
the exception queue; the customer is not told.

**Regression (6)** — assignment, dispatch and the existing reports are unchanged; ranking never
blocks a manual assignment.

---

## 7. Verification

Set coordinates for the three real Inventory locations, ingest an order, and show the dispatch
board ranking riders by distance with the reason visible — then assign manually, as now, and
confirm nothing about the existing path changed.

Then a sync run, proving the locally-set geocode is still there afterwards.

---

## 8. Open questions

| # | Status |
|---|---|
| **Q21** | **Now the most valuable open question.** §3.1 |
| **Q4** | Open, Inventory's. Commit and release stay records rather than controls |
| **Q8** | Open, Grocery's. No promised window, so no ETA to compare against and no SLA |
| **Q11** | Open — blocks photos and signature capture together |
| **Q6** | COD deferred; it needs a payment model before it needs code |
| **Q15** | Deployment is a decision, not a build |

---

## Approval requested

1. **§3** — that Phase 8 is **A, the unblockers**, not a V2 feature build. If you would rather
   have a headline feature, say so and I will build the best version of it that synthetic data
   allows — but I would want the caveat written into the verification report.
2. **§3.1** — that **logistics owns pickup coordinates**, which means rewriting a rule
   `location_ref` has carried since Phase 1. Worth an explicit yes.
3. **§3.2** — ranking with reasons, not automatic assignment.
4. **§8.5** — serviceability **flags and never refuses**.
5. That **ETA, scoring and batching wait for real orders**, and that this is recorded as a
   sequencing decision rather than a gap.
