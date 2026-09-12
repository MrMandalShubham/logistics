# Proposed Integration Contract — v1 (draft)

**Date:** 2026-09-12 · **Status:** proposed, awaiting approval · **Owner:** Integration Architect
**Companion to:** [`00-existing-systems-analysis.md`](00-existing-systems-analysis.md)

Nothing here is implemented. This is the contract to agree **before** Phase 1.

---

## 0. Capability findings that shape this contract

| Capability | Grocery | Inventory |
|---|---|---|
| REST API | **none** — no `app/api/` at all | yes, two surfaces (`/api/v1/*`, `/api/*`) |
| Webhooks out | none | **yes**, signed, retried, dead-lettered |
| Webhooks in | none | none |
| Event bus | none | Postgres-trigger driven, 4 fixed events |
| Shared auth | Supabase Auth (customers only) | own bcrypt auth + API keys |
| Direct DB access | Supabase (anon key under RLS; service-role bypasses RLS) | Postgres, RLS-scoped |
| Polling | possible against Supabase | possible against `/api/*` |
| Idempotency | none | **mandatory** on `/api/v1` writes |
| Rate limiting | none | per API key, per minute + daily quota |

**Consequences**

1. Logistics cannot subscribe to an Inventory event for orders — the
   `webhook_subscription.event` CHECK permits only four values, none order-related
   (analysis §10.1).
2. Grocery cannot push or receive anything today without an additive code change.
3. Inventory's signing, retry and idempotency design is good, proven in this estate, and is
   adopted verbatim rather than reinvented.

---

## 1. Identifiers

| Identifier | Owner | Shape | Used by logistics as |
|---|---|---|---|
| `order.id` | Grocery | uuid | `external_order_id` — **the ingest idempotency key** |
| `profiles.id` | Grocery | uuid | `external_customer_id` |
| `order_items.external_product_id` | Inventory (via Grocery) | text | `external_product_id` |
| `order_items.sku` | Inventory | text | `sku` — the identity used with Inventory |
| `platform.location.code` | Inventory | `HUB`/`SH1`/`SH2`/`SH3` | `pickup_location_code` |
| `platform.location.id` | Inventory | uuid | `external_location_id` |
| `stock.reservation.id` | Inventory | uuid | `reservation_id` (needed to confirm — Q4) |
| `delivery.id` | **Logistics** | uuid | own primary key |
| `delivery.tracking_id` | **Logistics** | `DLV-YYYY-NNNNNN` | written back to `orders.logistics_tracking_id` |
| `event_id` | **Logistics** | uuid | outbound idempotency key |
| `correlation_id` | first emitter | uuid | propagated on every hop and log line |

**Rule:** logistics never invents a product, customer or location identity. It stores what it
was given and passes it back unchanged.

---

## 2. Authentication

### 2.1 Inbound to logistics — Grocery → Logistics

Two independent controls, both required.

**(a) Bearer API key.** Logistics mints `lg_live_…` / `lg_test_…` keys, stored SHA-256, with
scopes and an optional location binding. Same design as `platform.api_client`.

```
Authorization: Bearer lg_live_<48 hex>
```

Scopes: `orders:ingest`, `deliveries:read`, `deliveries:write`, `riders:read`,
`riders:write`, `reports:read`.

**(b) HMAC signature** over the raw body — Inventory's scheme, verbatim:

```
X-Logistics-Signature: t=<unix seconds>,v1=<hex hmac-sha256>
```

Signed string is `` `${t}.${rawBody}` ``. Tolerance **300 s**. Constant-time compare.
`verify()` from `inventory/lib/webhooks.ts` is copied as-is.

> The timestamp is inside the MAC, not beside it. Signing only the body would let anyone who
> captures one delivery replay it forever.

### 2.2 Outbound from logistics → Inventory

A dedicated `ic_live_…` key, scopes **`reservations:write` + `stock:read`** only, bound to
the delivery locations. Never `catalog:write`, never `pricing:write`, never `cost:read`.

### 2.3 Outbound from logistics → Grocery

