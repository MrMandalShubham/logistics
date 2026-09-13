"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { pool } from "@/lib/db";
import { COOKIE_NAME, hashToken } from "@/lib/auth/session";
import { logger } from "@/lib/logging";

/**
 * Setting where a shop is.
 *
 * The rule this screen exists to change is written down in
 * 0013_geography.sql: `location_ref` is a cache of Inventory's names
 * and types, and — since Phase 8 — the local owner of coordinates,
 * because Inventory has never had the field and geography is not its
 * fact to own.
 *
 * Validation lives in the database, not here. A latitude of 72 is
 * refused by `set_location_geo`, so the API, a script and this form
 * all get the same answer.
 */
export type LocationResult = { ok: boolean; message: string };

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

function readable(e: unknown): string {
  const m = (e as { message?: string })?.message ?? String(e);
  const i = m.indexOf(": ");
  return i > 0 && /^[A-Z_]+$/.test(m.slice(0, i)) ? m.slice(i + 2) : m;
}

export async function setLocationGeo(formData: FormData): Promise<LocationResult> {
  const code = String(formData.get("code") ?? "").trim();
  const lat = Number(String(formData.get("lat") ?? "").trim());
  const lng = Number(String(formData.get("lng") ?? "").trim());
  const radiusRaw = String(formData.get("radius_km") ?? "").trim();
  const radius = radiusRaw === "" ? null : Number(radiusRaw);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { ok: false, message: "A latitude and a longitude, both numbers." };
  }

  try {
    const r = await withSession(async (db) =>
      (await db.query("select integration.set_location_geo($1,$2,$3,$4) as r",
        [code, lat, lng, radius])).rows[0].r);

    revalidatePath("/locations");
    revalidatePath("/dispatch");

    return {
      ok: true,
      message: `${r.code} is at ${r.lat}, ${r.lng}, serving ${r.radius_km} km. ` +
               "Dispatch can rank riders by distance from here now.",
    };
  } catch (e) {
    logger.warn("set location geo refused", { code, err: readable(e) });
    return { ok: false, message: readable(e) };
  }
}
