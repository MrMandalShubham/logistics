# Phase 1 — Logistics Foundation · Analysis

**Date:** 2026-09-12 · **Status:** **approved and implemented** — see [`phase-1-verification.md`](phase-1-verification.md)
**Owner:** Lead Agent
**Depends on:** [`00-existing-systems-analysis.md`](../00-existing-systems-analysis.md) ·
[`04-architecture-proposal.md`](../04-architecture-proposal.md)

> **Approved 2026-09-12** with a direction to keep the system simple. The simplifications
> applied during implementation are listed in §0 and recorded in full in the verification
> report. Where this document and the verification report disagree, **the verification report
> is what was built.**

---

## 0. Simplifications applied at approval

The reviewer asked for a simpler system. These reduce moving parts without giving up any
security property:

| Planned | Built | Why it is safe |
|---|---|---|
| 8 migrations | **4** (`foundation`, `identity`, `integration`, `grants`) | Same objects, fewer files. Grants are last because a grant needs its table to exist |
| 5 roles (`admin`, `dispatcher`, `rider`, `support`, `viewer`) | **3** (`admin`, `dispatcher`, `rider`) | A role nobody is assigned to is a policy nobody tests. Adding one later is a single migration |
| bcrypt | **scrypt** from `node:crypto` | In the standard library — no native build on Windows, one fewer supply-chain dependency. Memory-hard, which is the property that matters. Parameters travel with the hash, so raising them later locks nobody out |
| Token bucket **+ daily quota** | Token bucket only | The quota had no consumer in Phase 1. Per-minute limiting is what stops a hot retry loop |
| Self-elevation guard needing a second admin | Deferred | Q19 — a single-admin deployment has no second admin to ask. Role changes are still audited with before/after |
| `lib/api/errors.ts`, `lib/auth/permissions.ts`, `lib/correlation.ts` as separate files | Folded into `handler.ts` and `logging.ts` | Three files that were each under thirty lines |

Unchanged: RLS on every table, append-only audit enforced by trigger, hashed sessions, hashed
API keys, mandatory idempotency on writes, redacted logging, and the one-time admin bootstrap.

---

## 1. Objective

Stand up the logistics service as a running, empty, **secure** system: a new repository, a new
database, authentication for humans and machines, the admin/dispatcher/rider role model,
external-reference plumbing, idempotency, an append-only audit log, health checks and
structured logging.

At the end of Phase 1 the system can prove who you are, refuse you when you are not allowed,
record that it did so, and tell an operator whether it is healthy. **It cannot yet accept an
order.** That is Phase 2, by design — this phase exists so that everything built afterwards
inherits auth, audit and idempotency rather than retrofitting them.

---

## 2. User value

No end-user value in this phase, and it would be dishonest to claim otherwise. The value is
to the team and to every later phase:

- A rider's credentials, a dispatcher's permissions and a partner's API key are enforced by
  one mechanism, written once, instead of three.
- Every state transition built in Phases 2–7 lands in an audit log that already exists and is
  already append-only.
- Every write built later is idempotent because the wrapper makes it so.
- An operator can answer "is logistics up, and is it talking to Inventory?" from day one.

---

## 3. Scope

| # | Deliverable | Detail |
|---|---|---|
| 3.1 | **Project structure** | New repo, Next.js 16 App Router, ESM, TypeScript strict, raw `pg`, numbered SQL migrations, `node --test` |
| 3.2 | **Logistics database** | Schemas `identity`, `integration`, `ops`. Migrations `0001`–`0008` |
| 3.3 | **Authentication (human)** | bcrypt credentials, sessions, lockout, sign-in / sign-out / me |
| 3.4 | **Authentication (machine)** | `lg_live_…` / `lg_test_…` keys, SHA-256 at rest, scoped, location-bound |
| 3.5 | **Roles & permissions** | `admin`, `dispatcher`, `rider`, `support`, `viewer` + a permission matrix enforced in the database |
| 3.6 | **External references** | `integration.external_system`, `integration.location_ref`, and a read-only location sync from Inventory |
| 3.7 | **Idempotency** | `integration.idempotency_record` + wrapper enforcement on every write |
| 3.8 | **Rate limiting** | Atomic per-key token bucket + daily quota (ported from Inventory `0034`/`0038`/`0039`) |
| 3.9 | **Audit** | `ops.audit_log`, append-only, enforced by trigger — not by convention |
| 3.10 | **Health checks** | `GET /api/health` shallow (liveness) and deep (DB, migrations, clock, Inventory reachability) |
| 3.11 | **Logging** | Structured JSON, `correlation_id` on every line, redaction of secrets and PII |
| 3.12 | **Admin bootstrap** | A one-time script that creates the first admin with a forced password change |
| 3.13 | **Tests & CI** | `tests/phase1.test.mjs`, harness, `npm run check` gate, CI workflow |