Depends on Q3.
- **(a) preferred:** Grocery exposes `POST /api/logistics/status`, verifying the same HMAC
  scheme with a shared `LOGISTICS_WEBHOOK_SECRET`.
- **(b) fallback:** logistics holds a Grocery service-role key and updates `orders` directly.
  Requires an explicit boundary waiver, and the key must be restricted to `orders` only.

### 2.4 Rider and dispatcher auth

Session cookies issued by logistics, backed by bcrypt credentials in the logistics database.
Short-lived access token, refresh on use, device binding for riders, lockout on repeated
failure. **Not** Supabase Auth; **not** the env-admin pattern from Inventory's `.env.example`.

---

## 3. Inbound — `orders.delivery-ready`

```http
POST /api/v1/integration/orders.delivery-ready
Authorization: Bearer lg_live_...
X-Logistics-Signature: t=1789012345,v1=<hex>
Idempotency-Key: 9f2c1e5a-...          ; = external_order_id
X-Correlation-Id: 3b7d...              ; optional; generated if absent
Content-Type: application/json
```

```json
{
  "event": "order.delivery_ready",
  "event_id": "b1e0...",
  "occurred_at": "2026-09-12T09:41:07.221Z",
  "version": "1.0",
  "data": {
    "external_order_id": "9f2c1e5a-3d44-4a91-b0f2-1c7e8a55d310",
    "external_customer_id": "7c11...",
    "placed_at": "2026-09-12T09:12:00.000Z",

    "pickup": {
      "external_location_id": "0b4f...",
      "location_code": "SH1"
    },

    "delivery_address": {
      "recipient_name": "A. Sharma",
      "phone": "+919876543210",
      "line1": "402, Sunview Apartments",
      "line2": "Near Andheri Station",
      "city": "Mumbai",
      "state": "Maharashtra",
      "pincode": "400058",
      "lat": 19.1204,
      "lng": 72.8501,
      "instructions": "Call on arrival, lift is out of service"
    },

    "items": [
      {
        "external_product_id": "prd_01H...",
        "sku": "PRD-2026-000001",
        "name": "Basmati Rice 5kg",
        "quantity": 1,
        "reservation_id": "d2a7..."
      }
    ],

    "payment": {
      "method": "RAZORPAY",
      "is_prepaid": true,
      "amount_to_collect_paise": 0,
      "order_total_paise": 74900
    },

    "promised_window": {
      "from": "2026-09-12T10:30:00.000Z",
      "to":   "2026-09-12T11:30:00.000Z"
    }
  }
}
```

### Validation, in order

| Step | Failure |
|---|---|
| Signature present, well-formed, within 300 s | `401 invalid_signature` |
| Bearer key valid, `orders:ingest` scope | `401` / `403 insufficient_scope` |
| `Idempotency-Key` present | `400 idempotency_key_required` |
| Same key, different body hash | `422 idempotency_key_reused` |
| Same key, same body | `200` replay of the original response |
| Schema valid | `422 schema_invalid` with a field list |
| `delivery_address.lat`/`lng` present and numeric | `422 address_not_deliverable` |
| `pickup.location_code` resolves via `GET /api/locations` | `422 unknown_pickup_location` |
| `items` non-empty, quantities positive | `422 schema_invalid` |

### Responses

```json
201  { "ok": true, "delivery_id": "…", "tracking_id": "DLV-2026-000418",
       "status": "RECEIVED", "as_of": "…" }

200  { "ok": true, "delivery_id": "…", "tracking_id": "DLV-2026-000418",
       "status": "READY_FOR_ASSIGNMENT", "replayed": true, "as_of": "…" }

422  { "error": { "code": "address_not_deliverable",
                  "message": "delivery_address.lat and .lng are required",
                  "fields": ["data.delivery_address.lat"] } }
```

**Post-ingest side effect:** logistics confirms each `reservation_id` against Inventory so the
30-minute hold stops expiring (analysis §16.2). If `reservation_id` is unavailable (Q4), the
delivery is still created but flagged `reservation_unconfirmed`, and the stuck-delivery
monitor raises it.

