# Phase 1 — Logistics Foundation · Verification

**Date:** 2026-09-12 · **Status:** **PASS** · **Owner:** Lead Agent
**Analysis:** [`phase-1-analysis.md`](phase-1-analysis.md)

This records what was actually run and what actually happened. Where it disagrees with the
analysis document, **this is what was built.**

---

## 1. Commands executed

| Command | Result |
|---|---|
| `npm install` | 44 packages, **0 vulnerabilities** |
| `npm run db:up` | container `logistics-pg` on `:55433`, ready |
| `npm run db:migrate` | 4 migrations applied |
| `npm run db:reset` | schemas dropped, 4 re-applied from empty |
| `npm run db:verify` | **8/8 checks passed** |
| `npm test` | **41 tests, 41 pass, 0 fail** |
| `npm run check` (`db:reset && test`) | **PASS** |
| `npx tsc --noEmit` | **exit 0**, no errors |
| `npm run build` | **PASS** — 7 routes compiled |
| `npm run admin:create` | admin created, temporary password issued once |
| `npm run key:mint` | `lg_live_…` minted, returned once |
| `npm run locations:sync` (no key) | seeded 4 from fixture, `source=SEED` |
| `npm run locations:sync` (live Inventory) | **fetched 3 from Inventory**, `source=INVENTORY` |
| Manual HTTP smoke | 12 scenarios, all as specified |

---

## 2. Test results

```
ℹ tests 41
ℹ suites 9
ℹ pass 41
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ duration_ms 1331.4246
```

| Suite | Tests | Covers |
|---|---|---|
| passwords | 5 | verify, reject, salt uniqueness, length floor, corrupt-hash tolerance |
| sign-in | 7 | session open, audit attribution, counter persistence, lockout, reset, suspension |
| sessions | 3 | resolve, revoke, expiry, unknown token |
| permissions and RLS | 7 | role matrix, audit isolation, self-only reads, privilege refusal, location scoping |
| audit log | 4 | UPDATE refused, DELETE refused, no insert policy, actor not forgeable |
| API keys | 5 | mint, never stored, authenticate, revoked/unknown indistinguishable, expiry |
| rate limit | 2 | bucket drains, unknown client refused not crashed |
| logging | 3 | secrets redacted, PII masked, deep nesting caught |
| external references | 3 | both systems registered, upsert idempotent, seed marked |

---

## 3. Database verification

```
PASS  schemas present  (identity, integration, ops)
PASS  RLS enabled on every table  (10 tables)
PASS  every RLS table has a policy  (9 tables)
PASS  audit log refuses UPDATE
PASS  audit log refuses DELETE
PASS  credential table is unreadable
PASS  external systems registered  (GROCERY, INVENTORY)
PASS  permissions seeded  (admin:7 dispatcher:3 rider:1)

8/8 checks passed
```

The RLS-coverage check is the one that earns its place: a table added in a later phase without
row-level security looks like every other `CREATE TABLE` in review, and silently exposes every
row. It is now a red build instead.

---

## 4. Three real defects found and fixed during implementation

These are recorded because each was caught by something built in this phase, and each would
have been expensive later.

### 4.1 The lockout could never have worked — and neither could the security log

**Found by:** the test *"five failures actually lock, and a CORRECT password is still refused"*.

`identity.open_session` raised an exception on a failed sign-in. Raising aborts the
transaction, and the rollback took the failure counter with it. Five wrong passwords left
`failed_count` at **zero**, so the account never locked — and the `auth.sign_in_failed` audit
rows were rolled back too, so **a brute-force attempt would have left no trace anywhere.**

This is the same class of bug Inventory named a migration after (`0023_lockout_actually_locks`),
arrived at by a different route.

**Fix:** a refusal is a normal outcome of signing in, not an exception. `open_session` now
*returns* `{ ok: false, code, message }` and commits, so the bookkeeping a refusal exists to
record survives it. The sign-in route branches on the result rather than catching.

**Regression test:** *"a failed attempt PERSISTS its counter and its audit row"*.

### 4.2 The audit log could not say who signed in

**Found by:** reading `ops.audit_log` after a live sign-in.

Sign-in is the one request with no claims yet — it is the request that creates them — so
`ops.audit()` saw no actor and wrote every authentication row as `actor_kind: SYSTEM`,
`actor_role: anon`, with **no correlation id.** The audit log could not answer the one question
those columns exist to answer.

```
 action          | actor_kind | actor_role | has_cid
-----------------+------------+------------+---------
 auth.signed_in  | SYSTEM     | anon       | f          <- before
 auth.signed_in  | USER       | admin      | t          <- after
```

**Fix:** `open_session` sets transaction-local claims for the row it has just identified,
before writing any audit entry, and the route passes the correlation id down. This is not a
forgery: the user has been identified by that point, and the claims are transaction-scoped.

**Regression tests:** *"the audit row NAMES the user who signed in"*, *"a failed attempt is
still attributed to the account"*.

