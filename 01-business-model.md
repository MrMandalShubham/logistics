# Logistics System — Business Model

## 1. Purpose

This document defines the commercial and operational model for the logistics system connected to the customer ordering app and inventory platform.

The logistics system is the fulfillment execution layer. It receives confirmed orders, coordinates inventory allocation, warehouse preparation, dispatch, rider execution, delivery completion, returns, and operational reporting.

## 2. Product position

The platform consists of three connected surfaces:

1. Customer application — product discovery, cart, checkout, order tracking, and customer communication.
2. Inventory and fulfillment system — product catalog, stock levels, reservations, stock movements, and warehouse or branch availability.
3. Logistics platform — fulfillment orchestration, dispatch, rider operations, tracking, proof of delivery, exceptions, and returns.

The logistics platform should not become a second inventory ledger. Inventory remains the source of truth for stock quantities and movements. Logistics consumes stock availability and reservation results, then sends fulfillment events back to inventory.

## 3. Target operating model

The initial model is a grocery or retail delivery network with one central hub and one or more branches, stores, or fulfillment points. Orders may be fulfilled from a single location in V1. Multi-location splitting can be introduced later.

A typical order journey is:

Customer places order → payment is confirmed → stock is reserved → fulfillment location is selected → items are picked → order is packed → rider is assigned → rider delivers → proof is captured → order is closed.

## 4. Customers and users

### Customer

Needs reliable availability, accurate delivery promises, live status, simple communication, and safe handling of refunds or returns.

### Operations manager

Needs visibility into all active orders, delays, exceptions, rider availability, capacity, and service-level performance.

### Warehouse operator

Needs an efficient pick-and-pack workflow with barcode support, shortage handling, substitutions, and handoff confirmation.

### Dispatcher

Needs to assign riders, create delivery batches, monitor routes, and recover from delays or rider failures.

### Rider

Needs a simple mobile workflow for accepting jobs, navigation, customer contact, COD, proof of delivery, and issue reporting.

### Administrator

Needs configuration, permissions, audit history, integrations, reports, and governance controls.

## 5. Value proposition

The product should create value by:

- Reducing manual coordination between order, inventory, warehouse, dispatcher, and rider teams.
- Preventing orders from being dispatched without confirmed stock.
- Increasing on-time delivery and reducing failed attempts.
- Giving customers accurate status and delivery visibility.
- Creating a reliable operational history for every order and delivery.
- Making performance measurable at warehouse, zone, rider, and order level.

## 6. Revenue and cost model

Possible business models:

### Internal operations platform

The system supports the company’s own retail or grocery business. The value is measured through lower fulfillment cost, better conversion, lower cancellation, and improved customer retention.

### Multi-store logistics platform

Stores or vendors pay a monthly subscription, per-order fee, or percentage of delivery value.

### Third-party logistics service

Businesses pay for fulfillment, delivery, reverse logistics, and optional analytics.

### Hybrid model

A base subscription covers software, while order processing, delivery, COD handling, and premium features are charged separately.

Recommended starting model: build the software so it supports internal operations first, while keeping tenant, store, and service-zone boundaries ready for future multi-business use.

## 7. Cost centers

Track these costs from the beginning:

- Rider payout or delivery partner charges.
- Fuel, vehicle, and maintenance costs.
- Packaging material.
- Warehouse labor.
- Payment gateway and COD handling fees.
- Refunds, replacements, and failed delivery costs.
- Customer support and operational staff.
- Maps, SMS, WhatsApp, cloud, and observability services.

## 8. Unit economics

At order level, calculate:

- Gross merchandise value.
- Delivery fee collected.
- Discount and promotion cost.
- Packaging cost.
- Rider cost.
- Payment cost.
- Refund or replacement cost.
- Support cost.
- Contribution margin.

A useful first formula is:

`Contribution margin = customer revenue - product cost - delivery cost - packaging cost - payment cost - refund cost - variable support cost`

## 9. Success metrics

Business metrics:

- Completed orders per day.
- Repeat purchase rate.
- Average order value.
- Contribution margin per order.
- Cancellation rate.
- Customer retention.

Operations metrics:

- Order-to-dispatch time.
- Pick accuracy.
- Fill rate.
- On-time delivery rate.
- First-attempt delivery success.
- Average delivery duration.
- Rider utilization.
- Cost per delivered order.
- Return rate.

## 10. Business rules

- A delivery cannot be assigned before the order is packed and marked ready for dispatch.
- A packed order cannot be canceled without an inventory and refund decision.
- Delivery completion requires proof of delivery or an authorized manual override.
- Every exception must have a reason code.
- COD orders must have a financial reconciliation record.
- Inventory changes must be produced by inventory services or approved integration events.
- Manual status changes require permission and audit logging.

## 11. Recommended business scope

V1 should support one business, multiple fulfillment locations, internal riders, COD and online payment, scheduled or same-day delivery, returns, and operational reporting.

Avoid in V1:

- Complex marketplace settlement.
- Dynamic pricing for thousands of carriers.
- Full fleet maintenance management.
- Autonomous route optimization.
- AI-driven automatic decisions without human review.

## 12. Product principles

- Inventory accuracy before delivery speed.
- Exceptions are first-class workflows.
- Every event must be traceable.
- The rider app must remain fast under poor network conditions.
- Customer promises must be based on operational capacity, not only distance.
- Automation should assist operators, not hide decisions.