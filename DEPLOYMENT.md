# Deploying Logistics Core

Two processes, one database, four secrets. Nothing here is exotic; the
one thing that is easy to get wrong is the worker, and it is the thing
that makes the rest work.

---

## 1. The two processes

| Process | Command | Where |
|---|---|---|
| The API and screens | `npm run build && npm start` | Anywhere, serverless included |
| **The worker** | `npm run worker` | **A long-running process. Never serverless.** |

### Why the worker cannot be a serverless function

It is billed by wall-clock and killed mid-flight. A job terminated between "claimed a
queue row" and "recorded what happened to it" leaves an outbound event in `SENDING` —
a state that exists precisely so a crash is survivable, and one there is no reason to
manufacture every twenty seconds.

Inventory's own `webhook-worker.mjs` header documents the same conclusion, reached
independently. A small always-on container, a systemd unit or a `Procfile` worker dyno
all do.

**If the worker is not running, nothing is sent.** No commit to Inventory, no status to
Grocery. Deliveries still complete for riders and customers; the estate simply stops
hearing about them. That is survivable for minutes and not for hours.

---

## 2. Environment

Copy `.env.example`. The four that matter:

| Variable | Why |
|---|---|
| `DATABASE_URL` | Supabase **pooler**, not the direct host — the direct one is IPv6-only and does not resolve from most serverless platforms |
| `INVENTORY_API_KEY` | Commits and releases real stock. Server-side only, never `NEXT_PUBLIC_` |
| `INBOUND_WEBHOOK_SECRET` | Verifies Grocery's order handoff. Must equal `LOGISTICS_WEBHOOK_SECRET` there |
| `GROCERY_WEBHOOK_SECRET` | Signs status pushes to Grocery. Must equal `LOGISTICS_INBOUND_SECRET` there |

The last two are **different secrets on purpose** — one per direction, so a leak in one
cannot be used in the other and either can be rotated alone. It is easy to mistake that
for a typo and "fix" it into one. Don't.

---

## 3. First run, in order

```bash
npm run db:migrate          # 13 migrations
npm run db:verify           # must print 11/11
npm run admin:create        # the first admin
npm run locations:sync      # names and types from Inventory
```

Then, in the app:

1. **Set each shop's coordinates** at `/locations`. `locations:sync` brings names and
   types; it does not bring coordinates, because Inventory has no such field (Q21).
   Until they are set, dispatch cannot rank riders by distance and serviceability reads
   "cannot tell" rather than in or out of range.
2. **Mint Grocery's key**: `npm run key:mint -- "Grocery storefront" orders:ingest`.
3. Start the worker.

---

## 4. What to watch

```
GET /api/health            → 200 always, while the process is alive. For a load balancer.
GET /api/health?deep=1     → 200 or 503. For a human or an alerting rule.
```

Deep health needs `system:health:deep` — a bearer API key or an admin session.

It returns **503** when:

- migrations are behind the build's expectation,
- the database is unreachable,
- **or any scheduled job has not succeeded within its window**, naming it:

```json
{ "status": "degraded",
  "checks": { "jobs": {
    "ok": false,
    "detail": "outbound.drain has not succeeded for 2535s (allowed 300s)" } } }
```

That last one is the check worth alerting on. A worker that dies quietly leaves every
other signal green while a customer's order page freezes on "packed" — nothing *fails*,
so without this nothing shows.

There is no alerting provider in this estate. Point whatever you already have at this
endpoint.

### The screens that answer "is it healthy"

| Screen | Question |
|---|---|
| `/reports` | Stuck deliveries, latencies, commit and release health |
| `/integration` | The outbound queue: waiting, retrying, dead |
| `/exceptions` | What needs a person, oldest and most severe first |

**Commit and release health is the one to check daily.** Anything not `verified` means
Inventory has not confirmed the goods moved; `pending` clears itself once the drain
runs, `failed` needs somebody.

---

## 5. The jobs

Configured in `ops.job_schedule`, run by `npm run worker`, each under an advisory lock
so two workers cannot double-drain.

| Job | Every | Stale after |
|---|---|---|
| `outbound.drain` | 20 s | 5 min |
| `assignments.expire` | 60 s | 10 min |
| `holds.expire` | 5 min | 1 h |
| `retention.purge` | 24 h | 48 h |

```bash
npm run worker -- --list          # what is scheduled and whether it is behind
npm run worker -- --once          # one pass of everything, then exit
npm run worker -- --only drain    # one job
```

`retention.purge` destroys data on purpose. Inspect it before trusting it:

```bash
npm run retention                 # dry run: counts per table, changes nothing
npm run retention -- --confirm    # apply
```

---

## 6. Rotating a secret

1. Set the new value on **both** sides of the pair.
2. Restart both processes.
3. Watch `/integration` for dead letters. A mismatch shows up as `401` from the
   receiver and a dead status push here, not as silence.

API keys are hashed; `npm run key:mint` prints the plaintext once and never again.

---

## 7. Things that are true and might surprise you

- **Deleting is not possible.** No table in this system grants `DELETE` except through
  retention's own definer functions. The audit log and the delivery timeline refuse
  `UPDATE` and `DELETE` outright.
- **`hold_confirmed` is always false** (Q4). Inventory exposes no way to confirm a
  reservation, so every hold lapses after 30 minutes and both commit and release are
  *records* of what happened rather than controls over it.
- **There is no on-time rate** (Q8). Grocery sends no promised window, so `promised_to`
  is null on every delivery. `/reports` says so rather than showing a zero.
- **The rider app is a PWA.** It caches its shell, keeps an outbox in IndexedDB, and
  syncs when it can. Signing out clears the outbox — after warning about anything
  unsent.
