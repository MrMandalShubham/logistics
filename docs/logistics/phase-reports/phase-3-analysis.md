# Phase 3 — Admin Dispatch · Analysis

**Date:** 2026-09-12 · **Status:** proposed, **awaiting approval before any code is written**
**Owner:** Lead Agent
**Depends on:** [Phase 2 verification](phase-2-verification.md) ·
[Grocery change spec](../05-grocery-change-spec-q1.md)

---

## 0. Where this starts from

```
RECEIVED -> READY_FOR_ASSIGNMENT, CANCELLED
READY_FOR_ASSIGNMENT -> CANCELLED          <- the queue currently dead-ends here
ASSIGNED -> (terminal)                     <- declared in the enum, unreachable
ACCEPTED -> (terminal)
```

Permissions today: `admin` 12, `dispatcher` 5, `rider` **1** (`locations:read`). A rider can
see the shops and nothing else, which is correct — a rider's permissions are about *their own
assigned task*, and no task has ever been assigned.

Phase 3 makes `ASSIGNED` and `ACCEPTED` reachable and gives a dispatcher the screen to do it
from.

---

## 1. Objective

Turn a queue of admitted deliveries into work given to a named person: rider records,
availability, a dispatch board, manual assignment, reassignment, and the history of who was
asked and what they said.

At the end of Phase 3 a delivery can be **assigned to a rider and accepted by them**. The rider
still cannot pick anything up — that is Phase 4.

---

## 2. User value

The first phase whose output a human actually operates.

- A dispatcher sees what is waiting and who is free, and puts the two together.
- A rider who declines, or never answers, does not silently strand a parcel.
- "Who was asked, when, and what did they say" becomes answerable — including for the rider who
  was assigned and then swapped out.

---

## 3. Scope

| # | Deliverable | Detail |
|---|---|---|
| 3.1 | **Rider records** | `fleet.rider` — profile, vehicle, home location, active/inactive |
| 3.2 | **Rider identity** | links to the existing `identity.app_user` with role `rider` (built in Phase 1) |
| 3.3 | **Availability** | online / offline, with the transitions recorded |
| 3.4 | **Dispatch board** | admitted deliveries on one side, available riders on the other |
| 3.5 | **Manual assignment** | dispatcher picks a rider; the delivery becomes `ASSIGNED` |
| 3.6 | **Accept / decline** | rider responds; decline carries a reason and returns it to the queue |
| 3.7 | **Accept timeout** | an unanswered assignment returns to the queue by itself |
| 3.8 | **Reassignment** | dispatcher moves a delivery to another rider, with a reason |
| 3.9 | **Assignment history** | every attempt, superseded ones included, on the delivery timeline |
| 3.10 | **Rider management UI** | create, activate, deactivate, see current load |
| 3.11 | **Admin status view** | delivery detail gains the assignment panel and working buttons |
| 3.12 | **Tests** | `tests/phase3.test.mjs` |

### Simplifications proposed

| Full design | Phase 3 | Why |
|---|---|---|
| `rider_shift` (rostering) | **dropped** | Availability is a toggle. Rostering matters when there are enough riders to schedule, and nothing in Phase 3 reads a shift |
| `rider_location` | **dropped** | It is captured *during an active delivery*, which begins at `PICKED_UP` — Phase 4 |
| Two migrations (fleet + assignment) | **one** (`0007_fleet.sql`) | Assignment is meaningless without riders; they ship together |
| Rider accept/decline **UI** | API only | The rider app is Phase 4. The endpoints are built and tested here because the dispatcher's flow is untestable without them |
| Auto-assignment, batching, ETA | **not built** | Phase 8, and only once manual dispatch is understood |

---

## 4. Out of scope

- **Pickup and everything after it.** `PICKUP_PENDING` onwards is Phase 4.
- **The rider PWA.** Phase 4.
- **Rider location tracking.** Phase 4.
- **Outbound status to Grocery.** Phase 5 — so a customer will *not* see "out for delivery"
  from this phase. Assignment is internal.