### 4.3 `whoami` failed by looking like it worked

**Found by:** the live smoke test.

`/api/v1/whoami` exists to answer "is my key wired up?" It returned `key_prefix: null`,
`created_at: null`, `last_used_at: null` — because an API client holds no *permissions*, and
the RLS policy on `integration.api_client` required `keys:read`. The policy hid the row from
the very client it describes, and the handler's fallback masked it with a 200.

**Fix:** a policy letting a key read its own row and only its own:

```sql
create policy api_client_self on integration.api_client
  for select using (id = ops.current_client_id());
```

Also fixed: a stale `location_ref` row is now deactivated when Inventory stops listing it
(§6.3), so a dispatcher cannot be sent to collect from a closed shop.

---

## 5. Manual verification — HTTP

Against `npm run build && npm run start` on `:3200`.

| # | Scenario | Expected | Actual |
|---|---|---|---|
| 1 | `GET /api/health` (no auth) | 200 liveness | 200 `{"status":"ok",…}` |
| 2 | `GET /api/health?deep=1` (no auth) | 403 | **403** |
| 3 | `GET /api/health?deep=1` (admin) | 200 with checks | **200**, all checks present |
| 4 | `GET /api/v1/whoami` (valid key) | client detail | name, prefix `lg_live_3f87`, scopes, `last_used_at` |
| 5 | `GET /api/v1/whoami` (bogus key) | 401 | **401** `"That key is not valid."` |
| 6 | Rate-limit headers on **success** | present | `x-ratelimit-limit: 120`, `remaining: 118` |
| 7 | `POST /auth/sign-in` (temp password) | 200, `must_change_password: true` | as expected |
| 8 | `GET /auth/me` while must-change | **403** | **403** `password_change_required` |
| 9 | `POST /auth/password` while must-change | 200 | 200, *"Other sessions were signed out."* |
| 10 | Sign in with new password | 200 | 200, flag cleared |
| 11 | `GET /auth/me` after change | 200 with 7 permissions | as expected |
| 12 | `GET /api/v1/locations` | cached rows + `stale` flag | correct, `stale: true` on SEED |

Every response carried `X-Api-Version: v1` and `X-Correlation-Id`.

---

## 6. Integration verification — the part that matters

Phase 1's one outbound call was verified against a **real, running Inventory Core**, not a mock.

### 6.1 Inventory stood up locally

```
npm run db:up      -> inventory-core-db on :55432
npm run db:migrate -> 52 migrations, up to date
npm run dev        -> :3100
GET /api/health    -> {"ok":true, … "migrations_applied":52}
```

### 6.2 A correction to the Phase 0 analysis

The first sync attempt failed:

```
Inventory sync failed: This key does not hold the "catalog:read" scope.
The existing cache is unchanged.
```

`GET /api/locations` is guarded by **`catalog:read`**, not `stock:read` as recorded in the
Phase 0 analysis §9.2. Verified at source (`app/api/locations/route.ts:17`). **Corrected in
`00-existing-systems-analysis.md`, `phase-1-analysis.md` and `.env.example`.**

Note what the failure itself proved: the sync refused cleanly and **left the existing cache
intact**, which is the designed behaviour. Stale data beats an empty dropdown.

### 6.3 Real data, end to end

With a `catalog:read`-only key:

```
fetched 3 locations from Inventory
cached 3 locations (source: INVENTORY)
```

| code | external_location_id | name | type | source |
|---|---|---|---|---|
| HUB | `11111111-…-000000000001` | Central Warehouse | HUB | INVENTORY |
| SH1 | `11111111-…-000000000002` | Shop 1 — Andheri | STORE | INVENTORY |
| SH2 | `11111111-…-000000000003` | Shop 2 — Bandra | STORE | INVENTORY |

Two things this confirmed that a mock would not have:

- Inventory returns `type` lowercase (`"hub"`, `"store"`) and splits identity across
  `id` (the code) and `uuid` (the key). The client's `normalise()` handles both; written
  defensively, and it was needed.
- **The real estate has 3 locations, not the 4 in Grocery's `stores.ts`, and the names differ**
  (*Central Warehouse*, not *Central Hub*). This vindicates treating `stores.ts` as seed-only
  and Inventory as the source of truth.

Stale-row handling, verified by inserting a shop Inventory does not list:

```
fetched 3 locations from Inventory
deactivated 1 location(s) Inventory no longer lists
```

### 6.4 Deep health with both systems

```json
"inventory": { "ok": true,  "detail": "reachable",      "ms": 67 },
"grocery":   { "ok": false, "detail": "unreachable",    "ms": 13 }
```

Grocery was not running, and the check distinguishes **`unreachable`** from
**`not_configured`** — a real difference to whoever is on call at 2 a.m.

### 6.5 What was deliberately NOT built

No `confirm`, `commit` or `release` client methods exist yet. They arrive in Phase 2 **with
their callers**.

