# Phase 8 — V2 Unblockers · Verification

**Date:** 2026-09-13 · **Status:** **PASS** · **Owner:** Lead Agent
**Analysis:** [`phase-8-analysis.md`](phase-8-analysis.md)

---

## 1. Commands

| Command | Result |
|---|---|
| `npm run db:reset` | **13** migrations from empty |
| `npm run db:verify` | **11/11** |
| `npm test` | **345 tests, 345 pass, 0 fail** |
| `npx tsc --noEmit` | clean |
| `npm run build` | PASS — `/locations` added |
| `npm run live:phase8` | ranking and serviceability, before and after |

```
ℹ tests 345        (312 from Phases 1–7, 33 added)
ℹ pass 345
ℹ fail 0
```

| Suite | Covers |
|---|---|
| distance (3) | two known points; zero from itself; **a missing geocode is NULL, never zero** |
| setting a shop's coordinates (9) | marked as ours; a sync keeps the name and leaves the geocode; Inventory wins if it ever supplies one; a seed never outranks a real value; range checks; **a swap caught by distance**; forcing, and the force recorded; the first shop has nothing to compare against; only `locations:write`; every change audited with its previous value |
| ranking riders (9) | nearest first with a reason; a stale position is not a position; an idle rider ranks on HOME; **a rider with nothing known is ranked last, never dropped**; unavailable riders excluded; at-capacity listed with the reason and ranked below; no coordinates means no distance; riders cannot see it; **ranking never blocks a manual assignment** |
| serviceability (7) | in and out of range; **"cannot tell" is not "out of range"**; an out-of-range order is **still ingested**; it reaches the exception queue; in-range raises nothing; flagging is idempotent |
| regression (5) | ingest works with no geography at all; unset shops are shown rather than hidden; a rider may read locations but not change one |

---

## 2. Live: the same board, before and after

```
── before anybody set a geocode ──
  1. RDR-L8A   Asha Menon        — km  HOME  based at this shop, 0 of 5 in hand, idle 0 min
  2. RDR-L8C   Cal Dias          — km  HOME  based at this shop, 0 of 5 in hand, idle 0 min
  3. RDR-L8B   Bo Lin            — km  NONE  no recent position, 0 of 5 in hand, idle 0 min
  serviceability: unknown — SH1 has no coordinates, so range cannot be checked (Q21)

set SH1 (Andheri) to 19.1136, 72.8697
set SH2 (Bandra)  to 19.0596, 72.8295

── with coordinates, and Cal a street away ──
  1. RDR-L8C   Cal Dias       0.21 km  LIVE  0.21 km away, last seen just now, 0 of 5 in hand
  2. RDR-L8A   Asha Menon        — km  HOME  based at this shop, 0 of 5 in hand, idle 0 min
  3. RDR-L8B   Bo Lin            — km  NONE  no recent position, 0 of 5 in hand, idle 0 min
  serviceability: in — 1.24 km from SH1, within 10.0 km
```

Two things in that worth noticing. Ranking **degrades rather than disappears** without
coordinates — it falls back to home shop and load, which is still better than alphabetical.
And the em dash in the km column is deliberate: a rider whose distance is unmeasured shows
nothing there, never a zero.

`npm run live:phase8` reproduces it.

---

## 3. The check that a range check cannot do

The analysis said swapped coordinates were the mistake to catch. My first attempt was a range
check with a confident error message — and it did not work, because **72.87 is a perfectly
legal latitude.** It is in the Arctic Ocean. Nothing about the number is wrong.

What *is* detectable is that it would put the shop thousands of kilometres from every other
shop in the estate:

```
IMPLAUSIBLE_LOCATION: 72.8295, 19.0596 is 6836 km from the nearest shop this system
knows. Latitude and longitude entered the wrong way round give exactly this.
```

That catches a swap, a dropped minus sign and a fat-fingered digit alike, without hardcoding a
country into a schema. It **refuses** rather than warns, because a server-side function
returning a caveat nobody reads is the same as no check; a genuinely distant shop is set with
`force`, and the force is recorded in the audit row.

Two limits, stated: the **first** shop has nothing to be implausible against, and a typo that
lands within 500 km is not caught. Both are tested so the gap is visible rather than assumed
away.

---

## 4. An out-of-range order is still an order

```
── an order from Pune, 120 km away ──
  serviceability : out — 123.05 km from SH1, which is beyond the 10.0 km this shop serves
  delivery status: RECEIVED   (ingested anyway, on purpose)
  flagged        : OUT_OF_SERVICE_RANGE (WARNING) — 123.05 km from SH1 …
```

Grocery already took the money and reserved the stock. An order that reached us is not one
logistics may quietly drop because a radius says so — that leaves a customer paid up with no
parcel and nobody told. It flags, Phase 6's queue carries it to a person, and that person can
ring somebody.

