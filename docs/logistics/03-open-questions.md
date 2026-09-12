# Open Questions & Assumptions

**Date:** 2026-09-12 · **Status:** awaiting answers
**Legend:** 🔴 blocks a phase · 🟠 shapes design · 🟡 can default safely

---

## Blocking

### 🔴 Q1 — How does a delivery address get onto an order?

**Blocks:** Phase 2 · **Owner:** Grocery team + product

**The finding.** No order in the system has a delivery address. The `addresses` table exists
and has never been written to. The checkout "Delivery Details" form is uncontrolled and its
values are discarded. `orders` has no `address_id`. `addresses` has no lat/lng.
Grocery captures a geocode in `MapPicker` for the 10 km serviceability check and throws it away.

**Why it blocks everything.** A delivery task with no destination cannot be assigned,
navigated to, or completed. This is not a design choice we can work around.

**Options**

| | Approach | Cost | Consequence |
|---|---|---|---|
| **A** *(recommended)* | Grocery wires the checkout form to `addresses`, adds `lat`/`lng` to the table, and adds `orders.address_id` | ~1 day in Grocery + a migration | Correct. Customer owns their address, logistics snapshots it |
| B | Grocery keeps the form but writes a denormalised address JSON onto `orders` | ~half a day | Faster; no reusable saved addresses; duplicated per order |
| C | Logistics collects the address after ingest, via an agent calling the customer | none in Grocery | Unacceptable operationally. Every order needs a phone call |
| D | Reuse `service_requests` lat/lng as a proxy | small | Wrong data. Not per-order, and the table does not exist |

**Recommendation: A.** Note that **B or C would still require the geocode**, so there is no
option that avoids touching Grocery.

**Needed to proceed:** confirmation that Grocery may be changed, and by whom.

> **RESOLVED (pending migration + review) 2026-09-12.** Implemented on branch
> `feat/delivery-address-and-logistics-handoff` in Grocery, uncommitted. Q1, Q2 and Q4 are all
> addressed; the contract was proven by running Grocery's own payload builder against the live
> logistics service, producing `DLV-2026-000022` with a verified stock hold and the reservation
> id intact. **Still needed:** run the migration against the live database and a browser pass.
> See [`05-grocery-change-spec-q1.md`](05-grocery-change-spec-q1.md) §13.
>
> **Specified 2026-09-12** — see [`05-grocery-change-spec-q1.md`](05-grocery-change-spec-q1.md).
> The spec covers Q1, Q2 and Q4 together, because all three are fixed in essentially one file:
> Grocery already captures the geocode (`LocationSelector.assignLocation`), the address (the
> checkout form) and the reservation ids (the `reserve` response) — and discards all three.
> It is a persistence change, not a collection change. Estimated at about a day.

---

### 🔴 Q2 — How does logistics learn the fulfilment shop?

**Blocks:** Phase 2 · **Owner:** Grocery team

The shop an order is fulfilled from lives **only** in the `inventory_location` browser
cookie, read at request time by `getCurrentLocation()`. It is passed to Inventory's reserve
call and then forgotten. `orders` has no location column.

Without it, logistics does not know where the rider collects the parcel.

**Options**

| | Approach | Notes |
|---|---|---|
| **A** *(recommended)* | Grocery adds `orders.fulfilment_location_code` and writes it at checkout | One column, one line at insert. Solved permanently |
| B | Logistics infers it from the reservation | `GET /api/inventory/order/:id` returns SKU and status but **not** location — so this does not work today |
| C | Dispatcher picks the shop manually during admission | Workable stopgap for V1; error-prone at volume |

**Recommendation: A**, with **C** as the V1 fallback while A is delivered — it fits the
dispatcher-confirmed admission gate already proposed.

---

### 🔴 Q3 — May Grocery be modified, and how far?

**Blocks:** Phase 5 (and, via Q1/Q2, Phase 2) · **Owner:** programme sponsor

The brief says not to rebuild Grocery, and not to modify it during analysis. It also allows
changes *"explicitly approved for integration."* Three additive changes are needed:

1. **Address capture** (Q1) — without it nothing can be delivered.
2. **Fulfilment location** (Q2) — without it nothing can be collected.
3. **A status receiver** `POST /api/logistics/status`, plus replacing the lossy ternary in
   `services/orders.ts:54` so the customer pipeline shows real progress.

Note that `orders` has **no RLS `UPDATE` policy at all**, so even a service-role workaround
needs a deliberate decision about bypassing RLS from outside the owning system.

**Options**

| | Approach | Notes |
|---|---|---|
| **A** *(recommended)* | Approve the three additive changes. No behaviour is removed or rebuilt | Clean boundaries. Grocery owns its own writes |
| B | Approve 1 and 2 only; logistics writes status via a service-role key | Works; a boundary violation; RLS bypassed from outside |
| C | Approve nothing | Logistics can be built to Phase 4 and demonstrated, but can never deliver a real order |

**Recommendation: A.**

---

### 🔴 Q4 — How does logistics obtain the per-line `reservation_id`s?

**Blocks:** Phase 2 · **Owner:** Integration Architect + Inventory team

To stop the 30-minute hold expiring mid-delivery, logistics must call
`POST /api/v1/reservations/:id/confirm` per line. That needs reservation ids.

`POST /api/inventory/reserve` returns them — and Grocery discards the response.
`GET /api/inventory/order/:order_id` returns SKU, quantity, status and expiry, but **not** the
reservation id. So today the ids are unrecoverable after checkout.

**Options**

