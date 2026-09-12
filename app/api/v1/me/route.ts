import { apiRoute } from "@/lib/api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/me — the rider's own view of themselves.
 *
 * The rider is whoever is signed in. There is no id parameter here or
 * on any /me route, so there is nothing to tamper with.
 */
export const GET = apiRoute({ auth: "session" }, async (ctx) => {
  const { rows: [r] } = await ctx.db.query(
    `select id, code, display_name, phone, vehicle_type, home_location_code,
            status, is_online, active_count, max_concurrent
       from fleet.rider_current where user_id = $1`, [ctx.userId]);

  if (!r) {
    return {
      status: 404,
      body: { error: { code: "not_a_rider",
                       message: "This account has no rider profile." } },
    };
  }

  return { body: { rider: r, permissions: ctx.permissions } };
});
