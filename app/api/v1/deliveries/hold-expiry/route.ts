import { apiRoute } from "@/lib/api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/deliveries/hold-expiry?within_minutes=30
 *
 * Deliveries whose inventory hold is about to lapse.
 *
 * ── Why this report exists ──
 *
 * A hold expires 30 minutes after checkout, and logistics cannot call
 * confirm to stop it: reserve returns the reservation ids and nothing
 * else ever does (open question Q4). So a delivery that sits in the
 * queue too long quietly loses its stock, and the first anyone would
 * know is a rider standing in a shop holding nothing.
 *
 * This turns that into something an operator can see coming. It is a
 * mitigation, not a fix. The fix is Q4.
 */
export const GET = apiRoute(
  { permission: "deliveries:read", scope: "deliveries:read" },
  async (ctx) => {
    const within = Math.min(
      Number(new URL(ctx.req.url).searchParams.get("within_minutes") ?? 30) || 30,
      1440);

    const { rows } = await ctx.db.query(
      `select id, tracking_id, external_order_id, status, pickup_location_code,
              hold_status, hold_expires_at,
              round(extract(epoch from (hold_expires_at - now())) / 60)::int
                as minutes_remaining
         from delivery.delivery
        where status not in ('DELIVERED','RETURNED','CANCELLED')
          and not hold_confirmed
          and (
            -- lapsing soon, or already gone
            (hold_status = 'held' and hold_expires_at is not null
             and hold_expires_at < now() + make_interval(mins => $1))
            -- or never verified at all, because Inventory was down
            or hold_status = 'unknown')
        order by hold_expires_at nulls last`,
      [within]);

    return {
      body: {
        within_minutes: within,
        at_risk: rows,
        count: rows.length,
        why: rows.length
          ? "These deliveries may lose their inventory hold before dispatch. See open question Q4."
          : undefined,
      },
    };
  },
);