- **OTP, proof, exceptions, returns.** Phases 4 and 6.
- **Automatic assignment or routing.** Phase 8.
- **Rider pay, incentives, performance scoring.** Not in V1 at all.
- Anything Grocery or Inventory owns.

---

## 5. Existing systems affected

| System | Effect |
|---|---|
| **Grocery** | **None.** Assignment is invisible to the customer until Phase 5 |
| **Inventory** | **None.** No new call. The Phase 2 hold check is unchanged |

Phase 3 is the first phase that touches neither. That is worth noticing: the integration
surface is done and the remaining work is domain.

---

## 6. Logistics modules affected

| Module | Change |
|---|---|
| `fleet` | **created** — rider, availability, assignment |
| `delivery` | `allowed_next` widened; no table change |
| `identity` | 5 permission rows; no schema change |
| `integration`, `ops` | untouched |

---

## 7. Files to change

```
db/migrations/0007_fleet.sql        rider, availability, assignment, widened state machine

lib/delivery/states.ts              MODIFIED — mirror the widened map
lib/fleet/assignment.ts             assign / reassign / accept / decline / expire

app/api/v1/
  riders/route.ts                          GET list, POST create
  riders/[id]/route.ts                     GET one, PATCH activate/deactivate
  riders/[id]/availability/route.ts        POST online/offline (dispatcher or the rider)
  dispatch/route.ts                        GET the board
  deliveries/[id]/assign/route.ts          POST { rider_id }
  deliveries/[id]/reassign/route.ts        POST { rider_id, reason }
  deliveries/[id]/accept/route.ts          POST — rider, own assignment only
  deliveries/[id]/decline/route.ts         POST { reason } — rider, own assignment only
  deliveries/[id]/assignments/route.ts     GET history

app/(admin)/
  dispatch/page.tsx                  the board, with working assign buttons
  riders/page.tsx                    rider management
  deliveries/[id]/page.tsx           MODIFIED — assignment panel + actions

app/actions/dispatch.ts             server actions behind the buttons

scripts/expire-assignments.mjs      the accept-timeout sweep
tests/phase3.test.mjs
```

`app/api/health/route.ts` — `EXPECTED_MIGRATIONS` to 7.
`scripts/db-verify.mjs` — add `fleet` to the schema and RLS sweeps.

---

## 8. Database changes

### `fleet.rider`

```sql
create table fleet.rider (
  id           uuid primary key default gen_random_uuid(),

  -- The login. Created in Phase 1 with role 'rider'; this is the
  -- operational profile hanging off it.
  --
  -- Separating them means a rider who leaves keeps an auditable
  -- identity on every delivery they ever made, while losing all
  -- access on the same day.
  user_id      uuid not null unique references identity.app_user(id),

  code         text not null unique,          -- RDR-001, readable on a roster
  display_name text not null,
  phone        text not null,

  vehicle_type text not null default 'BIKE'
                 check (vehicle_type in ('BIKE','SCOOTER','CYCLE','VAN','FOOT')),

  home_location_code text references integration.location_ref(code),

  status       text not null default 'ACTIVE'
                 check (status in ('ACTIVE','SUSPENDED','OFFBOARDED')),

  -- Cheap guard against handing one person ten parcels by accident.
  max_concurrent integer not null default 1 check (max_concurrent between 1 and 10),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

### `fleet.rider_availability`

Current state on the rider row would be simpler, but then "when did they go offline" is
unanswerable — and that is the first question asked when a shift's numbers look wrong. So: a
log, plus a view for the current state.

```sql
create table fleet.rider_availability (
  id          bigint generated always as identity primary key,
  rider_id    uuid not null references fleet.rider(id),
  is_online   boolean not null,
  reason      text,
  changed_by  uuid,                -- null when the rider did it themselves
  occurred_at timestamptz not null default now()
);

create view fleet.rider_current as
  select r.*,
         coalesce((select a.is_online from fleet.rider_availability a
                    where a.rider_id = r.id
                    order by a.occurred_at desc, a.id desc limit 1), false) as is_online,
         (select count(*) from fleet.assignment x
           where x.rider_id = r.id and x.status in ('OFFERED','ACCEPTED')) as active_count
    from fleet.rider r;