This is the single most important lesson from the Phase 0 analysis: Grocery *defines*
`commitInventory`, `releaseInventory` and `orderStatus` and calls **none** of them, which is
exactly why no stock is ever consumed anywhere in this estate. A method with no caller is a
promise nobody keeps, and it looks finished in review.

---

## 7. Permission verification

| Check | Result |
|---|---|
| admin holds 7 permissions | pass |
| dispatcher holds 3 | pass |
| rider holds 1 (`locations:read`) | pass |
| rider reads 0 audit rows | pass |
| admin reads audit rows | pass |
| rider sees only their own user row | pass |
| dispatcher cannot mint a key | pass (`FORBIDDEN_ROLE`) |
| dispatcher cannot create a user | pass (`FORBIDDEN_ROLE`) |
| nobody reads `identity.credential` | pass (`permission denied`, before RLS is consulted) |
| dispatcher bound to SH1 sees only SH1 | pass |
| admin bound to nothing sees all | pass |

---

## 8. Security notes

**Holding as designed**

- Session cookies are stored as SHA-256 only — asserted by test, not by convention.
- API keys likewise; the raw key matches no stored value.
- Unknown, revoked and expired keys return byte-identical 401s.
- Unknown email and wrong password return identical refusals, and cost the same time (the
  route runs scrypt against a dummy hash when the address is unknown).
- `identity.credential` is revoked **and** policy-denied — a policy mistake in a later
  migration still cannot expose hashes.
- The audit log refuses `UPDATE`/`DELETE` by trigger and has no insert policy for any role.
- Logs redact 18 secret-bearing keys and mask 7 personal fields, recursively.
- scrypt refuses to start below `N=16384`.
- No standing env-var admin. `admin:create` needs direct database access, issues a one-time
  password, and forces a change — explicitly rejecting the pattern Inventory's own
  `.env.example` documents as having no second factor, no work factor and no lockout.

**Accepted for now**

- No per-IP throttle on sign-in; per-account lockout only. Fine at this scale, revisit when
  the rider app is public (Phase 4).
- `DELETE` is granted to no role anywhere. Deliberate: nothing in logistics is deleted.

---

## 9. Known limitations

1. **No UI beyond a shell.** Deliberate — the dispatch board and rider app are Phases 3–4.
2. **Inventory returns no lat/lng.** `GET /api/locations` carries no coordinates, so pickup
   points have no geocode unless a seed supplied one. Grocery's `stores.ts` holds the only
   geocodes in the estate. **This will block map-based dispatch in Phase 3** — raised as
   **Q21** below.
3. **No self-elevation guard** (Q19) — deferred for a single-admin deployment. Role changes are
   audited with before/after.
4. **No CI workflow committed.** `npm run check` is the gate and runs locally; wiring it to a
   provider needs the repo to exist (Q20).
5. **No daily quota**, only per-minute limiting. No consumer needed one in Phase 1.
6. **Idempotency records are never pruned.** Harmless now; a sweep belongs with the Phase 2
   job schedule.
7. **Test fixtures persist** in the dev database after `npm test`. `npm run db:reset` clears
   them; production is unaffected.

---

## 10. New open question

**Q21 — Where do pickup coordinates come from?**
*Blocks: Phase 3 (map dispatch, rider routing)*

Inventory's location API returns no `lat`/`lng`, and `platform.location` has no such columns.
The only geocodes in the estate are four hard-coded pairs in Grocery's `src/config/stores.ts`.

| | Approach | Notes |
|---|---|---|
| **A** *(recommended)* | Inventory adds `lat`/`lng` to `platform.location` and returns them | One migration, one field pair. Locations are Inventory's to describe |
| B | Logistics holds coordinates against `location_ref`, edited by an admin | No change to Inventory; a second place a shop's address can be wrong |
| C | Geocode the address at sync time via a provider | A dependency and a cost for four rows that change once a year |

---

## 11. Definition of done

- [x] All tests pass — **41/41**
- [x] `db:verify` passes, including RLS-on-every-table — **8/8**
- [x] Typecheck and build clean
- [x] A human can sign in, see `/auth/me`, and be refused what their role forbids
- [x] An API key authenticates, is scope-checked and rate-limited
- [x] The audit log refuses mutation, proven by test
- [x] Shallow and deep health behave as specified
- [x] No secret appears in any log line, proven by test
- [x] `.env.example` documents every variable with its failure mode
- [x] **Verified against a real running Inventory, not a mock**
- [x] **No file in Grocery or Inventory modified** — `git status --porcelain` clean in both clones
- [ ] CI workflow committed — deferred with Q20 (no repository yet)

---

## 12. Result

# PASS

Phase 1 is complete. The foundation holds auth, roles, audit, idempotency, rate limiting,
health and logging, and it has a verified live connection to Inventory Core.

Three real defects were found and fixed, two of them by tests written in this phase. The
lockout bug in particular would have shipped a security control that did nothing and a security
log that recorded nothing — found before a single delivery exists, rather than after.
