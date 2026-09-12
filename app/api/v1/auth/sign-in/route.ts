import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { verifyPassword } from "@/lib/auth/password";
import { newToken, ttlSeconds, cookieOptions } from "@/lib/auth/session";
import { logger, correlationId } from "@/lib/logging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/auth/sign-in   { email, password }
 *
 * ── Why this route does not use the apiRoute wrapper ──
 *
 * The wrapper authenticates first. This is the route that creates
 * authentication, so it runs outside it -- and therefore has to do
 * its own careful thing at each step.
 *
 * ── Why the password is verified in Node and the rest in Postgres ──
 *
 * scrypt lives in Node. Everything else about signing in -- the
 * lockout check, the failure counter, the session row, the audit
 * entry -- happens inside identity.open_session in ONE transaction,
 * because those are the parts that must never drift apart. A counter
 * that increments without the audit row is a lockout nobody can
 * explain.
 *
 * The hash is fetched with a definer function so that a caller who
 * cannot read identity.credential (nobody can) still gets a login.
 */
export async function POST(req: NextRequest) {
  const cid = correlationId(req);
  const headers = { "X-Api-Version": "v1", "X-Correlation-Id": cid };

  let body: any = null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { code: "invalid_json", message: "The request body is not valid JSON." } },
      { status: 400, headers });
  }

  const email = String(body?.email ?? "").trim().toLowerCase();
  const password = String(body?.password ?? "");

  if (!email || !password) {
    return NextResponse.json(
      { error: { code: "bad_request", message: "Send { email, password }." } },
      { status: 400, headers });
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const ua = req.headers.get("user-agent") ?? null;

  const db = await pool.connect();
  try {
    // The stored hash, or null for an unknown address. Either way we
    // run a verification below, so an unknown email costs the same
    // time as a wrong password and cannot be probed for.
    const { rows } = await db.query(
      "select identity.password_hash_for($1) as hash", [email]);

    const stored: string | null = rows[0]?.hash ?? null;
    const DUMMY =
      "scrypt$16384$8$1$00000000000000000000000000000000$" + "0".repeat(128);

    const ok = await verifyPassword(password, stored ?? DUMMY);

    const { token, hash } = newToken();

    // open_session decides everything else and RETURNS a refusal
    // rather than raising one. That matters: a raise would roll the
    // transaction back and take the failure counter and the audit row
    // with it, so the account would never lock and a brute-force
    // attempt would leave no trace.
    const { rows: sess } = await db.query(
      "select identity.open_session($1,$2,$3,$4,$5,$6,$7) as result",
      [email, stored !== null && ok, hash, ttlSeconds("staff"), ip, ua, cid]);

    const result = sess[0].result as Record<string, any>;

    if (!result.ok) {
      const code = String(result.code);
      const status =
        code === "LOCKED_OUT" ? 423 :
        code.startsWith("ACCOUNT_") ? 403 : 401;

      logger.warn("sign-in refused", { correlation_id: cid, code });

      return NextResponse.json(
        {
          error: {
            code: code.toLowerCase(),
            message: result.message,
            ...(result.retry_after ? { retry_after: result.retry_after } : {}),
          },
        },
        {
          status,
          headers: result.retry_after
            ? { ...headers, "Retry-After": String(result.retry_after) }
            : headers,
        });
    }

    const claims = result.claims as Record<string, unknown>;
    const role = String(claims.role);
    const maxAge = ttlSeconds(role);

    const res = NextResponse.json(
      {
        ok: true,
        user: {
          id: claims.sub,
          email: claims.email,
          full_name: claims.full_name,
          role,
          permissions: claims.permissions,
          location_codes: claims.location_codes,
          must_change_password: claims.must_change_password,
        },
        as_of: new Date().toISOString(),
      },
      { status: 200, headers });

    res.cookies.set({ ...cookieOptions(maxAge), value: token });

    logger.info("sign-in", { correlation_id: cid, role, user_id: claims.sub });
    return res;
  } catch (e: any) {
    // Refusals are returned, not thrown, so anything reaching here is
    // a genuine fault on our side.
    logger.error("sign-in failed", { correlation_id: cid, err: e?.message });
    return NextResponse.json(
      { error: { code: "internal_error", message: "Something went wrong." } },
      { status: 500, headers });
  } finally {
    db.release();
  }
}