### Interim poller (scaffold only)

Until the push path exists, a logistics worker polls Grocery's Supabase for
`orders.status = 'PAID'` with no ingest record, and synthesises exactly the payload above
before handing it to the *same* `IngestDeliveryOrder` command. One code path, two sources.
Deleted when Q1/Q3 are answered.

---

## 4. Outbound — logistics → Grocery

```http
POST https://grocery.example.com/api/logistics/status
X-Logistics-Signature: t=…,v1=…
Idempotency-Key: <event_id>
```

```json
{
  "event": "delivery.status_changed",
  "event_id": "6a0e...",
  "occurred_at": "2026-09-12T11:04:33.918Z",
  "version": "1.0",
  "data": {
    "delivery_id": "…",
    "tracking_id": "DLV-2026-000418",
    "external_order_id": "9f2c1e5a-…",
    "status": "DELIVERED",
    "external_status": "DELIVERED",
    "customer_pipeline_step": "delivered",
    "reason_code": null,
    "occurred_at": "2026-09-12T11:04:31.000Z",
    "rider": { "first_name": "Imran", "masked_phone": "+9198*****10" },
    "proof": { "type": "OTP", "verified_at": "2026-09-12T11:04:29.000Z",
               "photo_ref": "pod/2026/09/12/DLV-2026-000418/1.jpg" },
    "correlation_id": "3b7d…"
  }
}
```

**Guarantees**

- Every transition emits one event. Dedupe key `event_id`.
- At-least-once delivery; the receiver must be idempotent on `event_id`.
- Ordering is not guaranteed across events — the receiver must ignore an event whose
  `occurred_at` is older than the status it already holds.
- Retry `10 × 4ⁿ` seconds, 6 attempts, then `DEAD` and visible on the integration health screen.
- A `reason_code` accompanies every non-happy status.
- `proof.photo_ref` is a reference, never a URL and never bytes. Grocery must ask logistics for
  a signed URL if it ever needs to render one.
- The `status` → `external_status` → `customer_pipeline_step` mapping is analysis §20 and
  lives in one table in code.

---

## 5. Outbound — logistics → Inventory

Existing endpoints, unchanged. Logistics is simply the caller that has been missing.

| When | Call | Body | Idempotency |
|---|---|---|---|
| `RECEIVED` | `POST /api/v1/reservations/:id/confirm` | `{ "order_ref": "<external_order_id>" }` | `Idempotency-Key: confirm:<order>:<res>` |
| `DELIVERED` | `POST /api/inventory/commit` | `{ "order_id": "<external_order_id>" }` | naturally idempotent |
| `DELIVERED` (verify) | `GET /api/inventory/order/:external_order_id` | — | read |
| `RETURNED` | `POST /api/inventory/release` | `{ "order_id": "…", "reason": "returned: <code>" }` | naturally idempotent |
| `CANCELLED` | `POST /api/inventory/release` | `{ "order_id": "…", "reason": "cancelled: <code>" }` | naturally idempotent |

### The commit verification rule (non-negotiable)

```
commit(order_ref)
  -> then GET /api/inventory/order/:order_ref
     -> status == "delivered"  -> record ledger ids, mark commit_verified
     -> status == "held"       -> retry commit
     -> status == "released"   -> RAISE integration exception INVENTORY_HOLD_LOST
                                  (the stock was never reduced; a human must reconcile)
```

`already_committed: true` from the commit route is **not** proof of success — it is also
returned when the hold was released (analysis §14.2). Never trust it alone.

### Failure handling

- `409` on reserve is not logistics' concern; the order should never have reached us.
- `429` → honour `Retry-After`.
- `5xx` / timeout → retry with backoff; after exhaustion, dead-letter and alert. The delivery
  **still completes for the customer** — an inventory outage must not trap a rider at a door.
  The commit is queued and reconciled.

---

## 6. Versioning