### 3.8 note — why rate limiting is in Phase 1 and not Phase 2

The API-key auth path exists from this phase onward, and a sign-in endpoint without throttling
is a brute-force target on day one. Porting Inventory's proven design now means every route
added later is protected by default. Inventory needed three migrations (`0034`, `0038`, `0039`)
to get the token bucket atomic and its burst sensible; we take the finished version.

---

## 4. Out of scope

Stated explicitly so the boundary is not eroded:

- **Any delivery entity.** No `delivery`, no `delivery_address`, no `delivery_item`. Phase 2.
- **Any rider operational profile.** `fleet.rider`, shifts, availability, location. Phase 3.
- **Assignment, dispatch, the state machine.** Phases 3–4.
- **Inbound order ingest.** Phase 2.
- **Outbound event queue and webhook worker.** Phase 2 (inbound) / Phase 5 (outbound).
- **Admin UI screens and the rider PWA.** Phases 3 and 4. Phase 1 ships route-group shells
  with a sign-in page and nothing else behind it.
- **Anything Grocery or Inventory owns.** No catalogue, stock, pricing, cart, checkout,
  payment or customer account code. Ever.
- **COD, batching, routing, ETA.** V2.

---

## 5. Existing systems affected

| System | Effect in Phase 1 |
|---|---|
| **Grocery** | **None.** No code read at runtime, no call made, no credential held |
| **Inventory** | **One read-only call**: `GET /api/locations` with a scoped key, to populate the location cache (3.6). No write of any kind |

**Prerequisite this creates:** an Inventory admin must mint one `ic_live_…` key scoped
**`catalog:read` only** for Phase 1. `GET /api/locations` is guarded by `catalog:read`,
not `stock:read` — verified against the running system, and corrected from the Phase 0
analysis. `reservations:write` is not needed until Phase 2 and should not be granted yet — least privilege, and it keeps the blast radius of a Phase 1
leak to "someone can list shop names". Tracked as **Q16**.

If that key is not available at build time, the location cache seeds from a fixture derived
from Grocery's `src/config/stores.ts` (HUB, SH1, SH2, SH3) and the deep health check reports
`inventory: not_configured` rather than failing. The system still runs.

---

## 6. Logistics modules affected

All new. Nothing to regress.

| Module | Status |
|---|---|
| `identity` | created |
| `integration` | created |
| `ops` | created |
| `delivery` | **not created** — Phase 2 |
| `fleet` | **not created** — Phase 3 |

---

## 7. Files to change

Every file is new, in a **new repository**. **No file in Grocery or Inventory is touched.**

