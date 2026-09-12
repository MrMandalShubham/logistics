import type { PoolClient } from "pg";
import { getOrderHold } from "../inventory";
import { logger } from "../logging";

/**
 * The one ingest path.
 *
 * Whatever brings an order in -- today a signed webhook, tomorrow
 * perhaps something else -- arrives here with the same shape and the
 * same idempotency key. Keeping one command means a second source can
 * never acquire slightly different validation, which is how two
 * sources quietly diverge.
 */

export type IngestPayload = {
  external_order_id?: unknown;
  external_customer_id?: unknown;
  placed_at?: unknown;
  pickup?: { location_code?: unknown } | unknown;
  delivery_address?: Record<string, unknown> | unknown;
  items?: unknown;
  payment?: Record<string, unknown> | unknown;
  promised_window?: { from?: unknown; to?: unknown } | unknown;
};

export type Rejection = { code: string; message: string; fields?: string[] };

export type IngestResult =
  | { ok: true; deliveryId: string; trackingId: string; status: string; created: boolean }
  | { ok: false; rejection: Rejection };

const isStr = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Validate the payload shape.
 *
 * Unknown fields are IGNORED, not rejected. A sender that adds a
 * field in a minor version must not break against an older receiver;
 * that is what makes the contract's additive-change rule true rather
 * than merely stated.
 */
export function validate(p: IngestPayload): Rejection | null {
  const missing: string[] = [];

  if (!isStr(p.external_order_id)) missing.push("external_order_id");

  const pickup = p.pickup as { location_code?: unknown } | undefined;
  if (!pickup || !isStr(pickup.location_code)) missing.push("pickup.location_code");

  if (missing.length) {
    return {
      code: "schema_invalid",
      message: "Required fields are missing or empty.",
      fields: missing,
    };
  }

  // ── the address ──
  //
  // Checked as its own failure, with its own code, because it is the
  // one that will actually happen: no order in this estate carries a
  // delivery address yet (Q1). A named code makes the backlog
  // filterable on the dead-letter screen.
  const a = p.delivery_address as Record<string, unknown> | undefined;
  if (!a || typeof a !== "object") {
    return {
      code: "address_not_deliverable",
      message: "delivery_address is required. A parcel needs somewhere to go.",
      fields: ["delivery_address"],
    };
  }

  const addrMissing = (["recipient_name", "phone", "line1", "city", "pincode"] as const)
    .filter((k) => !isStr(a[k]))
    .map((k) => `delivery_address.${k}`);

  // Coordinates are required, not nice to have. A destination a rider
  // cannot navigate to is not a destination.
  if (!isNum(a.lat)) addrMissing.push("delivery_address.lat");
  if (!isNum(a.lng)) addrMissing.push("delivery_address.lng");

  if (addrMissing.length) {
    return {
      code: "address_not_deliverable",
      message: "The delivery address is incomplete or has no geocode.",
      fields: addrMissing,
    };
  }

  if (isNum(a.lat) && (a.lat < -90 || a.lat > 90)) {
    return { code: "address_not_deliverable", message: "lat is out of range.",
             fields: ["delivery_address.lat"] };
  }
  if (isNum(a.lng) && (a.lng < -180 || a.lng > 180)) {
    return { code: "address_not_deliverable", message: "lng is out of range.",
             fields: ["delivery_address.lng"] };
  }

  // ── the items ──
  if (!Array.isArray(p.items) || p.items.length === 0) {
    return { code: "schema_invalid", message: "items must be a non-empty array.",
             fields: ["items"] };
  }

  for (const [i, raw] of (p.items as unknown[]).entries()) {
    const it = raw as Record<string, unknown>;
    if (!it || typeof it !== "object" || !isStr(it.sku)) {
      return { code: "schema_invalid", message: `items[${i}].sku is required.`,
               fields: [`items[${i}].sku`] };
    }
    const q = it.quantity;
    if (!isNum(q) || !Number.isInteger(q) || q <= 0) {
      return { code: "schema_invalid",
               message: `items[${i}].quantity must be a positive whole number.`,
               fields: [`items[${i}].quantity`] };
    }
  }

  return null;
}

/**
 * Validate, check the hold, and create the delivery.
 *
 * `db` is the caller's transaction: the delivery, its snapshot and its
 * first timeline row commit together with whatever else the request
 * is doing, or none of it does.
 */
export async function ingestOrder(
  db: PoolClient,
  payload: IngestPayload,
): Promise<IngestResult> {
  const bad = validate(payload);
  if (bad) return { ok: false, rejection: bad };

  const orderId = String(payload.external_order_id);
  const locationCode = String(
    (payload.pickup as { location_code: string }).location_code).toUpperCase();

  // ── is the stock actually allocated? ──
  //
  // The delivery-ready definition says an order is only ready when
  // Inventory is really holding the goods. `held` is the one answer
  // that means yes.
  const hold = await getOrderHold(orderId);

  if (hold.status === "released" || hold.status === "delivered") {
    return {
      ok: false,
      rejection: {
        code: "hold_not_held",
        message:
          hold.status === "released"
            ? "Inventory is not holding stock for this order. It was released or never reserved."
            : "Inventory has already consumed the stock for this order.",
      },
    };
  }

  if (hold.status === "unknown") {
    // Deliberate: we do not know, and refusing would make an
    // Inventory blip look like a Grocery outage. The delivery is
    // created, flagged, and the expiry report surfaces it to a
    // dispatcher long before a rider is involved.
    logger.warn("ingesting with unverified hold", {
      external_order_id: orderId, reason: hold.unreachable,
    });
  }

  const address = payload.delivery_address as Record<string, unknown>;
  const window = (payload.promised_window ?? {}) as { from?: unknown; to?: unknown };

  // Carry reservation ids if the sender troubled to send them. Nothing
  // consumes them yet -- confirm is blocked on Q4 -- but storing them
  // costs nothing and is the whole fix on the day it unblocks.
  const items = (payload.items as Record<string, unknown>[]).map((i) => ({
    external_product_id: i.external_product_id ?? null,
    sku: String(i.sku),
    name: isStr(i.name) ? i.name : String(i.sku),
    quantity: Number(i.quantity),
    reservation_id: isStr(i.reservation_id) ? i.reservation_id : null,
  }));

  try {
    const { rows } = await db.query(
      `select * from delivery.ingest_order(
         $1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11)`,
      [
        orderId,
        isStr(payload.external_customer_id) ? payload.external_customer_id : null,
        locationCode,
        JSON.stringify(address),
        JSON.stringify(items),
        JSON.stringify(payload.payment ?? {}),
        isStr(window.from) ? window.from : null,
        isStr(window.to) ? window.to : null,
        isStr(payload.placed_at) ? payload.placed_at : null,
        hold.status,
        hold.expiresAt,
      ]);

    const r = rows[0];
    return {
      ok: true,
      deliveryId: r.delivery_id,
      trackingId: r.tracking_id,
      status: r.status,
      created: r.created,
    };
  } catch (e: any) {
    const raw = String(e?.message ?? e);

    if (raw.startsWith("UNKNOWN_PICKUP_LOCATION")) {
      return {
        ok: false,
        rejection: {
          code: "unknown_pickup_location",
          message: `${locationCode} is not a known active pickup location. ` +
                   "Run locations:sync if a shop was added recently.",
          fields: ["pickup.location_code"],
        },
      };
    }
    throw e;
  }
}
