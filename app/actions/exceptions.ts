"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { pool } from "@/lib/db";
import { COOKIE_NAME, hashToken } from "@/lib/auth/session";
import { logger } from "@/lib/logging";

/**
 * The dispatcher's decisions.
 *
 * Every one of these is a person choosing what happened when the
 * system could not work it out. They all run through the same
 * claims-and-RLS path an API request takes, and they all delegate the
 * actual rule to a function in the database — so "who may resolve a
 * conflict" has one answer, in one place, and a screen cannot become
 * a second one.
 */
async function withSession<T>(fn: (db: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  if (!token) throw new Error("Your session has expired. Sign in again.");

  const db = await pool.connect();
  try {
    const { rows: [c] } = await db.query(
      "select identity.resolve_session($1) as claims", [hashToken(token)]);
    if (!c?.claims) throw new Error("Your session has expired. Sign in again.");

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

/** Strip the Postgres error prefix — the message after it is the useful half. */
function readable(e: unknown): string {
  const m = (e as { message?: string })?.message ?? String(e);
  const i = m.indexOf(": ");
  return i > 0 && /^[A-Z_]+$/.test(m.slice(0, i)) ? m.slice(i + 2) : m;
}

export type ActionResult = { ok: boolean; message: string };

function refresh(deliveryId?: string) {
  revalidatePath("/exceptions");
  revalidatePath("/dispatch");
  if (deliveryId) revalidatePath(`/deliveries/${deliveryId}`);
}

export async function resolveException(formData: FormData): Promise<ActionResult> {
  const id = String(formData.get("exception_id") ?? "");
  const code = String(formData.get("resolution_code") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();

  try {
    const r = await withSession(async (db) =>
      (await db.query("select delivery.resolve_exception($1,$2,$3) as r",
        [id, code, note || null])).rows[0].r);
    refresh();
    return { ok: true, message: r === "ALREADY_RESOLVED"
      ? "Somebody resolved this already — their reason was kept."
      : "Resolved." };
  } catch (e) {
    logger.warn("resolve exception refused", { err: readable(e) });
    return { ok: false, message: readable(e) };
  }
}

export async function resolveConflict(formData: FormData): Promise<ActionResult> {
  const eventId = String(formData.get("event_id") ?? "");
  const decision = String(formData.get("decision") ?? "");
  const toStatus = String(formData.get("to_status") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();

  try {
    const r = await withSession(async (db) =>
      (await db.query("select integration.resolve_conflict($1,$2,$3,$4) as r",
        [eventId, decision, toStatus || null, note])).rows[0].r);
    refresh(r?.delivery_id);
    return { ok: true, message: r?.moved_to
      ? `Decided: ${decision}. The delivery is now ${r.moved_to}.`
      : `Decided: ${decision}. The delivery did not move.` };
  } catch (e) {
    logger.warn("resolve conflict refused", { err: readable(e) });
    return { ok: false, message: readable(e) };
  }
}

export async function resolveDisputedProof(formData: FormData): Promise<ActionResult> {
  const deliveryId = String(formData.get("delivery_id") ?? "");
  const outcome = String(formData.get("outcome") ?? "");
  const note = String(formData.get("note") ?? "").trim();

  try {
    await withSession((db) =>
      db.query("select delivery.resolve_disputed_proof($1,$2,$3)",
        [deliveryId, outcome, note]));
    refresh(deliveryId);
    return { ok: true, message: outcome === "DELIVERED"
      ? "Recorded as delivered. The commit to Inventory is queued."
      : "Recorded as failed. The rider still has the parcel." };
  } catch (e) {
    logger.warn("resolve disputed proof refused", { err: readable(e) });
    return { ok: false, message: readable(e) };
  }
}

export async function rescheduleDelivery(formData: FormData): Promise<ActionResult> {
  const deliveryId = String(formData.get("delivery_id") ?? "");
  const note = String(formData.get("note") ?? "").trim();

  try {
    const r = await withSession(async (db) =>
      (await db.query("select delivery.reschedule($1,$2) as r",
        [deliveryId, note || null])).rows[0].r);
    refresh(deliveryId);
    return {
      ok: true,
      message: r?.parcel_with_rider_id
        // The one thing a dispatcher must not be allowed to assume.
        ? "Back in the queue. The parcel is still with the previous rider — " +
          "the next assignment says to collect it from them, not from the shop."
        : "Back in the queue. The parcel is at the shop.",
    };
  } catch (e) {
    logger.warn("reschedule refused", { err: readable(e) });
    return { ok: false, message: readable(e) };
  }
}

export async function requireReturn(formData: FormData): Promise<ActionResult> {
  const deliveryId = String(formData.get("delivery_id") ?? "");
  const note = String(formData.get("note") ?? "").trim();

  try {
    const r = await withSession(async (db) =>
      (await db.query("select delivery.require_return($1,$2) as r",
        [deliveryId, note || null])).rows[0].r);
    refresh(deliveryId);
    return { ok: true,
      message: `Return ordered. The rider brings it back to ${r?.return_to}.` };
  } catch (e) {
    logger.warn("require return refused", { err: readable(e) });
    return { ok: false, message: readable(e) };
  }
}