```
logistics/
├── package.json                     scripts: dev, build, start, lint, typecheck,
│                                    db:up/down/migrate/reset/verify, test, check,
│                                    key:mint, admin:create, locations:sync
├── tsconfig.json  next.config.mjs  eslint.config.mjs  postcss.config.mjs
├── .env.example                     annotated, in Inventory's house style
├── .github/workflows/ci.yml
│
├── app/
│   ├── api/
│   │   ├── health/route.ts               shallow + ?deep=1
│   │   └── v1/
│   │       ├── auth/sign-in/route.ts
│   │       ├── auth/sign-out/route.ts
│   │       ├── auth/me/route.ts
│   │       └── whoami/route.ts           API-key identity echo
│   ├── (admin)/layout.tsx  sign-in/page.tsx   shell only
│   ├── (rider)/layout.tsx                     shell only
│   └── layout.tsx  globals.css
│
├── lib/
│   ├── db.ts                        pg pool, pooler-aware
│   ├── api/handler.ts               the wrapper: auth → limit → scope → idempotency → RLS
│   ├── api/errors.ts                pg + app error → HTTP mapping
│   ├── auth/password.ts             bcrypt hash/verify, cost from env
│   ├── auth/session.ts              cookie issue/verify/rotate
│   ├── auth/permissions.ts          role → permission matrix (mirrors the DB)
│   ├── logging.ts                   structured JSON + redaction
│   └── correlation.ts               correlation id in/out
│
├── supabase/migrations/
│   ├── 0001_foundation.sql          schemas, extensions, claims helpers, role enum
│   ├── 0002_audit.sql               ops.audit_log, append-only trigger
│   ├── 0003_identity.sql            app_user, credential, session, lockout
│   ├── 0004_permissions.sql         permission matrix + has_permission()
│   ├── 0005_api_clients.sql         api_client, authenticate_api_key, scopes
│   ├── 0006_idempotency.sql         idempotency_record
│   ├── 0007_rate_limit.sql          atomic token bucket + daily quota
│   └── 0008_external_refs.sql       external_system, location_ref
│
├── scripts/
│   ├── migrate.mjs  db-config.mjs  db-up.mjs  db-down.mjs  db-reset.mjs
│   ├── db-verify.mjs                invariant checks, Inventory-style
│   ├── admin-create.mjs             one-time bootstrap, forced password change
│   ├── key-mint.mjs                 mint an lg_live_ key
│   ├── locations-sync.mjs           read-only pull from Inventory
│   └── api-smoke.mjs
│
└── tests/
    ├── harness.mjs
    └── phase1.test.mjs
```

**Ported from Inventory with attribution** (noted in each file header):
`migrate.mjs`, `db-config.mjs`, `db-up/down/reset.mjs`, `tests/harness.mjs`, the
`lib/api/handler.ts` pipeline shape, the `api_client` / `authenticate_api_key` design, the
`idempotency_record` design, and the token-bucket migrations.

---

## 8. Database changes

New database. No migration of existing data, because there is none.

### 0001 — foundation