```

### `fleet.assignment`

```sql
create table fleet.assignment (
  id            uuid primary key default gen_random_uuid(),
  delivery_id   uuid not null references delivery.delivery(id),
  rider_id      uuid not null references fleet.rider(id),

  status        text not null default 'OFFERED'
                  check (status in ('OFFERED','ACCEPTED','DECLINED','EXPIRED','SUPERSEDED','COMPLETED')),

  assigned_by   uuid not null,
  assigned_at   timestamptz not null default now(),
  -- An offer that is never answered must not hold a parcel forever.
  expires_at    timestamptz not null,

  responded_at  timestamptz,
  decline_reason text,

  -- Which assignment replaced this one. Reassignment is a new row, not
  -- an edit: "who was asked first" is exactly the question a complaint
  -- turns on.
  superseded_by uuid references fleet.assignment(id),

  created_at timestamptz not null default now()
);

-- At most ONE live offer per delivery, enforced by the database rather
-- than by two dispatchers being careful.
create unique index assignment_one_live
  on fleet.assignment (delivery_id)
  where status in ('OFFERED','ACCEPTED');
```

That partial unique index is the load-bearing part: two dispatchers clicking Assign on the same
delivery at the same moment produce one winner and one clean 409, not two riders at one door.

### The widened state machine

`delivery.allowed_next` is **replaced**, not supplemented:

```
READY_FOR_ASSIGNMENT -> ASSIGNED, CANCELLED
ASSIGNED             -> ACCEPTED, READY_FOR_ASSIGNMENT, CANCELLED
ACCEPTED             -> READY_FOR_ASSIGNMENT, CANCELLED      (Phase 4 adds PICKUP_PENDING)
```

`ASSIGNED → READY_FOR_ASSIGNMENT` covers decline, timeout and dispatcher reassignment — three
routes to one place, each distinguished by its `reason_code` on the timeline.

### Permissions

| Permission | admin | dispatcher | rider |
|---|:--:|:--:|:--:|
| `riders:read` | ✓ | ✓ | |
| `riders:write` | ✓ | | |
| `riders:availability` | ✓ | ✓ | |
| `deliveries:assign` | ✓ | ✓ | |
| `deliveries:respond` | | | ✓ |

`deliveries:respond` is a rider's first real permission — and it is **not** enough on its own.
Accepting also requires being the rider named on the live offer, checked in the database
(§9.1).

Riders also gain a read policy on `delivery.delivery` scoped to *their own live assignment*,
so they can see the address of the parcel they have accepted and nothing else.

---

## 9. The two things most likely to go wrong

### 9.1 A rider acting on somebody else's delivery

The whole rider surface is one person acting on one task. `deliveries:respond` says "you are a
rider"; it must not say "you may accept this".

Enforced in the transition itself, not in the route:

```sql
-- inside fleet.respond_to_assignment()
if ops.current_role_name() = 'rider'
   and not exists (
     select 1 from fleet.assignment a
       join fleet.rider r on r.id = a.rider_id
      where a.delivery_id = p_delivery_id
        and a.status = 'OFFERED'
        and r.user_id = ops.current_actor_id())
then
  raise exception 'NOT_YOUR_ASSIGNMENT: this delivery is not offered to you'
    using errcode = '42501';
