# Logistics System — Action and Execution

## 1. Purpose

This document defines how the system converts orders, decisions, and recommendations into safe operational actions.

## 2. Action categories

### Read actions

Retrieve order status, rider location, inventory reservation state, delivery history, or policy.

### Reversible actions

Suggest a rider, create a draft batch, notify an operator, request a customer confirmation, or place an order into a review queue.

### Controlled actions

Assign a rider, cancel a delivery, reschedule, initiate a return, release a reservation, or trigger a refund. These require explicit permissions and policy validation.

### Irreversible or high-impact actions

Mark delivered, close COD reconciliation, approve large refunds, delete records, change stock, or modify financial records. These require strong authorization, audit logs, and often human approval.

## 3. Action lifecycle

Every action should follow:

1. Intent creation.
2. Validation.
3. Authorization.
4. Idempotency check.
5. Execution.
6. Event publication.
7. Notification.
8. Audit record.
9. Outcome evaluation.

## 4. Command model

Use commands for state changes and events for facts.

Examples:

- `ReserveInventoryCommand`.
- `CreatePickTaskCommand`.
- `MarkPackedCommand`.
- `AssignRiderCommand`.
- `StartDeliveryCommand`.
- `CompleteDeliveryCommand`.
- `ReportDeliveryFailureCommand`.
- `CreateReturnCommand`.

Events:

- `InventoryReserved`.
- `PickTaskCompleted`.
- `OrderPacked`.
- `RiderAssigned`.
- `DeliveryStarted`.
- `DeliveryCompleted`.
- `DeliveryFailed`.
- `ReturnCreated`.

## 5. State transition rules

Use a central state machine. Do not let every controller update status directly.

Example:

```ts
const allowedTransitions = {
  PACKED: ['READY_FOR_DISPATCH', 'CANCELLED'],
  READY_FOR_DISPATCH: ['ASSIGNED', 'CANCELLED'],
  ASSIGNED: ['OUT_FOR_DELIVERY', 'READY_FOR_DISPATCH'],
  OUT_FOR_DELIVERY: ['DELIVERED', 'FAILED', 'RETURN_REQUIRED'],
  FAILED: ['RESCHEDULED', 'RETURN_REQUIRED', 'CANCELLED'],
};
```

Actual transitions must also validate role, evidence, payment mode, and inventory consequences.

## 6. Idempotency and retries

All external commands and webhooks must support idempotency keys. Store:

- Request key.
- Actor.
- Command type.
- Payload hash.
- Result.
- Timestamp.

Retries should use exponential backoff and a dead-letter queue for unresolved failures.

## 7. Rider execution

Rider flow:

1. Rider signs in.
2. Rider goes online.
3. Dispatch assigns task or batch.
4. Rider accepts or rejects with reason.
5. Rider navigates to pickup.
6. Rider confirms pickup.
7. Rider travels to customer.
8. Rider marks arrived.
9. Rider verifies OTP or captures approved proof.
10. Rider confirms payment where applicable.
11. Rider completes delivery.
12. System publishes delivery event and updates inventory, finance, and customer views.

## 8. Offline execution

The rider app must support an offline queue for safe field actions:

- Arrived.
- Customer unreachable.
- Delivery failed.
- Proof captured.
- Delivery completed.

Sensitive actions should require server reconciliation when connectivity returns. The client must show sync status and never imply server confirmation before acknowledgment.

## 9. File and proof handling

Delivery photos and signatures should be uploaded to private object storage using short-lived signed URLs. Store metadata, not public file URLs, in the business record.

Required metadata:

- Delivery ID.
- Rider ID.
- Capture time.
- Device time.
- Server receipt time.
- Approximate GPS position according to policy.
- Proof type.
- Integrity hash.

## 10. Action APIs

Each write API should return:

- Current resource state.
- Accepted event identifier.
- Idempotency result.
- User-visible message.
- Next allowed actions.

Example:

`POST /deliveries/{id}/complete`

Request: OTP, proof metadata, payment confirmation, idempotency key.

Response: delivery status, order status, event ID, customer notification status, and any reconciliation warning.

## 11. Execution metrics

Track action success rate, retry count, command latency, dead-letter count, duplicate command count, offline sync delay, proof upload failure rate, and manual override rate.