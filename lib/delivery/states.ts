/**
 * The delivery state machine, mirrored from the database.
 *
 * ── This is a MIRROR, not the rule ──
 *
 * delivery.allowed_next() in migration 0005 is the enforcement point.
 * This copy exists so the UI can grey out a button it knows will be
 * refused, and so a handler can fail fast without a round trip.
 *
 * A test asserts the two agree. If they ever drift, the database
 * wins and the test goes red -- which is the only arrangement where
 * a mirror is safe to keep.
 */

export const STATUSES = [
  "RECEIVED",
  "READY_FOR_ASSIGNMENT",
  "ASSIGNED",
  "ACCEPTED",
  "PICKUP_PENDING",
  "PICKED_UP",
  "OUT_FOR_DELIVERY",
  "ARRIVED",
  "DELIVERED",
  "DELIVERY_FAILED",
  "RESCHEDULE_REQUIRED",
  "RETURN_REQUIRED",
  "RETURN_IN_TRANSIT",
  "RETURNED",
  "CANCELLED",
] as const;

export type DeliveryStatus = (typeof STATUSES)[number];

/**
 * Widened in Phase 3 to reach ASSIGNED and ACCEPTED.
 *
 * ASSIGNED -> READY_FOR_ASSIGNMENT covers three different things —
 * declined, expired, and taken back by a dispatcher — told apart by
 * the reason on the timeline rather than by three states.
 *
 * Phase 4 adds PICKUP_PENDING after ACCEPTED.
 */
export const ALLOWED_NEXT: Partial<Record<DeliveryStatus, DeliveryStatus[]>> = {
  RECEIVED: ["READY_FOR_ASSIGNMENT", "CANCELLED"],
  READY_FOR_ASSIGNMENT: ["ASSIGNED", "CANCELLED"],
  ASSIGNED: ["ACCEPTED", "READY_FOR_ASSIGNMENT", "CANCELLED"],
  ACCEPTED: ["PICKUP_PENDING", "READY_FOR_ASSIGNMENT", "CANCELLED"],
  PICKUP_PENDING: ["PICKED_UP", "DELIVERY_FAILED", "CANCELLED"],
  PICKED_UP: ["OUT_FOR_DELIVERY", "DELIVERY_FAILED"],
  OUT_FOR_DELIVERY: ["ARRIVED", "DELIVERY_FAILED"],
  ARRIVED: ["DELIVERED", "DELIVERY_FAILED"],
  DELIVERY_FAILED: ["RESCHEDULE_REQUIRED", "RETURN_REQUIRED"],
  RESCHEDULE_REQUIRED: ["READY_FOR_ASSIGNMENT", "RETURN_REQUIRED"],
  // Phase 6 completes the return.
  RETURN_REQUIRED: ["RETURN_IN_TRANSIT"],
  RETURN_IN_TRANSIT: ["RETURNED"],
};

/** The step a rider takes next, and what to call the button. */
export const RIDER_STEP: Partial<Record<DeliveryStatus, { to: DeliveryStatus; label: string }>> = {
  ACCEPTED:         { to: "PICKUP_PENDING",   label: "Going to collect" },
  PICKUP_PENDING:   { to: "PICKED_UP",        label: "I have the parcel" },
  PICKED_UP:        { to: "OUT_FOR_DELIVERY", label: "On my way" },
  OUT_FOR_DELIVERY: { to: "ARRIVED",          label: "I have arrived" },
};

/** Location is recorded only while a parcel is actually being carried. */
export function isCarrying(status: DeliveryStatus): boolean {
  return status === "PICKED_UP" || status === "OUT_FOR_DELIVERY" || status === "ARRIVED";
}

export function allowedNext(from: DeliveryStatus): DeliveryStatus[] {
  return ALLOWED_NEXT[from] ?? [];
}

export function canTransition(from: DeliveryStatus, to: DeliveryStatus): boolean {
  return allowedNext(from).includes(to);
}

/** Terminal in the sense that nothing may follow it. */
export function isTerminal(status: DeliveryStatus): boolean {
  return allowedNext(status).length === 0;
}

/** How a status reads on a screen. */
export const LABELS: Record<string, string> = {
  RECEIVED: "Received",
  READY_FOR_ASSIGNMENT: "Ready to assign",
  ASSIGNED: "Assigned",
  ACCEPTED: "Accepted",
  PICKUP_PENDING: "Pickup pending",
  PICKED_UP: "Picked up",
  OUT_FOR_DELIVERY: "Out for delivery",
  ARRIVED: "Arrived",
  DELIVERED: "Delivered",
  DELIVERY_FAILED: "Delivery failed",
  RESCHEDULE_REQUIRED: "Reschedule required",
  RETURN_REQUIRED: "Return required",
  RETURN_IN_TRANSIT: "Return in transit",
  RETURNED: "Returned",
  CANCELLED: "Cancelled",
};
