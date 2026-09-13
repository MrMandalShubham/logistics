import { cache } from "react";
import { cookies } from "next/headers";
import { pool } from "@/lib/db";
import { COOKIE_NAME, hashToken } from "./session";

/**
 * Who is asking, resolved once per request.
 *
 * ── Why cache() ──
 *
 * The layout needs the claims to draw the navigation, and every page
 * inside it needs them to decide what the reader may do. Without
 * deduplication that is two session lookups per page — two
 * connections, two round trips — and on a managed database across a
 * slow link that is the difference between a page that feels instant
 * and one that does not.
 *
 * React's cache() lives for exactly one render pass, so the layout
 * and the page it wraps share a result and two different requests
 * never do.
 *
 * ── Why it returns null rather than throwing ──
 *
 * "No session" and "the database is unreachable" both end up here,
 * and they want different answers: the first should send somebody to
 * sign in, the second should say what is wrong. The layout redirects
 * on null; a page that cares can call resolveSession directly.
 */
export type Claims = Record<string, unknown>;

export const currentClaims = cache(async (): Promise<Claims | null> => {
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  if (!token) return null;

  const db = await pool.connect();
  try {
    const { rows: [row] } = await db.query(
      "select identity.resolve_session($1) as claims", [hashToken(token)]);
    return (row?.claims as Claims) ?? null;
  } catch {
    return null;
  } finally {
    db.release();
  }
});

/** Convenience for the common check. */
export async function can(permission: string): Promise<boolean> {
  const c = await currentClaims();
  const perms = (c?.permissions as string[]) ?? [];
  return perms.includes(permission);
}

/**
 * Run a unit of work as the signed-in reader, with RLS applied.
 *
 * The same claims-and-role dance every screen was writing out by
 * hand. Returns null when there is no session so a page can fall
 * through to the layout's redirect rather than rendering half of
 * itself.
 */
export async function withReader<T>(
  fn: (db: import("pg").PoolClient, claims: Claims) => Promise<T>,
): Promise<{ ok: true; data: T; claims: Claims } | { ok: false; error: string | null }> {
  const claims = await currentClaims();
  if (!claims) return { ok: false, error: null };

  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query("select set_config('request.jwt.claims',$1,true)",
      [JSON.stringify(claims)]);
    await db.query("set local role authenticated");
    const data = await fn(db, claims);
    await db.query("commit");
    return { ok: true, data, claims };
  } catch (e) {
    await db.query("rollback").catch(() => {});
    return { ok: false, error: (e as Error)?.message ?? "unknown error" };
  } finally {
    db.release();
  }
}