`unknown` is kept distinct from `out` throughout. Until a shop has coordinates we genuinely
cannot tell, and saying "out of range" would be inventing a fact.

---

## 5. The bug the tests found

A rider based at the pickup shop was reported as **0 km away** — even when the shop had no
coordinates at all.

```sql
-- before
when r.home_location_code = d.pickup_location_code then 0
```

"Based at this shop" is an excellent reason to rank somebody first. It is not a *measured*
distance, and reporting it as one claims we know exactly where they are when we do not know
where the shop is. The preference now lives in the `position_source` tier; `distance_km` stays
null unless something was actually measured.

This is the same class of mistake as `distance_km` returning 0 for a missing geocode, which the
function was already written to avoid — it had simply crept back in one line away.

---

## 6. The rule this phase changed on purpose

`integration.location_ref` has carried one comment since Phase 1:

> CACHE of Inventory locations. Never a source of truth; refreshed by `locations:sync`, never
> written back.

That stays true of names, types and ids. It is now false of coordinates, and the comment says
so:

> Names, types and ids are a CACHE of Inventory and are never written back. Coordinates and
> service radius are LOCAL: Inventory has no such field (Q21) and geography is not its fact to
> own.

`geo_source` records which of four things a coordinate is — `NONE`, `LOCAL` (an admin typed
it), `INVENTORY` (the sync supplied one, which has never happened), `SEED` (development
fallback). The ordering is enforced: **Inventory wins over local if it ever provides one, and a
seed never overwrites either.** All three are tested.

The old `upsert_location_ref` already refused to overwrite a geocode with NULL, but reset
`source` on every run — so an admin's coordinates would have been relabelled as Inventory's on
the next sync. `sync_location` replaces it and `locations:sync` now calls that.

---

## 7. What Phase 8 deliberately did not build

Per §3 of the analysis, and worth restating so it reads as a decision rather than an omission:

- **Automatic assignment.** Ranking with reasons first. A scoring function nobody has watched
  make a decision is not one to hand the wheel to, and the dispatcher knows things the database
  does not — who is finishing a shift, whose bike is playing up.
- **ETA prediction and rider scoring.** Both need history. Every delivery so far is synthetic;
  a model fitted to data I generated would be confidently wrong in a way nobody notices until a
  customer is told 20 minutes and waits 50.
- **Batching and routing.** Needs `max_concurrent > 1` as an operational decision and a routing
  provider.
- **Live maps, signature capture, COD, rider payout.** Providers and models that do not exist.

---

## 8. What is still not true

1. **Nothing is deployed.** `DEPLOYMENT.md` is new and says what to run and what to watch; no
   host is running it.
2. **Grocery still lists four shops to Inventory's three.** `SH3` (Dadar) exists in Grocery's
   `stores.ts` and not in Inventory, so a customer choosing it would fail at reserve. That
   predates logistics and is not ours to fix, but the seed now marks it rather than quietly
   creating a shop that cannot fulfil anything.
3. **Q4** — Inventory cannot confirm a hold. Commit and release stay records rather than
   controls.
4. **Q8** — Grocery sends no promised window, so there is no on-time rate and no ETA to
   measure against.
5. **Q11** — no proof store; photos and signature capture blocked together.
6. **Both Grocery PRs are open** and migration 002 is unrun.
7. **A rider's position is only known during a delivery.** That is Phase 4a's rule and it
   stands, which is exactly why ranking needs the HOME and NONE tiers.

---

## 9. Definition of done

- [x] 345/345 tests; `npm run check` green
- [x] `db:verify` 11/11; typecheck and build clean
- [x] A shop's coordinates can be set, are audited, and survive a sync
- [x] Inventory's value wins if it ever appears; a seed never outranks a real one
- [x] **A missing geocode is null everywhere — never 0, never "out of range"**
- [x] Swapped coordinates are refused with a reason, and can be forced with a record
- [x] Riders are ranked with the reason attached, and ranking degrades without coordinates
- [x] **Ranking never blocks a manual assignment**
- [x] An out-of-range order is ingested and flagged, never dropped
- [x] A rider may read locations and may not change one
- [x] `DEPLOYMENT.md` says what to run, what to watch, and what 503 means
- [x] No Grocery or Inventory file changed

---

## 10. Result

# PASS

The shops have a location. Four V2 features that could not be started now can be, dispatch is
materially better today, and an order nobody can deliver is visible before a rider is sent.

**V1 is complete and Phase 8's unblockers are in.** What remains is not more code: deploy it,
merge the two Grocery PRs, run one migration, and let real orders accumulate. ETA prediction,
rider scoring and batching all want that history, and building them without it would produce
numbers that look authoritative and are not.

Two questions stay with other teams — **Q4** (confirming an inventory hold) and **Q8** (a
promised delivery window). Neither is a logistics build, and both cap what this system can
honestly claim until they are answered.
