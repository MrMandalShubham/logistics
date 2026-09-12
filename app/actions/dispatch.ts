"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { pool } from "@/lib/db";
import { COOKIE_NAME, hashToken } from "@/lib/auth/session";
import { dispatchError } from "@/lib/fleet/dispatch";
import { logger } from "@/lib/logging";

/**
 * The server actions behind the dispatch buttons.
 *
 * Every one of these runs through the SAME claims-and-RLS path an API
 * request takes, and calls the SAME database functions. A button
 * cannot do anything the API could not, and neither can do anything
 * the database has not agreed to.
 *
 * They return a message rather than throwing, because a dispatcher
 * who clicks Assign a second too late should see "somebody else took
 * it" on the board, not an error page.
 */

type Result = { ok: boolean; message: string };

async function withSession<T>(
  fn: (db: import("pg").PoolClient) => Promise<T>,
): Promise<T | null> {
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  if (!token) return null;

  const db = await pool.connect();
  try {
    const { rows: [c] } = await db.query(
      "select identity.resolve_session($1) as claims", [hashToken(token)]);
    if (!c?.claims) return null;

    await db.query("begin");
    await db.query("select set_config('request.jwt.claims',$1,true)",
      [JSON.stringify(c.claims)]);
    await db.query("set local role authenticated");

    const out = await fn(db);
    await db.query("commit");
    return out;
  } catch (e) {
    await db.query("rollback").catch(() => {});
    throw e;
  } finally {
    db.release();
  }
}

/** Turn a database refusal into something worth reading on a screen. */
function explain(e: unknown): string {
  const mapped = dispatchError(e);
  if (mapped) return mapped.message;

  const raw = (e as { message?: string })?.message ?? String(e);
  const named = /^([A-Z_]{3,}):\s*(.*)$/s.exec(raw);
  if (named) return named[2];

  logger.error("dispatch action failed", { err: raw });
  return "Something went wrong.";
}

export async function assignDelivery(deliveryId: string, riderId: string): Promise<Result> {
  try {
    const done = await withSession(async (db) => {
      await db.query("select fleet.assign_delivery($1,$2,120)", [deliveryId, riderId]);
      return true;
    });
    if (!done) return { ok: false, message: "Your session has expired. Sign in again." };

    revalidatePath("/dispatch");
    revalidatePath(`/deliveries/${deliveryId}`);
    return { ok: true, message: "Assigned." };
  } catch (e) {
    return { ok: false, message: explain(e) };
  }
}

export async function reassignDelivery(
  deliveryId: string, riderId: string, reason: string,
): Promise<Result> {
  if (!reason?.trim()) {
    return { ok: false, message: "Give a reason — it goes on the delivery's record." };
  }
  try {
    const done = await withSession(async (db) => {
      await db.query("select fleet.reassign_delivery($1,$2,$3)",
        [deliveryId, riderId, reason.trim()]);
      return true;
    });
    if (!done) return { ok: false, message: "Your session has expired. Sign in again." };

    revalidatePath("/dispatch");
    revalidatePath(`/deliveries/${deliveryId}`);
    return { ok: true, message: "Reassigned." };
  } catch (e) {
    return { ok: false, message: explain(e) };
  }
}

export async function setRiderAvailability(
  riderId: string, online: boolean, reason?: string,
): Promise<Result> {
  try {
    const done = await withSession(async (db) => {
      await db.query("select fleet.set_availability($1,$2,$3)",
        [riderId, online, reason ?? null]);
      return true;
    });
    if (!done) return { ok: false, message: "Your session has expired. Sign in again." };

    revalidatePath("/dispatch");
    revalidatePath("/riders");
    return { ok: true, message: online ? "Online." : "Offline." };
  } catch (e) {
    return { ok: false, message: explain(e) };
  }
}

export async function setRiderStatus(
  riderId: string, status: string, reason?: string,
): Promise<Result> {
  try {
    const done = await withSession(async (db) => {
      await db.query("select fleet.set_rider_status($1,$2,$3)",
        [riderId, status, reason ?? null]);
      return true;
    });
    if (!done) return { ok: false, message: "Your session has expired. Sign in again." };

    revalidatePath("/riders");
    revalidatePath("/dispatch");
    return { ok: true, message: `Rider is now ${status.toLowerCase()}.` };
  } catch (e) {
    return { ok: false, message: explain(e) };
  }
}

/** Used by the delivery detail page, where a dispatcher may admit. */
export async function admitDelivery(deliveryId: string): Promise<Result> {
  try {
    const done = await withSession(async (db) => {
      await db.query("select delivery.transition($1,'READY_FOR_ASSIGNMENT','admitted',null)",
        [deliveryId]);
      return true;
    });
    if (!done) return { ok: false, message: "Your session has expired. Sign in again." };

    revalidatePath("/deliveries");
    revalidatePath(`/deliveries/${deliveryId}`);
    revalidatePath("/dispatch");
    return { ok: true, message: "Admitted to the dispatch queue." };
  } catch (e) {
    return { ok: false, message: explain(e) };
  }
}
