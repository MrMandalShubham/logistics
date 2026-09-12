import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { COOKIE_NAME, hashToken, cookieOptions } from "@/lib/auth/session";
import { correlationId } from "@/lib/logging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/auth/sign-out
 *
 * Always 200, even with no cookie or an already-dead session. Signing
 * out is a request to end up signed out, and the caller is already in
 * that state -- an error here would be a true statement that helps
 * nobody.
 *
 * The cookie is cleared whatever the database says, so a user is not
 * left holding a cookie for a session we failed to revoke.
 */
export async function POST(req: NextRequest) {
  const cid = correlationId(req);
  const token = req.cookies.get(COOKIE_NAME)?.value;

  if (token) {
    const db = await pool.connect();
    try {
      await db.query("select identity.close_session($1)", [hashToken(token)]);
    } catch {
      // Fall through: the cookie is cleared regardless.
    } finally {
      db.release();
    }
  }

  const res = NextResponse.json(
    { ok: true, as_of: new Date().toISOString() },
    { status: 200, headers: { "X-Api-Version": "v1", "X-Correlation-Id": cid } });

  res.cookies.set({ ...cookieOptions(0), value: "" });
  return res;
}
