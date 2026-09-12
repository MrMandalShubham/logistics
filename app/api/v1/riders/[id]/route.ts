import { apiRoute } from "@/lib/api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = apiRoute(
  { permission: "riders:read", scope: "riders:read" },
  async (ctx) => {
    const { rows: [r] } = await ctx.db.query(
      `select id, code, display_name, phone, vehicle_type, home_location_code,
              status, is_online, active_count, max_concurrent, created_at,
              fleet.unavailable_reason(id) as unavailable_reason
         from fleet.rider_current where id = $1`, [ctx.params.id]);

    if (!r) {
      return { status: 404, body: { error: { code: "not_found", message: "No such rider." } } };
    }

    const { rows: recent } = await ctx.db.query(
      `select is_online, reason, occurred_at from fleet.rider_availability
        where rider_id = $1 order by occurred_at desc, id desc limit 10`, [ctx.params.id]);

    return { body: { rider: r, availability: recent } };
  },
);

/**
 * PATCH /api/v1/riders/:id   { status, reason }
 *
 * Suspend, reactivate or offboard. Offboarding also disables the
 * login — a roster change that leaves the door open is not an
 * offboarding.
 */
export const PATCH = apiRoute(
  { auth: "session", permission: "riders:write" },
  async (ctx) => {
    const status = String(ctx.body?.status ?? "").toUpperCase();

    if (!["ACTIVE", "SUSPENDED", "OFFBOARDED"].includes(status)) {
      return {
        status: 400,
        body: { error: { code: "bad_request",
                         message: "status must be ACTIVE, SUSPENDED or OFFBOARDED." } },
      };
    }

    await ctx.db.query("select fleet.set_rider_status($1,$2,$3)",
      [ctx.params.id, status, ctx.body?.reason ?? null]);

    return { body: { ok: true, status } };
  },
);
