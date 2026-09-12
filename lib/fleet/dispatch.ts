import type { PoolClient } from "pg";

/**
 * Reading the dispatch picture.
 *
 * The writes live in SQL — `fleet.assign_delivery`, `respond_to_assignment`,
 * `reassign_delivery` — because that is where the row locks and the
 * unique index are, and a rule enforced anywhere else is a rule a
 * future route can forget.
 *
 * This file is the read side, shared by the API and the screens so
 * they cannot disagree about what "available" means.
 */

export type DispatchRider = {
  id: string;
  code: string;
  display_name: string;
  phone: string;
  vehicle_type: string;
  home_location_code: string | null;
  status: string;
  is_online: boolean;
  active_count: number;
  max_concurrent: number;
  /** Null when the rider can take work. Otherwise why not. */
  unavailable_reason: string | null;
};

/**
 * Riders, with why each one can or cannot take work.
 *
 * Unavailable riders are RETURNED, not filtered out. A dispatcher
 * looking for somebody needs to know the difference between "offline",
 * "suspended" and "already carrying one" — a name that silently
 * vanishes from the list just looks like a missing rider.
 */
export async function ridersForDispatch(
  db: PoolClient,
  locationCode?: string | null,
): Promise<DispatchRider[]> {
  const { rows } = await db.query(
    `select id, code, display_name, phone, vehicle_type, home_location_code,
            status, is_online, active_count, max_concurrent,
            fleet.unavailable_reason(id) as unavailable_reason
       from fleet.rider_current
      where status <> 'OFFBOARDED'
        and ($1::text is null or home_location_code is null
             or home_location_code = upper($1))
      order by (fleet.unavailable_reason(id) is null) desc,
               active_count, code`,
    [locationCode ?? null]);

  return rows as DispatchRider[];
}

/** Deliveries waiting for somebody. */
export async function queueForDispatch(db: PoolClient, locationCode?: string | null) {
  const { rows } = await db.query(
    `select d.id, d.tracking_id, d.status, d.pickup_location_code,
            d.hold_status, d.hold_expires_at, d.created_at,
            a.city, a.pincode, a.recipient_name,
            (select count(*)::int from delivery.delivery_item i
              where i.delivery_id = d.id) as item_count
       from delivery.delivery d
       left join delivery.delivery_address a on a.delivery_id = d.id
      where d.status = 'READY_FOR_ASSIGNMENT'
        and ($1::text is null or d.pickup_location_code = upper($1))
      order by d.created_at`,
    [locationCode ?? null]);

  return rows;
}

/** Deliveries offered or accepted but not yet finished. */
export async function inFlight(db: PoolClient, locationCode?: string | null) {
  const { rows } = await db.query(
    `select d.id, d.tracking_id, d.status, d.pickup_location_code,
            r.code as rider_code, r.display_name as rider_name,
            asg.status as assignment_status, asg.expires_at, asg.assigned_at,
            a.city, a.pincode
       from delivery.delivery d
       join fleet.assignment asg
         on asg.delivery_id = d.id and asg.status in ('OFFERED','ACCEPTED')
       join fleet.rider r on r.id = asg.rider_id
       left join delivery.delivery_address a on a.delivery_id = d.id
      where ($1::text is null or d.pickup_location_code = upper($1))
      order by asg.assigned_at desc`,
    [locationCode ?? null]);

  return rows;
}

/**
 * Every attempt on a delivery, oldest first.
 *
 * Superseded rows are included deliberately. "Who was asked first and
 * what did they say" is the question a complaint turns on, and a
 * history that only shows the current rider cannot answer it.
 */
export async function assignmentHistory(db: PoolClient, deliveryId: string) {
  const { rows } = await db.query(
    `select asg.id, asg.status, asg.assigned_at, asg.expires_at,
            asg.responded_at, asg.decline_reason, asg.superseded_by,
            r.code as rider_code, r.display_name as rider_name
       from fleet.assignment asg
       join fleet.rider r on r.id = asg.rider_id
      where asg.delivery_id = $1
      order by asg.assigned_at, asg.id`,
    [deliveryId]);

  return rows;
}

/**
 * Turn a Postgres failure into something an operator can act on.
 *
 * 23505 here can only be the one-live-assignment index, which means a
 * second dispatcher got there first — a 409 naming who won, not a 500.
 */
export function dispatchError(e: unknown): { status: number; code: string; message: string } | null {
  const err = e as { code?: string; message?: string };
  const raw = err?.message ?? "";

  if (err?.code === "23505" && raw.includes("assignment_one_live")) {
    return {
      status: 409,
      code: "already_assigned",
      message: "Somebody else assigned this delivery a moment ago. Reload the board.",
    };
  }
  return null;
}
