# Logistics Core

Delivery operations for the Grocery + Inventory estate — the system that takes an order which
is already paid for and already reserved in inventory, and is accountable for it from the shop
shelf to the customer's hand, including when that fails.

**Status: Phase 4 complete (4a + 4b).** An order enters through a signed front door, is verified
against Inventory's stock hold, reaches a dispatcher's queue, is assigned to a rider who
collects it, and is handed over against a one-time code the rider never sees — after which
**the sale is finally written to Inventory's ledger**, verified rather than assumed. The rider
app works with no signal: work is captured to an outbox and replayed in the order it happened,
and when two accounts of the same doorstep disagree a person is told. Customer-facing status
is Phase 5.

---

## Where it sits

```
  GROCERY  ──── delivery-ready orders ───►  LOGISTICS  ──── status ───►  GROCERY
 storefront                                   (here)
     │                                          │
     │ reserve (at checkout)                    │ confirm (on ingest)
     │                                          │ commit  (on delivery)
     ▼                                          ▼ release (on return)
            ┌──────────────────────────────────────────────┐
            │  INVENTORY CORE — system of record for stock  │
            └──────────────────────────────────────────────┘
```

Logistics is the only system that calls `commit`. Grocery reserves; logistics consumes or
returns. That division closes a loop which is currently open in production — see
[the analysis](docs/logistics/00-existing-systems-analysis.md) §14.

**Logistics owns** delivery records, dispatch, riders, proof of delivery, exceptions, returns
and delivery audit history.
**It does not own** the catalogue, stock, pricing, the cart, checkout, payment, or customer
accounts. It stores read-only snapshots and external identifiers, never a second copy of a
fact another system maintains.

---

## Running it

Requires Node 20+ and Docker.

```bash
npm install
cp .env.example .env
npm run db:up          # Postgres on :55433
npm run db:migrate
npm run locations:sync # seeds from a fixture if Inventory is not configured
npm run admin:create -- "you@example.com" "Your Name"
npm run dev            # :3200
```

`admin:create` prints a temporary password **once** and forces a change at first sign-in.

### Connecting to Inventory