end if;
```

Tested with a second rider, not just with the happy path.

### 9.2 Two dispatchers, one delivery

Handled in three layers, because one is a single point of failure:

1. `delivery.transition` already takes `FOR UPDATE` on the delivery row.
2. The partial unique index refuses a second live assignment.
3. The route maps the resulting `23505` to a `409` that names the rider who won.

The test drives five concurrent assigns of one delivery to five different riders and asserts
exactly one live assignment.

---

## 10. APIs

| Method | Path | Who | Permission |
|---|---|---|---|
| `GET` | `/api/v1/riders` | staff | `riders:read` |
| `POST` | `/api/v1/riders` | admin | `riders:write` |
| `GET` | `/api/v1/riders/:id` | staff | `riders:read` |
| `PATCH` | `/api/v1/riders/:id` | admin | `riders:write` |
| `POST` | `/api/v1/riders/:id/availability` | staff or that rider | `riders:availability` / own |
| `GET` | `/api/v1/dispatch` | staff | `deliveries:read` |
| `POST` | `/api/v1/deliveries/:id/assign` | staff | `deliveries:assign` |
| `POST` | `/api/v1/deliveries/:id/reassign` | staff | `deliveries:assign` |
| `POST` | `/api/v1/deliveries/:id/accept` | rider | `deliveries:respond` + owns the offer |
| `POST` | `/api/v1/deliveries/:id/decline` | rider | `deliveries:respond` + owns the offer |
| `GET` | `/api/v1/deliveries/:id/assignments` | staff | `deliveries:read` |

**Creating a rider creates two rows** — an `identity.app_user` with role `rider` and a
`fleet.rider` profile — in one transaction, returning a one-time password the same way
`admin:create` does. A rider profile with no login, or a login with no profile, is not a state
this system can be in.

**Refusals name the cause:** `409 already_assigned` says who holds it; `403 not_your_assignment`
says so plainly; `409 rider_unavailable` distinguishes offline, suspended and at-capacity,
because a dispatcher staring at a greyed-out name needs to know which.

---

## 11. Events

**Still no outbound events** — Phase 5.

Audit vocabulary added:

```
rider.created        rider.suspended      rider.reactivated
rider.went_online    rider.went_offline
delivery.assigned    delivery.accepted    delivery.declined
delivery.reassigned  assignment.expired
```

`delivery.assigned` and friends already flow through `delivery.transition`, so they land on the
timeline for free. The rider-specific detail (who, why) goes in `reason_code` and `note`.

---

## 12. UI

Two new screens, plus the delivery detail gaining teeth.

**`/dispatch`** — deliveries awaiting assignment on the left, available riders on the right,
with each rider's current load. Assign is a form post to a server action; no client framework.
A rider who is offline, suspended or at capacity is shown greyed with the reason, rather than
hidden — a dispatcher needs to know *why* somebody is not available.

**`/riders`** — list with status, availability and load; create; activate/deactivate.

**`/deliveries/:id`** — the Phase 2 read-only page gains an assignment panel: current rider,
offer expiry, full attempt history, and buttons rendered from `allowed_next` so a button never
offers a move the database will refuse.

> **Q21 bites here.** Inventory returns no coordinates for its shops, so the board cannot show
> a pickup pin. Grocery now sends the *customer's* geocode, so the destination is plottable and
> the origin is not. Phase 3 ships a **list-based board**, which is what a dispatcher handling
> tens of orders a day actually wants. A map needs Q21 answered.

---

## 13. Security risks

| # | Risk | Mitigation |
|---|---|---|
| P3-01 | **A rider acts on another's delivery** | Ownership checked in the database (§9.1), tested with a second rider |
| P3-02 | A rider reads deliveries they were never offered | RLS scoped to their own live assignment; tested |
| P3-03 | Two riders dispatched to one door | Partial unique index + `FOR UPDATE` + 409 (§9.2) |
| P3-04 | **A rider sees the customer's phone and address** | They must, to deliver. Visible only for a live assignment, gone when it ends. Masked in logs already |
| P3-05 | A dispatcher assigns at another shop | `ops.can_access_location` already gates the transition |
| P3-06 | A rider's one-time password is weak or reused | Same bootstrap as `admin:create`: 24 random bytes, shown once, forced change |
| P3-07 | An offboarded rider keeps working | `status` checked at assign *and* at accept — a rider suspended between the two must not proceed |
| P3-08 | Assignment history rewritten to hide a bad call | Reassignment inserts a new row and marks the old `SUPERSEDED`; no update path to `rider_id` |

---

## 14. Tests

`tests/phase3.test.mjs`, roughly 40, on top of the current 90.

**Riders (8)** — create makes both rows; a rider can sign in; duplicate code refused; suspend
blocks assignment; offboard blocks sign-in; only an admin may create; a dispatcher may read;
`max_concurrent` respected.

**Availability (5)** — offline by default; toggling records who and when; the view reflects the
latest; a rider may toggle themselves; a rider may **not** toggle somebody else.

**Assignment (12)** — happy path to `ASSIGNED`; an offline/suspended/at-capacity rider is
refused with distinct codes; assigning an un-admitted delivery is refused; **five concurrent
assigns yield exactly one live assignment**; the timeline records it; the history endpoint shows
every attempt.

**Accept / decline (8)** — the named rider accepts; **a different rider gets
`NOT_YOUR_ASSIGNMENT`**; decline requires a reason and returns the delivery to the queue;
accepting twice is refused; accepting an expired offer is refused; accepting after being
suspended is refused.

**Reassignment (4)** — moves the delivery, marks the old `SUPERSEDED`, requires a reason, and
both attempts remain visible.

**Timeout (3)** — an unanswered offer past `expires_at` returns to the queue; the sweep is
idempotent; an accepted offer is untouched by it.

**Permissions and RLS (6)** — a rider sees only their own assigned delivery; sees nothing once
it ends; cannot assign; a dispatcher cannot create a rider; location scoping holds; the
SQL/TypeScript state mirrors still agree.

---

## 15. Verification commands

```bash
npm run db:reset && npm run db:verify     # fleet in the RLS sweep
npm test                                  # phase1 + phase2 + phase3
npm run check
npx tsc --noEmit && npm run build
npm run expire:assignments -- --dry-run
```

Manual: ingest via `demo:order`, admit, create a rider, bring them online, assign, accept as
that rider, then try accepting as a *different* rider and confirm the refusal.

---

## 16. Rollback

| Scenario | Action |
|---|---|
| Bad deploy | Redeploy previous. Phase 3 makes no outbound call — nothing external changed |
| Bad migration | `0007` only adds `fleet` and replaces one function. Restoring the Phase 2 `allowed_next` reverts the state machine |
| Abandon | `drop schema fleet cascade` + restore `allowed_next`. Deliveries stay in `READY_FOR_ASSIGNMENT` |

**Data loss risk: low**, but real rider PII arrives here for the first time.

---

## 17. Open questions

| # | Status |
|---|---|
| **Q1 / Q2 / Q4** | **Fixed in code**, merged pending — Grocery PR #1. **The migration has not been run**, so Phase 3 is still built and tested on synthetic orders |
| **Q21** | Bites now. Ships list-based; a map needs Inventory to expose shop coordinates |
| **Q3** | Phase 5 |
| **Q13** *(was defaulted)* | Confirming the default: accept timeout **120 s**, three declines in a shift flags the rider for review |
| **Q23** *(new)* | **How many deliveries may a rider carry at once?** `max_concurrent` defaults to **1** — one parcel, one rider, no batching. Raising it is a number, not a migration; batching as a *feature* is Phase 8 |
| **Q24** *(new)* | **May a dispatcher reassign a delivery a rider has already accepted?** Proposed: **yes, with a reason**, because a rider whose bike has broken down should not strand a parcel. The rider's app will tell them it was taken back (Phase 4) |

---

## Approval requested

Phase 3 will not begin until this is approved.

**Please confirm:**

1. **Scope** (§3) and exclusions (§4) — in particular that a **customer still sees nothing**
   from this phase; status reaches them in Phase 5.
2. **Dropping shifts and rider location** from this phase (§3).
3. **Building rider accept/decline as API only**, with the rider UI in Phase 4 (§3).
4. **§9.1** — rider ownership enforced in the database, not the route.
5. **Q23** — one delivery per rider at a time by default.
6. **Q24** — a dispatcher may reassign an already-accepted delivery, with a reason.
7. That it is acceptable to **build Phase 3 against synthetic orders** while the Grocery
   migration is unrun — or whether you would rather run that migration first.