- Path-versioned: `/api/v1/…`. A breaking change means `/api/v2`, with `v1` kept for one
  release cycle.
- Payloads carry `"version": "1.0"`. Additive fields bump the minor and require no client change.
- Receivers must ignore unknown fields.
- `X-Api-Version: v1` on every response, matching Inventory.
- A removed or renamed field is a major version. Never silently repurposed.

---

## 7. Reliability requirements

| Requirement | Mechanism |
|---|---|
| Authentication | Bearer key, SHA-256 stored, scoped |
| Signature validation | HMAC-SHA256 over `t.body`, 300 s window, constant-time compare |
| Schema validation | Rejected as `422` with a field list, before any write |
| Idempotency | `(api_client, key) → request_hash → response`; 422 on key reuse |
| Replay protection | Signature timestamp window + `event_id` uniqueness |
| Correlation | `X-Correlation-Id` in, propagated out, on every log line |
| Retry | `10 × 4ⁿ` s, 6 attempts |
| Dead letter | `DEAD` status, retained, replayable by an admin |
| Audit | Every inbound and outbound call logged with actor, status and duration |
| Ordering | Not assumed. Receivers compare `occurred_at` |
| Poison-message safety | A `422` is never retried; it goes straight to dead letter |

---

## 8. Event catalogue (logistics-emitted, v1)

| Event | Emitted when | Consumers |
|---|---|---|
| `delivery.created` | order ingested | internal |
| `delivery.ready_for_assignment` | dispatcher admits it | dispatch board |
| `delivery.assigned` | rider assigned | rider app, Grocery |
| `delivery.accepted` / `delivery.declined` | rider responds | dispatch board |
| `delivery.picked_up` | pickup confirmed | Grocery |
| `delivery.out_for_delivery` | rider departs | Grocery |
| `delivery.arrived` | rider at the door | Grocery |
| `delivery.delivered` | OTP verified | **Grocery + Inventory** |
| `delivery.failed` | attempt failed | Grocery, exceptions |
| `delivery.rescheduled` | new window agreed | Grocery |
| `delivery.return_required` | return raised | returns queue |
| `delivery.returned` | return completed | **Grocery + Inventory** |
| `delivery.cancelled` | cancelled | **Grocery + Inventory** |
| `delivery.status_changed` | **every** transition | Grocery (the single subscription) |
| `integration.dead_lettered` | an outbound event gave up | monitoring |

---

## 9. Configuration

**Logistics**

```
DATABASE_URL=                      # pooler, not the IPv6-only direct host
LOGISTICS_PUBLIC_URL=
INVENTORY_API_URL=
INVENTORY_API_KEY=ic_live_...      # reservations:write + stock:read ONLY
GROCERY_STATUS_URL=                # if Q3 resolves to option (a)
GROCERY_WEBHOOK_SECRET=            # shared HMAC secret
GROCERY_SUPABASE_URL=              # interim poller only
GROCERY_SUPABASE_SERVICE_KEY=      # interim poller only; delete with the scaffold
INBOUND_WEBHOOK_SECRET=            # Grocery -> logistics HMAC
PROOF_BUCKET=
PROOF_SIGNED_URL_TTL_SECONDS=300
OTP_TTL_SECONDS=900
ASSIGNMENT_ACCEPT_TIMEOUT_SECONDS=120
STUCK_DELIVERY_MINUTES=60
```

**Grocery (additive, pending Q3)**

```
LOGISTICS_API_URL=
LOGISTICS_API_KEY=lg_live_...
LOGISTICS_WEBHOOK_SECRET=
```

Secrets are managed by the platform's secret store, never committed, and rotate without a
code change. Both the inbound and outbound HMAC secrets support a grace period during
rotation — the verifier accepts the previous secret for one window.

---

## 10. Open contract questions

Blocking items, tracked in [`03-open-questions.md`](03-open-questions.md): **Q1** (address),
**Q2** (pickup location), **Q3** (may Grocery change), **Q4** (reservation ids).
Q1 and Q4 in particular determine whether §3 can be honoured as written.