Mint a key on the Inventory deployment, as an admin. Logistics needs `catalog:read` (for
`GET /api/locations`) and `stock:read` (to verify an order's stock hold at ingest). It does
**not** need `reservations:write` until Phase 4 — nothing here writes to Inventory:

```sql
select api_key from platform.create_api_client(
  'Logistics Core', ARRAY['catalog:read','stock:read'], '{}', 'LIVE');
```

Put it in `.env` as `INVENTORY_API_KEY`, set `INVENTORY_API_URL`, then:

```bash
npm run locations:sync
```

Unset is a supported state: the cache falls back to a fixture, rows are marked `source=SEED`,
and deep health reports `inventory: not_configured`.

---

## Commands

| Command | Does |
|---|---|
| `npm run dev` | development server on `:3200` |
| `npm run build` / `start` | production build and serve |
| `npm run check` | **the gate** — `db:reset && test` |
| `npm test` | 211 tests |
| `npm run db:verify` | RLS coverage, audit immutability, seed invariants |
| `npm run db:up` / `db:down` / `db:reset` | local Postgres lifecycle |
| `npm run locations:sync` | refresh the pickup-point cache from Inventory |
| `npm run admin:create` | one-time administrator bootstrap |
| `npm run key:mint` | mint an `lg_live_…` API key |
| `npm run demo:order` | post a signed delivery-ready order (`--no-address` to see the rejection) |
| `npm run expire:assignments` | return offers no rider answered (`--dry-run`, `--loop 30`) |
| `npm run outbound:drain` | commit delivered orders to Inventory (`--show`, `--loop 5`) |

---

## API

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/health` | none | liveness — stays 200 even if the database is down |
| `GET /api/health?deep=1` | session/key | readiness: DB, migrations, clock skew, Grocery, Inventory |
| `POST /api/v1/auth/sign-in` | none | email + password → session cookie |
| `POST /api/v1/auth/sign-out` | session | revoke |
| `GET /api/v1/auth/me` | session | identity, role, permissions |
| `POST /api/v1/auth/password` | session | change password; revokes other sessions |
| `GET /api/v1/whoami` | key | is my key wired up, and what does it hold? |
| `GET /api/v1/locations` | either | cached pickup points |
| `POST /api/v1/integration/orders.delivery-ready` | key + HMAC | receive a delivery-ready order |
| `GET /api/v1/deliveries` | either | the queue |
| `GET /api/v1/deliveries/:id` | either | snapshot, items, timeline |
| `POST /api/v1/deliveries/:id/admit` | session | RECEIVED → READY_FOR_ASSIGNMENT |
| `POST /api/v1/deliveries/:id/cancel` | session | terminal, reason required |
| `GET /api/v1/deliveries/hold-expiry` | either | holds about to lapse |
| `GET /api/v1/integration/inbound-events` | session | every arrival, accepted or not |
| `POST /api/v1/integration/inbound-events/:id/retry` | session | replay a stored payload |
| `GET /api/v1/dispatch` | either | the board: waiting, riders, in flight |
| `GET`/`POST` `/api/v1/riders` | session | list / onboard a rider |
| `POST /api/v1/riders/:id/availability` | session | online / offline |
| `POST /api/v1/deliveries/:id/assign` | session | offer it to a rider |
| `POST /api/v1/deliveries/:id/reassign` | session | move it, reason required |
| `POST /api/v1/deliveries/:id/accept` · `/decline` | rider | answer your own offer |
| `GET /api/v1/deliveries/:id/assignments` | session | every attempt, superseded included |
| `POST /api/v1/deliveries/:id/otp` | session | issue the customer's code, shown once |
| `GET /api/v1/me` · `/me/tasks` · `/me/tasks/:id` | rider | my jobs |
| `POST /api/v1/me/tasks/:id/step` | rider | collect → collected → on my way → arrived |
| `POST /api/v1/me/tasks/:id/complete` | rider | `{ otp }` — the handover |
| `POST /api/v1/me/tasks/:id/fail` | rider | `{ reason_code }` |
| `POST /api/v1/me/tasks/:id/location` · `/contact` | rider | ping while carrying · reveal the phone, audited |
| `POST /api/v1/me/sync` | rider | replay what the phone captured offline |

Screens: `/deliveries`, `/deliveries/:id`, `/dispatch`, `/riders` for staff;
`/me` and `/me/tasks/:id` for riders.

Every response carries `X-Api-Version` and `X-Correlation-Id`. Keyed responses carry
rate-limit headers — on success, not only on a 429.

---

## How it is built

Postgres-first, following Inventory Core's conventions (the better-engineered of the two
existing systems). Business rules live in `SECURITY DEFINER` functions behind row-level
security; the HTTP layer authenticates, sets claims, and delegates.

```
app/api/        route handlers
lib/            db, logging, auth, the request wrapper, Grocery + Inventory clients
db/migrations/  0001 foundation · 0002 identity · 0003 integration · 0004 grants
                0005 delivery · 0006 inbound · 0007 fleet · 0008 execution
                0009 offline
scripts/        migrate, verify, admin bootstrap, key mint, location sync
tests/          phase1 + phase2 suites, shared harness
docs/logistics/ analysis, scope, integration contract, open questions, phase reports
```

**Roles:** `admin`, `dispatcher`, `rider`. Permissions live in a table, so granting one is a
migration with a diff and an audit trail.

**Things worth knowing:**

- The audit log is append-only, enforced by trigger. `UPDATE` and `DELETE` raise
  `AUDIT_IMMUTABLE`, and no role holds an insert policy — rows arrive only via `ops.audit()`,
  which reads the actor from the claims so it cannot be forged.
- Session cookies and API keys are stored as SHA-256 only. A database backup is a list of
  hashes, not a set of live logins.
- Passwords use scrypt from `node:crypto` — no native build, no extra dependency. The process
  refuses to start below `N=16384`.
- A sign-in refusal is **returned, not raised**. Raising would roll back the failure counter
  and the audit row, so the account would never lock and a brute-force attempt would leave no
  trace. [Verification §4.1](docs/logistics/phase-reports/phase-1-verification.md).
- `db:verify` asserts every table has RLS **and** a policy, so a table added without them is a
  red build rather than a silent leak.
- Nothing is deleted. `DELETE` is granted to no role: a cancelled delivery is a terminal
  state, a departed rider is deactivated, and an audit row is forever.
- A delivery's address and items are **snapshots**, never edited. Grocery owns the customer
  address; two editable copies means the stale one eventually wins.
- A refused inbound order is **stored, not dropped**. Fix it at source and an admin replays it.
- Status changes go through one database function. A route cannot make a move the state
  machine forbids, and every move writes a timeline row and an audit row in the same
  transaction.
- A rider holding `deliveries:respond` may act on **their own offer only** — ownership is
  checked in the database, not the route, and tested with a second rider.
- At most one live assignment per delivery, enforced by a partial unique index. Two
  dispatchers racing produce one winner and one clean conflict, not two riders at one door.
- Reassignment inserts a new attempt and supersedes the old one. "Who was asked first" is the
  question a complaint turns on.
- **The rider never sees the delivery code.** Refused at the route, at the function, and by a
  revoked grant — a code the rider can read is a code they can use without meeting anybody.
- **A commit to Inventory is verified, not believed.** Its endpoint reports success for a
  released hold exactly as for a consumed one, so every commit is followed by a read; a
  released hold raises a CRITICAL exception instead of recording a sale that never happened.
- A delivery completes regardless of Inventory's health. The parcel is at the door; the
  bookkeeping retries.
- Offline work is replayed in **capture** order, and `delivered_at` is when the rider
  delivered it — not when the phone found signal.
- **An unanswered event never leaves the outbox.** A dropped event is a delivery nobody can
  account for; a duplicate is a request the server already knows how to ignore.
- Last-write-wins is never applied to a terminal state. A completion that arrives after a
  reassignment raises a CRITICAL conflict for a person.

---

## Documentation

| Document | What it is |
|---|---|
| [Existing systems analysis](docs/logistics/00-existing-systems-analysis.md) | 22 sections on Grocery and Inventory, read at source, with an evidence index |
| [Logistics scope](docs/logistics/01-logistics-scope.md) | owned vs not owned, journeys, V1/V2, acceptance criteria, KPIs |
| [Integration contract](docs/logistics/02-integration-contract.md) | identifiers, auth, payloads, versioning, event catalogue |
| [Open questions](docs/logistics/03-open-questions.md) | 15 questions with options and recommendations |
| [Architecture proposal](docs/logistics/04-architecture-proposal.md) | components, state machine, failure modes |
| [Phase reports](docs/logistics/phase-reports/) | per-phase analysis and verification |

---

## Before Phase 3

Delivery intake is built and tested, but **no real order can flow through it yet.** Four
questions remain, and the first cannot be answered from this side:

- **Q1** — no order in the estate carries a delivery address. The checkout form's inputs are
  uncontrolled and discarded, `orders` has no `address_id`, and `addresses` has no geocode.
  Nothing can be dispatched until this is fixed in Grocery.
  **Specified:** [Grocery change spec](docs/logistics/05-grocery-change-spec-q1.md) — covers
  Q1, Q2 and Q4 in one pass, roughly a day of work.
- **Q2** — the fulfilment shop lives only in a browser cookie, never on the order.
- **Q3** — may Grocery be modified additively (address capture, a status receiver)?
- **Q4** — how does logistics obtain the per-line `reservation_id`s needed to stop a hold
  expiring mid-delivery?

Plus **Q21**, raised during Phase 1 verification: Inventory returns no coordinates for its
locations, which will block map-based dispatch in Phase 3.

---

Built with [Claude Code](https://claude.com/claude-code) (Claude Opus 5).
