# Logistics-Only Scope

**Date:** 2026-09-12 · **Status:** proposed, awaiting approval · **Owner:** Lead Agent
**Companion to:** [`00-existing-systems-analysis.md`](00-existing-systems-analysis.md)

This document draws the line around the logistics system. Anything not listed under
"Owned" is out of scope, and anything under "Explicitly not owned" stays with the system
that already owns it.

---

## 1. One-sentence definition

> **The logistics system takes an order that is already paid for and already reserved in
> inventory, and is accountable for it from the shop shelf to the customer's hand — including
> when that fails.**

It is the component that finally calls `POST /api/inventory/commit`, which no system in the
estate does today (analysis §14.1).

---

## 2. Owned by logistics

### 2.1 Intake
- Receiving delivery-ready orders from Grocery (signed webhook; poller as an interim scaffold).
- Creating the logistics delivery record and issuing the logistics tracking id.
- Storing a **read-only snapshot** of address, items, contact and amounts.
- Idempotent ingest keyed on `external_order_id`; replay and duplicate protection.
- Confirming the inventory reservation so the 30-minute hold stops expiring.

### 2.2 Delivery operations
- Delivery task management and the delivery state machine.
- Admin and dispatcher operations; the dispatch board.
- Rider records, rider onboarding, availability and shifts.
- Manual assignment, reassignment, and full assignment history.
- Package details (count, weight band, fragile/cold-chain flags).

### 2.3 Rider execution
- Rider authentication and the rider application.
- Online/offline availability toggle.
- Assigned task list and task detail.
- Pickup confirmation at the shop.
- Navigation hand-off and customer contact (masked where possible).
- Arrived, OTP verification, photo proof, completion.
- Failed delivery, reschedule, and return-required flows.
- Offline capture with an outbox and idempotent synchronisation.

### 2.4 Outcomes and exceptions
- Delivery status and status history.
- Rider location **during an active delivery only**.
- Proof metadata and proof file references.
- Delivery exceptions: unreachable, wrong address, refused, damaged, rider failure.
- Rescheduling.
- Return-to-store / return-to-hub workflow and return completion.
- Support notes and evidence attached to exceptions.

### 2.5 Integration and observability
- Outbound delivery-status events to Grocery (customer tracking).
- Outbound `commit` / `release` calls to Inventory.
- Logistics notifications (customer and rider).
- Delivery audit history — every transition, with actor and evidence.
- Delivery reports: active, pending assignment, failed, SLA, rider performance,
  duration, exceptions, returns, integration errors, stuck deliveries.
- Delivery monitoring, health checks, and the integration dead-letter queue.

---

## 3. Explicitly NOT owned by logistics

| Not owned | Owner |
|---|---|
| Product catalogue, categories, images | Inventory |
| Stock quantities, availability, the ledger | Inventory |
| Stock movements, transfers, receiving | Inventory |
| Purchase orders, suppliers, partners | Inventory |
| Product pricing, MRP, wholesale, landed cost | Inventory |
| Replenishment, reorder points, demand planning | Inventory |
| Inventory valuation and accounting postings | Inventory |
| Customer application, browsing, search | Grocery |
| Customer authentication and accounts | Grocery |
| Cart and checkout | Grocery |
| Customer order creation | Grocery |
| Payment processing and settlement | Grocery |
| Promo codes and discounts | Grocery |
| Customer-facing order history UI | Grocery |
| General sales management | Grocery |

**There must not be a second inventory source of truth.** Where logistics needs product
information it stores a delivery snapshot (name, sku, quantity at dispatch) or an external
reference — never a quantity it maintains, and never a price it recalculates.

---

## 4. Scope boundary tests

Applied to any proposed feature:

1. **Would it still be needed if delivery were free and instant?** → then it is not logistics.
2. **Does it change a stock number, a price, or a catalogue fact?** → Inventory owns it.
3. **Does it happen before the customer has paid?** → Grocery owns it.
4. **Does it answer "where is this parcel and who has it?"** → logistics owns it.

---

## 5. Delivery user journeys

### 5.1 Customer (served indirectly — logistics publishes, Grocery renders)
1. Places an order → sees "Order Placed".
2. Order is admitted to logistics → "Packed".
3. Rider picks up → "Out for Delivery", with rider first name and masked phone.
4. Rider arrives → "Arriving now", OTP shown to the customer.
5. Customer reads the OTP to the rider → "Delivered".
6. On failure → reason and the new promised window.

### 5.2 Dispatcher
1. Opens the delivery queue for their location.
2. Reviews orders in `RECEIVED`; confirms address and pickup point; promotes to
   `READY_FOR_ASSIGNMENT`.
