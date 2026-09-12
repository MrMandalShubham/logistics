import { apiRoute } from "@/lib/api/handler";
import { hashPassword } from "@/lib/auth/password";
import { ridersForDispatch } from "@/lib/fleet/dispatch";
import { randomBytes } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/riders — who we have, and who can take work. */
export const GET = apiRoute(
  { permission: "riders:read", scope: "riders:read" },
  async (ctx) => {
    const location = new URL(ctx.req.url).searchParams.get("location");
    const riders = await ridersForDispatch(ctx.db, location);
    return {
      body: {
        riders,
        available: riders.filter((r) => r.unavailable_reason === null).length,
      },
    };
  },
);

/**
 * POST /api/v1/riders — onboard a rider.
 *
 * Creates BOTH a login and a profile, in one transaction. A profile
 * with no login cannot sign in; a login with no profile cannot be
 * dispatched. Neither half is worth having on its own.
 *
 * The temporary password is returned once and must be changed at
 * first sign-in — the same bootstrap as admin:create, and for the
 * same reason: no standing credential anybody can look up later.
 */
export const POST = apiRoute(
  { auth: "session", permission: "riders:write" },
  async (ctx) => {
    const { email, display_name, phone, code, vehicle_type, home_location, max_concurrent } =
      ctx.body ?? {};

    const missing = [
      !email && "email",
      !display_name && "display_name",
      !phone && "phone",
    ].filter(Boolean);

    if (missing.length) {
      return {
        status: 400,
        body: { error: { code: "bad_request",
                         message: `Required: ${missing.join(", ")}.` } },
      };
    }

    const temporary = randomBytes(18).toString("base64url");
    const hash = await hashPassword(temporary);

    try {
      const { rows: [r] } = await ctx.db.query(
        "select * from fleet.create_rider($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          String(email).trim().toLowerCase(),
          String(display_name).trim(),
          String(phone).trim(),
          hash,
          code ?? null,
          vehicle_type ?? "BIKE",
          home_location ? String(home_location).toUpperCase() : null,
          Number(max_concurrent) > 0 ? Number(max_concurrent) : 1,
        ]);

      return {
        status: 201,
        body: {
          rider: { id: r.rider_id, user_id: r.user_id, code: r.code },
          // Shown once. It is not stored anywhere and cannot be recovered.
          temporary_password: temporary,
          note: "Give this to the rider. They must change it at first sign-in.",
        },
      };
    } catch (e) {
      const err = e as { code?: string };
      if (err?.code === "23505") {
        return {
          status: 409,
          body: { error: { code: "conflict",
                           message: "That email or rider code is already taken." } },
        };
      }
      throw e;
    }
  },
);