Schemas `identity`, `integration`, `ops`. Extensions `pgcrypto`, `citext` in `extensions`,
placed on the search path (Inventory's `0043` lesson). Claims helpers, mirroring Inventory so
the two systems read alike:

```sql
ops.current_claims()      -> jsonb     from request.jwt.claims
ops.current_actor_id()    -> uuid
ops.current_role_name()   -> text
ops.current_client_id()   -> uuid      null for a human session
ops.current_correlation() -> text
```

### 0002 — audit (created **before** anything it audits)

```sql
create table ops.audit_log (
  id             bigint generated always as identity primary key,
  occurred_at    timestamptz not null default now(),
  actor_id       uuid,                       -- null for system/unauthenticated
  actor_role     text,
  actor_kind     text not null check (actor_kind in ('USER','API_CLIENT','SYSTEM')),
  action         text not null,              -- 'auth.signed_in', 'api_key.minted', …
  entity_type    text,
  entity_id      text,
  before         jsonb,
  after          jsonb,
  reason         text,
  correlation_id text,
  ip             inet,
  user_agent     text
);
```

Append-only is **enforced**, not documented:

```sql
create trigger audit_log_immutable
  before update or delete on ops.audit_log
  for each row execute function ops.refuse_mutation();
```

`ops.refuse_mutation()` raises `AUDIT_IMMUTABLE`. This is the difference between an audit log
and a table that happens to contain history.

### 0003 — identity

```sql
create table identity.app_user (
  id            uuid primary key default gen_random_uuid(),
  email         citext not null unique,
  full_name     text not null,
  phone         text,
  role          text not null check (role in
                  ('admin','dispatcher','rider','support','viewer')),
  status        text not null default 'ACTIVE'
                  check (status in ('ACTIVE','SUSPENDED','DISABLED')),
  location_codes text[] not null default '{}',   -- empty = all, for staff only
  must_change_password boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table identity.credential (
  user_id       uuid primary key references identity.app_user(id) on delete cascade,
  password_hash text not null,                   -- bcrypt
  failed_count  integer not null default 0,
  locked_until  timestamptz,
  rotated_at    timestamptz not null default now()
);

create table identity.session (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references identity.app_user(id) on delete cascade,
  token_hash    text not null unique,            -- SHA-256 of the cookie value
  issued_at     timestamptz not null default now(),
  expires_at    timestamptz not null,
  last_seen_at  timestamptz,
  device_label  text,
  revoked_at    timestamptz,
  ip            inet,
  user_agent    text
);
```

**The session token is never stored.** Only its SHA-256. A database leak does not hand over
live sessions.

Functions: `identity.sign_in(email, password, ip, ua)`, `identity.sign_out(token)`,
`identity.resolve_session(token)`, `identity.set_password(user_id, password)`,
`identity.create_user(...)` (admin only).

**Lockout:** 5 consecutive failures → locked 15 minutes, counter resets on success.
Inventory learned this the hard way — its `0023` is literally titled *"lockout actually
locks"* — so the test suite asserts the lock, not just the counter.

**`identity.app_user.role = 'rider'`** is created here. The *operational* rider profile
(`fleet.rider`: vehicle, shifts, availability) is Phase 3. Separating login identity from
fleet profile means a rider who leaves keeps an auditable identity while losing all access.

### 0004 — permissions

A table, not a hard-coded list, so a permission change is a migration with an audit trail:

```sql
create table identity.role_permission (
  role       text not null,
  permission text not null,
  primary key (role, permission)
);

identity.has_permission(p_permission text) returns boolean   -- reads current claims
```

Phase 1 permission set (later phases insert their own rows):

| Permission | admin | dispatcher | rider | support | viewer |
|---|:--:|:--:|:--:|:--:|:--:|
| `system:health:deep` | ✓ | ✓ | | ✓ | ✓ |
| `audit:read` | ✓ | | | ✓ | |
| `users:read` | ✓ | ✓ | | ✓ | |
| `users:write` | ✓ | | | | |
| `keys:read` | ✓ | | | | |
| `keys:write` | ✓ | | | | |
| `locations:read` | ✓ | ✓ | ✓ | ✓ | ✓ |

A rider holds almost nothing in Phase 1. That is correct — a rider's permissions are about
*their own assigned task*, which does not exist yet.

### 0005 — API clients

Inventory's design, renamed:

```sql
create table integration.api_client (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  key_hash       text not null unique,         -- SHA-256
  key_prefix     text not null,                -- 'lg_live_abc…' for display
  scopes         text[] not null,
  location_codes text[] not null default '{}', -- empty = all (deliberate, as Inventory 0020)
  environment    text not null default 'LIVE' check (environment in ('LIVE','SANDBOX')),
  rate_limit_per_min integer not null default 120,
  daily_quota    integer,
  status         text not null default 'ACTIVE' check (status in ('ACTIVE','REVOKED')),
  expires_at     timestamptz,
  created_at     timestamptz not null default now(),
  last_used_at   timestamptz
);
```

`integration.authenticate_api_key(key)` → claims jsonb, or null. **Unknown, revoked and
expired are deliberately indistinguishable** — same as Inventory, and for the same reason.

Scope vocabulary defined now, used later: `orders:ingest`, `deliveries:read`,
`deliveries:write`, `riders:read`, `riders:write`, `reports:read`, `*`.

### 0006 — idempotency

```sql
create table integration.idempotency_record (
  api_client_id uuid not null references integration.api_client(id) on delete cascade,
  key           text not null,
  method        text not null,
  path          text not null,
  request_hash  text not null,
  status_code   integer not null,
  response_body jsonb not null,
  created_at    timestamptz not null default now(),
  primary key (api_client_id, key)
);
```

Same key + same body → the original response replayed. Same key + **different** body → `422
idempotency_key_reused`. Telling the client is far kinder than handing back an answer to a
question it did not ask.

### 0007 — rate limit

Atomic token bucket per client, plus an optional daily quota, in a single indexed `UPDATE`.
Ported from Inventory `0034` + `0038` + `0039` (the later two being the fixes that made it
atomic and gave it a sensible burst). Charged **after** authentication and **before** scope
checking and body parsing, so a client in a hot retry loop costs one row update.

### 0008 — external references

```sql
create table integration.external_system (
  code       text primary key,          -- 'GROCERY', 'INVENTORY'
  name       text not null,
  base_url   text,
  status     text not null default 'ACTIVE',
  notes      text
);

create table integration.location_ref (
  code                 text primary key,        -- 'HUB','SH1','SH2','SH3'
  external_location_id uuid,                    -- Inventory platform.location.id
  name                 text not null,
  type                 text not null,           -- HUB|STORE|WAREHOUSE|VIRTUAL
  lat                  numeric(9,6),
  lng                  numeric(9,6),
  is_active            boolean not null default true,
  synced_at            timestamptz,
  source               text not null default 'INVENTORY'
                         check (source in ('INVENTORY','SEED'))
);
```

`location_ref` is a **cache, not a source of truth** — the column comment says so, and
`source = 'SEED'` marks rows that came from the `stores.ts` fixture rather than from Inventory.
`locations:sync` refreshes it; it never writes back.

### RLS

Enabled on **every** table. Policies read `ops.current_role_name()` /
`identity.has_permission()`. The rule adopted from Inventory: an API client and the admin UI
traverse the *same* path — `authenticated` role, claims set, RLS applied. There is no
privileged route.

`ops.audit_log` has a `SELECT` policy gated on `audit:read`, and **no** `INSERT`/`UPDATE`/
`DELETE` policy for anyone — rows are written only by `SECURITY DEFINER` functions.

---

## 9. APIs

| Method | Path | Auth | Permission / scope | Purpose |
|---|---|---|---|---|
| `GET` | `/api/health` | none | — | Liveness. Process + pool only. Never touches business tables |
| `GET` | `/api/health?deep=1` | session **or** key | `system:health:deep` | DB reachable, migrations at expected version, clock skew, Inventory reachability, pool stats |
| `POST` | `/api/v1/auth/sign-in` | none (throttled) | — | email + password → `Set-Cookie` session |
| `POST` | `/api/v1/auth/sign-out` | session | — | revoke the session |
| `GET` | `/api/v1/auth/me` | session | — | identity, role, resolved permissions, locations |
| `GET` | `/api/v1/whoami` | key | any | client name, scopes, locations, environment, rate limit |

`/api/v1/whoami` exists because Inventory's integration guide has an *"Is it wired up?"*
section and it is the single most useful endpoint an integrator hits first. Cheap to build,
saves a support conversation every time.

**Response conventions** (matching Inventory): `X-Api-Version: v1` on every response;
`X-RateLimit-Limit` / `-Remaining` on every keyed response, not only on a 429; errors as
`{ "error": { "code", "message" } }`; success bodies carry `as_of`.

**Error mapping:** `42501 → 403`, `P0002 → 404`, `23505 → 409`, `23514 → 409`, `23503 → 422`,
unmapped → 500. Named Postgres exceptions (`LOCKED_OUT:`, `AUDIT_IMMUTABLE:`) surface their
code to the client.

---

## 10. Events

**No outbound events are published in Phase 1.** The queue is Phase 2.

Internal audit actions established here — the vocabulary later phases extend:

```
auth.signed_in           auth.sign_in_failed      auth.locked_out
auth.signed_out          auth.session_expired     auth.password_changed
user.created             user.role_changed        user.suspended
user.reactivated
api_key.minted           api_key.revoked          api_key.used_first_time
location.synced          system.migrated
```

**Naming rule:** `entity.past_tense_verb`, matching Inventory's `stock.changed` /
`movement.closed`. Agreed now because renaming an event vocabulary after integrators depend on
it is a major version.

---

## 11. Permissions

Covered as a matrix in §8 (`0004`). The enforcement rules:

1. **The database is the enforcement point.** `lib/auth/permissions.ts` mirrors the matrix for
   the UI only; a mismatch fails a test.
2. **A hidden button is not a control.** Every route re-checks server-side.
3. **Staff location scoping:** `location_codes` empty means all locations **for staff**. For
   API clients, empty also means all — deliberately, as in Inventory `0020`, because a key is
   minted in one deliberate admin act. These two "empty means all" rules are documented
   together so the asymmetry is a decision rather than an accident.
4. **Admin cannot self-elevate silently.** A role change writes an audit row with before/after
   and cannot be applied to your own account without a second admin (Inventory's `0047`
   self-approval lesson).

---

## 12. Security risks

| # | Risk | Mitigation in this phase |
|---|---|---|
| S-01 | Credential stuffing / brute force on sign-in | Lockout after 5 failures for 15 min; per-IP throttle; constant-ish response time; failures audited |
| S-02 | Session theft | Token never stored (SHA-256 only); `HttpOnly`, `Secure`, `SameSite=Lax`; short TTL with rotation; revocable; device label recorded |
| S-03 | Session fixation | A new session id is issued on every sign-in; never reuse a supplied id |
| S-04 | API key leakage | SHA-256 at rest; only `key_prefix` ever displayed or logged; revocable; expiry supported; `last_used_at` makes a stale key visible |
| S-05 | Timing attack on key lookup | Lookup is by hash equality on an indexed column, not a scan; unknown/revoked/expired are one response |
| S-06 | **Audit tampering** | `UPDATE`/`DELETE` refused by trigger; no write policy for any role; writes only via `SECURITY DEFINER` |
| S-07 | RLS gap on a new table | `db-verify` asserts **every** table in all three schemas has RLS enabled and at least one policy. A new table without RLS fails CI |
| S-08 | Secrets in logs | Redaction allowlist in `lib/logging.ts`: never log `authorization`, `cookie`, `password`, `token`, `signature`, `key_hash`. Test asserts it |
| S-09 | PII in logs | Phase 1 holds staff email only. The redactor is built now so Phase 2's customer data lands in an already-safe logger |
| S-10 | Weak bcrypt cost | Cost from env, **minimum 12**, refuses to start below it. No env-var admin password (explicitly rejecting Inventory's `0044` pattern — its own `.env.example` calls out that it has no second factor, no work factor and no lockout) |
| S-11 | Admin bootstrap becomes a standing backdoor | `admin:create` is a one-time script requiring direct DB access. It sets `must_change_password = true` and creates no env-based standing credential |
| S-12 | Over-scoped Inventory key | Phase 1 requests **`catalog:read` only**. `reservations:write` is granted in Phase 2, not now |
| S-13 | Pool exhaustion / DoS via slow auth | One pooled connection per request (Inventory's hard-won rule — it once measured 3.5 s on its hottest endpoint from taking five); rate limit charged before body parsing |
| S-14 | Clock skew breaking future signature checks | Deep health reports skew now, so Phase 2's 300 s HMAC window is not debugged blind |

---

## 13. Tests

`tests/phase1.test.mjs`, against a reset database, run by `npm run check`.

**Migrations**
1. All migrations apply from empty.
2. Re-running the runner is a no-op (idempotent).
3. `db-verify` passes: every table has RLS + ≥1 policy; expected schemas exist; no orphaned grants.

**Human auth**
4. Sign-in with correct credentials issues a session and audits `auth.signed_in`.
5. Wrong password fails, increments the counter, audits `auth.sign_in_failed`.
6. **Five failures actually lock**, and a *correct* password is still refused while locked.
7. Counter resets on success.
8. Lock expires after the window.
9. Expired session is refused.
10. Revoked session is refused.
11. Session token is absent from the database in plaintext (assert by query).
12. `must_change_password` blocks every route except password change.
13. Suspended user cannot sign in.

**Machine auth**
14. Valid key authenticates; `whoami` echoes scopes and locations.
15. Unknown, revoked and expired keys return **identical** 401 bodies.
16. Missing scope → 403 naming the required scope.
17. `last_used_at` updates.

**Idempotency**
18. Same key + same body replays the original response with `Idempotent-Replay: true`.
19. Same key + different body → 422 `idempotency_key_reused`.
20. Missing key on a write → 400.
21. **Concurrent** identical requests produce exactly one execution.

**Rate limit**
22. Limit is enforced; 429 carries `Retry-After`.
23. Headers present on **successful** responses too.
24. Daily quota exhaustion is distinguishable from per-minute throttling.

**Permissions / RLS**
25. Each role sees only its permitted rows, asserted per role.
26. A rider cannot read the audit log.
27. A dispatcher cannot mint a key.
28. An admin cannot change their **own** role unaided.
29. Location-scoped staff see only their locations' `location_ref` rows.

**Audit**
30. `UPDATE` on `ops.audit_log` raises `AUDIT_IMMUTABLE`.
31. `DELETE` raises `AUDIT_IMMUTABLE`.
32. No role holds an insert policy on it.
33. Every audited action writes actor, role, kind and correlation id.

**Health / logging**
34. Shallow health returns 200 with the DB stopped — it is liveness, not readiness.
35. Deep health reports `database`, `migrations`, `clock_skew_ms`, `inventory`.
36. Deep health requires the permission.
37. Deep health reports `inventory: not_configured` (not an error) when no key is set.
38. Correlation id supplied in a header appears on every log line and in the response.
39. One is generated when absent.
40. **No secret appears in any log line** — driven by a table of secret-bearing inputs.

**External references**
41. `locations:sync` populates `location_ref` from a mocked Inventory response.
42. Sync is idempotent; re-running changes only `synced_at`.
43. Sync failure leaves the previous cache intact and reports the failure.
44. Seeded rows are marked `source = 'SEED'`.

---

## 14. Verification commands

```bash
npm run db:reset            # drop, recreate, migrate, seed
npm run db:migrate          # apply migrations (asserts idempotent re-run)
npm run db:verify           # RLS + invariant checks
npm run lint
npm run typecheck
npm test                    # tests/phase1.test.mjs
npm run check               # db:reset && test  — the gate
npm run build
npm run api:smoke           # health, sign-in, whoami, 401/403/429 paths
npm run locations:sync      # against Inventory, or a fixture
```

CI runs: `lint → typecheck → db:reset → test → build`. A failure in any step fails the phase.

---

## 15. Rollback strategy

Phase 1 is the cheapest rollback the project will ever have: **nothing depends on it yet, and
it holds no business data.**

| Scenario | Action |
|---|---|
| Bad deploy | Redeploy the previous image. No schema coupling to other systems |
| Bad migration | Forward-fix. Migrations are forward-only, as in Inventory. Each carries a documented `-- DOWN:` note in its header for a manual reversal |
| Total abandonment | `npm run db:down` — drop the three schemas. Grocery and Inventory are entirely unaffected, having never been touched |
| Leaked Inventory key | Revoke it in Inventory's `api-keys` screen. It holds `stock:read` only, so the exposure is a list of shop names |
| Leaked logistics key | `api_key.revoke`; audit shows `last_used_at` and every request made |

**Data loss risk: none.** There is no data whose loss matters until Phase 2.

---

## 16. Open questions for this phase

Blocking questions Q1–Q4 from
[`03-open-questions.md`](../03-open-questions.md) **do not block Phase 1** — they block Phase 2
and Phase 5. Phase 1 proceeds regardless. New ones:

| # | Question | Default if unanswered |
|---|---|---|
| **Q16** | Who mints the Inventory `ic_live_…` key (`catalog:read` only), and where is it stored? | Seed `location_ref` from the `stores.ts` fixture; deep health reports `inventory: not_configured` |
| **Q17** | Session TTL and bcrypt cost. | Session 12 h for staff, 7 days for riders with rotation on use; bcrypt cost 12, floor enforced |
| **Q18** | Hosting target — Vercel + Supabase, matching Inventory? | Assume yes. Use the **pooler** connection string, never the IPv6-only direct host |
| **Q19** | Is a second admin available for the self-elevation guard (§11.4), or is a break-glass path needed on a single-admin deployment? | Guard active; `admin:create` is the break-glass path, and it is audited |
| **Q20** | Repository name and git host for the new logistics repo. | `MrMandalShubham/Logistics`, matching the sibling repos |

---

## 17. Definition of done

- [ ] All 44 tests pass; `npm run check` green
- [ ] `db:verify` passes, including the RLS-on-every-table assertion
- [ ] Lint, typecheck and build clean
- [ ] A human can sign in, see `/api/v1/auth/me`, and be refused what their role forbids
- [ ] An API key authenticates, is scope-checked, rate-limited and idempotent
- [ ] The audit log refuses mutation, proven by test
- [ ] Shallow and deep health both behave as specified
- [ ] No secret appears in any log line, proven by test
- [ ] `.env.example` documents every variable with its failure mode
- [ ] `phase-1-verification.md` written with real command output
- [ ] **No file in Grocery or Inventory modified** — verified by `git status` in both clones

---

## Approval requested

Phase 1 will not begin until this document is approved.

**Please confirm:**

1. **Scope** as in §3, and the exclusions in §4 — in particular that Phase 1 ships **no
   delivery entity and no UI beyond a sign-in shell**.
2. **Rate limiting in Phase 1** rather than Phase 2 (§3.8).
3. **The one outbound call to Inventory** for the location cache, and the request for an
   `ic_live_…` key scoped **`catalog:read` only** (§5, Q16).
4. **Rejecting the env-admin pattern** in favour of a one-time bootstrap script (S-11).
5. **Q17–Q20**, or agreement to proceed on the stated defaults.
