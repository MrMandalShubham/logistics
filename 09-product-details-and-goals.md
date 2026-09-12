# Logistics System — Product Details and Goals

## 1. Product definition

The logistics system is a connected platform for managing the movement of customer orders from confirmed purchase to successful delivery or controlled return.

It includes:

- Admin operations application.
- Rider mobile application.
- Warehouse fulfillment workflow.
- Dispatch and tracking engine.
- Customer status and communication integration.
- Inventory reservation and stock-event integration.
- Returns and COD workflows.
- Reporting, audit, and optional AI assistance.

## 2. Product goal

The primary goal is to make every order operationally visible and correctly executable:

`confirmed order → correct stock → correct fulfillment location → accurate pick and pack → suitable rider → successful delivery → reconciled outcome`

## 3. Problems to solve

- Orders are manually coordinated through calls or messages.
- Customer-visible status does not match actual operations.
- Inventory is reserved incorrectly or too late.
- Dispatchers lack a complete view of rider capacity.
- Riders cannot reliably report field exceptions.
- Proof of delivery is inconsistent.
- Returns and COD reconciliation require manual effort.
- Management cannot identify the source of delays and failures.

## 4. Product boundaries

The logistics platform owns:

- Fulfillment orchestration.
- Delivery task creation.
- Dispatch and rider assignment.
- Delivery status and proof.
- Exceptions and returns execution.
- Operational notifications.
- Delivery analytics.

The inventory system owns:

- Product master where applicable.
- Stock quantities.
- Stock reservations.
- Stock movements.
- Costing and valuation.
- Replenishment decisions.

The customer app owns:

- Browsing.
- Cart and checkout.
- Customer payment initiation.
- Customer-facing order experience.
- Customer profile and addresses.

## 5. Core user journeys

### Customer order

Customer checks out, payment or COD is validated, and the order enters logistics through an idempotent integration.

### Warehouse fulfillment

System allocates location, creates pick task, validates quantities, handles shortage or substitution, and creates a package.

### Dispatch

Admin or dispatch engine selects a rider, creates task, sends notification, and monitors acceptance.

### Delivery

Rider navigates, contacts customer, verifies delivery, captures proof, confirms COD if applicable, and completes the task.

### Failed delivery

Rider selects a reason, captures evidence, and the system proposes retry, reschedule, return, or support escalation.

### Return

System schedules pickup or receives return, performs quality check, sends inventory result, and triggers refund or replacement workflow.

## 6. Primary screens

Admin:

- Dashboard.
- Order queue.
- Order detail and timeline.
- Fulfillment queue.
- Dispatch board.
- Live map.
- Riders.
- Exceptions.
- Returns.
- COD and finance.
- Reports.
- Settings and permissions.

Rider:

- Login and verification.
- Availability.
- Today’s tasks.
- Task detail.
- Pickup confirmation.
- Navigation.
- Customer contact.
- Proof of delivery.
- Failed delivery.
- Return pickup.
- Sync and support.

## 7. Core entities

- Organization.
- Fulfillment location.
- Service zone.
- Customer order.
- Order item.
- Inventory reservation reference.
- Fulfillment task.
- Pick task.
- Package.
- Delivery task.
- Delivery batch.
- Rider.
- Rider shift.
- Route stop.
- Proof of delivery.
- Exception.
- Return.
- Payment and COD reconciliation.
- Notification.
- Audit event.

## 8. Initial order statuses

- `RECEIVED`.
- `PAYMENT_PENDING`.
- `STOCK_RESERVATION_PENDING`.
- `STOCK_RESERVED`.
- `PICKING`.
- `SHORTAGE_REVIEW`.
- `PACKED`.
- `READY_FOR_DISPATCH`.
- `ASSIGNED`.
- `OUT_FOR_DELIVERY`.
- `DELIVERED`.
- `FAILED`.
- `RESCHEDULED`.
- `RETURN_REQUIRED`.
- `RETURNED`.
- `CANCELLED`.

Statuses must be separated from operational tasks where possible. An order status should summarize business state, while tasks represent work.

## 9. Product goals by release

### V1

- Reliable order ingestion.
- Inventory reservation integration.
- Pick and pack workflow.
- Admin dispatch.
- Rider delivery workflow.
- OTP and photo proof.
- Customer status updates.
- Failed delivery and returns.
- COD reconciliation.
- Basic dashboards and audit logs.

### V1.5

- Scheduled slots.
- Delivery batching.
- Better maps and ETA.
- Rider performance.
- Service-zone controls.
- Customer rescheduling.
- Operational alerts.

### V2

- Multi-location split fulfillment.
- Carrier integrations.
- Route optimization.
- Demand and capacity planning.
- AI operations copilot.
- Predictive delay detection.
- Advanced financial and partner settlement.

## 10. Non-functional goals

- Secure multi-role access.
- Strong tenant and location isolation.
- Idempotent integrations.
- Mobile resilience under weak networks.
- Full auditability.
- Scalable event processing.
- Clear operational fallbacks.
- Accessible admin interface.
- Fast rider workflow.

## 11. Product acceptance criteria

The V1 product is acceptable when:

- A confirmed customer order can be fulfilled end to end without spreadsheets.
- Inventory reservation and release are synchronized.
- Admin can see every order and stuck state.
- Rider can complete or fail a delivery with evidence.
- Customer receives accurate status.
- Operations can recover from common failures.
- Finance can reconcile COD and refunds.
- Every sensitive action is auditable.

## 12. Claude Code starting prompt

Use this instruction as the starting point after reviewing all nine documents:

> Act as a senior product engineer and systems architect. Read all logistics documentation in this folder before writing code. First inspect the repository, existing database, integrations, and deployment setup. Do not invent existing APIs. Produce an implementation map showing affected modules, entities, endpoints, events, permissions, tests, and migration risks. Then implement only the first vertical slice: order ingestion, idempotency, inventory reservation adapter, order state machine, event log, and admin order queue. Follow the documented boundaries. Keep inventory as the stock source of truth. Add tests for duplicate webhooks, invalid transitions, authorization, and reservation failure. Do not implement AI automation until deterministic workflows, audit logs, and monitoring are working.

## 13. Final product statement

This is not merely a rider tracking app. It is an operational fulfillment platform connecting customer demand, inventory truth, warehouse execution, dispatch decisions, rider action, customer communication, finance, and continuous improvement.