3. Sees available riders on the dispatch board.
4. Assigns a delivery; sees accept/decline.
5. Monitors in-flight deliveries; reassigns on decline, timeout or rider failure.
6. Handles exceptions; approves reschedules and returns.

### 5.3 Rider
1. Signs in; goes online.
2. Receives an assignment; accepts or declines with a reason.
3. Travels to the shop; confirms pickup against the package list.
4. Navigates to the customer; contacts them if needed.
5. Marks arrived; collects the OTP; optionally takes a photo.
6. Completes — or records a failure reason and, where required, starts a return.
7. Works offline throughout; the outbox drains when connectivity returns.

### 5.4 Admin
1. Estate-wide dashboard across locations.
2. Rider management: onboarding, documents, activation, deactivation.
3. Manual status override with a mandatory reason (always audited).
4. Reports and SLA review.
5. Integration health: dead letters, stuck deliveries, failed status pushes.

---

## 6. V1 / V2 split

### V1 (Phases 1–7)
- Manual dispatcher assignment.
- One order per delivery task.
- OTP verification + optional photo proof.
- Rider app as a mobile-first PWA with an offline outbox.
- Prepaid orders only (no COD workflow — analysis §13).
- Rider location during active delivery, polled.
- Outbound status to Grocery and commit/release to Inventory.
- Exceptions, reschedules, returns to the originating shop.
- Operational reports.

### V2 (Phase 8 and beyond)
- Automatic assignment and rider scoring.
- Delivery batching and route optimisation.
- ETA prediction and delay prediction.
- Live map streaming to the customer.
- Signature capture.
- COD collection and cash reconciliation (needs a real payment model first).
- Delivery zones owned by logistics rather than Grocery's 10 km radius.
- Rider incentives and payout.
- Third-party courier fallback.

---

## 7. Acceptance criteria (V1, testable)

| # | Criterion |
|---|---|
| AC-01 | A delivery-ready order is ingested exactly once, however many times it is delivered to the endpoint |
| AC-02 | An order missing an address or a pickup location is rejected with a named error, never half-ingested |
| AC-03 | On ingest, the inventory reservation is confirmed and stops expiring |
| AC-04 | A dispatcher can assign, and a rider can accept, decline, or time out into reassignment |
| AC-05 | Only the assigned rider can act on a task; any other rider receives 403 |
| AC-06 | An invalid state transition is refused with the allowed set named |
| AC-07 | `DELIVERED` requires a valid, unexpired, unused OTP for that specific task |
| AC-08 | A delivery cannot be completed twice; the second attempt replays the first result |
| AC-09 | `DELIVERED` calls inventory `commit` **and** verifies `order_status === "delivered"` |
| AC-10 | `RETURNED` / `CANCELLED` calls inventory `release` with a reason |
| AC-11 | Every transition writes an audit row with actor, role, from, to, evidence, correlation id |
| AC-12 | Every transition emits `delivery.status_changed`, retried with backoff and dead-lettered |
| AC-13 | Grocery's `orders.status` and `logistics_tracking_id` reflect the mapping in analysis §20 |
| AC-14 | A rider offline for 30 minutes syncs without duplicating or losing a completion |
| AC-15 | Proof files are never publicly readable; access is by short-lived signed URL |
| AC-16 | Rider location is recorded only between `PICKED_UP` and a terminal state |
| AC-17 | A failed outbound status push is retried and visible on the integration health screen |
| AC-18 | A delivery with no movement for N minutes appears on the stuck-deliveries report |

---

## 8. Operational KPIs

| KPI | Definition | V1 target |
|---|---|---|
| Assignment latency | `RECEIVED` → `ASSIGNED` | p90 < 10 min |
| Acceptance rate | accepted ÷ assigned | > 90 % |
| Pickup latency | `ASSIGNED` → `PICKED_UP` | p90 < 20 min |
| Delivery duration | `PICKED_UP` → `DELIVERED` | p90 < 45 min |
| On-time rate | delivered within the promised window | > 90 % |
| First-attempt success | delivered ÷ attempted | > 95 % |
| Failure rate by reason | failures grouped by reason code | tracked, not targeted |
| Return rate | returned ÷ delivered | < 2 % |
| Commit success | commits verified `delivered` | **100 %** |
| Integration error rate | dead-lettered events ÷ total | < 0.1 % |
| Stuck deliveries | open with no transition > 60 min | 0 at close of day |
| Rider utilisation | active task time ÷ online time | tracked |

---

## 9. Out of scope for V1, stated plainly

Warehouse picking and packing, multi-parcel splitting, third-party couriers, customer-initiated
rescheduling, delivery tips, chat between rider and customer, rider payouts, vehicle and fuel
management, insurance claims, and any change to how a customer pays.
