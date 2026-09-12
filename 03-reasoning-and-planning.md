# Logistics System — Reasoning and Planning

## 1. Purpose

This document defines how the system reasons about fulfillment decisions. It separates deterministic business rules from optimization and AI recommendations.

## 2. Decision hierarchy

Use this order:

1. Safety, legal, payment, and inventory correctness.
2. Customer promise and serviceability.
3. Operational capacity.
4. Delivery cost and efficiency.
5. Convenience and optimization.

A cheaper decision must never violate inventory correctness, customer policy, or rider safety.

## 3. Deterministic decisions

The following decisions should be implemented as explicit rules:

- Is the address serviceable?
- Is payment confirmed or COD allowed?
- Is inventory reserved?
- Which fulfillment locations are eligible?
- Is the order ready for dispatch?
- Which riders are eligible for a zone?
- Is proof of delivery sufficient?
- Can a return be accepted?
- Does a manual override require approval?

Rules must be versioned and auditable.

## 4. Fulfillment location selection

Inputs:

- Reserved stock availability.
- Distance to customer.
- Delivery zone.
- Fulfillment location operating hours.
- Current pick-pack queue.
- Rider capacity.
- Promised delivery slot.
- Product restrictions such as temperature or fragility.

Example decision process:

1. Remove locations that cannot fulfill all required items.
2. Remove locations outside the customer’s service zone.
3. Remove locations that cannot meet the delivery window.
4. Rank remaining locations by customer promise, distance, and workload.
5. Choose one location unless splitting is explicitly enabled.
6. Record the reason and input snapshot.

## 5. Rider assignment reasoning

Inputs:

- Rider online status.
- Current location.
- Existing route.
- Vehicle capacity.
- Zone permissions.
- Shift and break status.
- Order size and special handling.
- Delivery slot.
- Estimated travel time.

V1 can use a score:

`assignment_score = proximity_score + capacity_score + zone_score + SLA_score - workload_penalty`

Do not hide the score. Admin should be able to see why a rider was suggested.

## 6. Batching reasoning

Orders may be batched when:

- Destinations are geographically close.
- Delivery windows overlap.
- Package volume fits the rider’s capacity.
- Product handling requirements are compatible.
- The batch does not threaten existing promises.

Never batch merely to increase rider utilization if it creates late deliveries.

## 7. ETA reasoning

ETA should be based on:

- Current rider position.
- Remaining stops.
- Route travel estimate.
- Service time per stop.
- Traffic or provider estimate.
- Warehouse handoff delay.
- Historical delivery duration.

Display ETA as a range when confidence is low. Store the inputs used to produce every customer-facing estimate.

## 8. Exception reasoning

When an event fails, the system should:

1. Detect the failure.
2. Classify it with a reason code.
3. Determine whether it is recoverable automatically.
4. Apply safe reversible action if policy permits.
5. Escalate to the correct team.
6. Notify affected users.
7. Record the final resolution.

Examples:

- Stock reservation failure: stop fulfillment and request reallocation.
- Customer unreachable: allow configured retry timer, then escalate.
- Rider unavailable: return assignment to dispatch queue.
- Payment mismatch: block completion and send to finance review.
- Damaged order: capture proof and initiate replacement or return policy.

## 9. AI decision boundaries

AI can recommend:

- Better fulfillment location.
- Delivery batch grouping.
- Rider reassignment.
- Delay risk.
- Likely stock or address issue.
- Customer communication draft.
- Root cause of repeated failures.

AI should not independently:

- Change stock quantities.
- Approve a refund above policy limits.
- Mark an order delivered without proof.
- Penalize a rider.
- Override a payment or safety control.
- Expose private customer data.

## 10. Planning horizons

Operational planning:

- Real-time: current order, rider, and exception decisions.
- Intraday: capacity, delivery slots, workload balancing.
- Daily: staffing, rider shifts, expected demand.
- Weekly: service zones, vendor performance, route patterns.
- Strategic: hub expansion, delivery economics, product availability.

## 11. Planning outputs

Every planning run should produce:

- Recommendation.
- Input snapshot.
- Assumptions.
- Confidence.
- Expected benefit.
- Risks.
- Required approval.
- Expiry time.
- Actual outcome for later evaluation.

## 12. Claude Code implementation guidance

Create a decision package for every decision:

```ts
export type DecisionPackage = {
  decisionType: string;
  inputSnapshot: Record<string, unknown>;
  candidates: Array<Record<string, unknown>>;
  selectedCandidate?: Record<string, unknown>;
  rulesApplied: string[];
  score?: number;
  confidence?: number;
  requiresApproval: boolean;
  explanation: string;
  createdAt: string;
};
```

Keep decision calculation in domain services. LLMs may explain or recommend, but the final state transition must be validated by deterministic domain rules.