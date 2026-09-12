import { apiRoute } from "@/lib/api/handler";
import { hashPassword, verifyPassword } from "@/lib/auth/password";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/auth/password   { current_password, new_password }
 *
 * The one route reachable while must_change_password is set -- the
 * wrapper allows this path specifically, so somebody handed a
 * temporary password can get out of it and do nothing else until
 * they have.
 *
 * Changing a password revokes every OTHER session for that user
 * (identity.set_password). A password change that leaves an intruder
 * logged in has not changed much.
 */
export const POST = apiRoute({ auth: "session" }, async (ctx) => {
  const current = String(ctx.body?.current_password ?? "");
  const next = String(ctx.body?.new_password ?? "");

  if (!current || !next) {
    return {
      status: 400,
      body: { error: { code: "bad_request",
                       message: "Send { current_password, new_password }." } },
    };
  }

  if (next === current) {
    return {
      status: 422,
      body: { error: { code: "password_unchanged",
                       message: "The new password must differ from the current one." } },
    };
  }

  const { rows } = await ctx.db.query(
    "select identity.password_hash_for($1) as hash", [ctx.claims.email]);

  const ok = await verifyPassword(current, rows[0]?.hash ?? "");
  if (!ok) {
    return {
      status: 401,
      body: { error: { code: "invalid_credentials",
                       message: "The current password is wrong." } },
    };
  }

  let hash: string;
  try {
    hash = await hashPassword(next);
  } catch (e: any) {
    return {
      status: 422,
      body: { error: { code: "password_too_short",
                       message: "Use at least 12 characters." } },
    };
  }

  await ctx.db.query("select identity.set_password($1,$2)", [ctx.userId, hash]);

  return { body: { ok: true, message: "Password changed. Other sessions were signed out." } };
});