| | Approach | Notes |
|---|---|---|
| **A** | Grocery persists the reservation ids and forwards them on the inbound contract | Small Grocery change; no Inventory change |
| **B** *(recommended)* | Inventory adds `stock.confirm_order(order_ref)` and `POST /api/inventory/confirm`, mirroring `commit_order`/`release_order` | The obviously missing sibling of three functions that already exist. One migration, one route. Order-level, so no ids need to travel |
| C | Inventory includes `reservation_id` in `GET /api/inventory/order/:id` | Smallest change; exposes internal ids more widely |
| D | Do nothing; re-reserve when a hold expires | **Wrong.** Double-holds real stock, and may fail if the shelf has moved on |

**Recommendation: B**, with **A** as a fallback if Inventory is frozen.
**D is explicitly rejected.**

---

## Design-shaping

### 🟠 Q5 — Rider app: PWA or native?

**Blocks:** Phase 4 · **Owner:** product + engineering

| | Approach | Notes |
|---|---|---|
| **A** *(recommended for V1)* | Mobile-first PWA inside the logistics Next app: service worker, IndexedDB outbox, camera via `<input capture>`, geolocation API | One repo, one deploy, one auth. Installable. No store review |
| B | React Native / Expo | Better background location and camera; a second toolchain, store accounts, release cycles |
| C | PWA now, native in V2 once the domain is stable | Pragmatic |

**Caveat:** a PWA's background geolocation is limited when the screen is off. If continuous
breadcrumb tracking is a hard requirement rather than periodic pings, that pushes toward B.
**Recommendation: A/C** — the V1 requirement is "location during an active delivery", which
periodic foreground pings satisfy.

---

### 🟠 Q6 — Is COD in scope for V1?

**Blocks:** Phase 4 · **Owner:** product + finance

Cash on Delivery is **`disabled`** in Grocery's checkout. No order can be COD. There is no
`amount_to_collect`, no settlement model, and no wallet — and `status: 'PAID'` is hard-coded
before any payment happens, so it is not evidence of settlement either.

**Recommendation:** carry `payment_method` and a nullable `amount_to_collect_paise` on the
delivery as read-only reference fields, and build **no** cash-handling workflow. COD then
becomes a configuration change in V2, not a migration.

---

### 🟠 Q7 — Who owns serviceability and delivery zones?

**Blocks:** Phase 3 · **Owner:** product

Grocery enforces a 10 km radius from hard-coded coordinates in `src/config/stores.ts`. A
logistics system would normally own zones, rider coverage and per-zone SLAs.

**Recommendation for V1:** logistics treats Grocery's decision as authoritative and does not
re-gate. Move zone ownership to logistics in Phase 8, at which point Grocery should query
logistics for serviceability rather than computing it.

---

### 🟠 Q8 — What is the promised delivery window?

**Blocks:** Phase 2 (the SLA clock) · **Owner:** product

There are no delivery slots anywhere in the estate. Without a promise, "on-time" is undefined
and the SLA KPI cannot be computed.

**Recommendation:** V1 uses a configurable flat promise (e.g. 90 minutes from ingest) recorded
on the delivery at creation, so the clock exists and is measurable. Customer-chosen slots are V2.

---

### 🟠 Q9 — How is the customer contacted, and how is their number protected?

**Blocks:** Phase 4 · **Owner:** product + security

The rider needs to reach the customer. Exposing a raw mobile number to a rider's personal
handset is a meaningful privacy decision.

| | Approach | Notes |
|---|---|---|
| A | Show the raw number | Simplest; permanent exposure; the rider keeps it after the delivery |
| **B** *(recommended)* | Number masking via a telephony provider | Standard practice; a per-delivery proxy number that expires |
| C | In-app calling | Best privacy; most build |

**Recommendation: B**, with **A** behind a feature flag for V1 if no telephony provider is
available — but the flag must be explicit, logged, and the number redacted from logs and the
admin UI.

---

## Safe to default

### 🟡 Q10 — OTP delivery channel
No SMS provider exists anywhere in the estate. **Default:** generate the OTP in logistics and
surface it to the customer through Grocery's order screen (the tracking push already carries
it) plus email if available. SMS when a provider is chosen. 6 digits, 15-minute TTL, 5
attempts, single use, bound to the delivery id, hashed at rest.

### 🟡 Q11 — Proof photo storage
**Default:** Supabase Storage in a **private** bucket, mirroring Inventory's driver pattern,
with short-lived signed URLs. Never the public bucket Inventory uses for product images —
product photos are meant to be public, doorstep photos are not. Strip EXIF GPS on upload.

### 🟡 Q12 — Retention
**Default:** proof files 90 days; rider location traces 30 days; audit rows 7 years
(they are the record of what happened); delivery PII snapshot purged 180 days after a
terminal state. To be confirmed against the governing privacy policy before Phase 7.

### 🟡 Q13 — Reassignment on decline or timeout
**Default:** accept timeout 120 s → auto-return to `READY_FOR_ASSIGNMENT`, rider decline
recorded with a reason, three declines in a shift flags the rider for dispatcher review.

### 🟡 Q14 — Where do returns go?
**Default:** back to the originating pickup location (the shop that fulfilled it), because
that is where the reservation was placed and where `release` returns the stock. Hub returns
are V2.

### 🟡 Q15 — Hosting and worker placement
**Default:** logistics API on Vercel; **the webhook/outbound worker as a separate always-on
process**, never a serverless function — Inventory's `webhook-worker.mjs` header documents
exactly why (billed by wall-clock, killed mid-flight). Postgres via the Supabase **pooler**
(the direct host is IPv6-only and does not resolve from serverless).

---

## Assumption register

The full list of working assumptions is §22 of
[`00-existing-systems-analysis.md`](00-existing-systems-analysis.md) (A-01 … A-18). They are
adopted for planning and each is cheap to reverse. Any that a Q above overturns will be
updated there rather than duplicated here.
