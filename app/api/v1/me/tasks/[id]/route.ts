import { apiRoute } from "@/lib/api/handler";
import { RIDER_STEP, isCarrying } from "@/lib/delivery/states";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/me/tasks/:id — the task in front of me.
 *
 * Row-level security decides whether this rider may see it, so a
 * delivery that is not theirs simply is not there: 404, not 403.
 *
 * The phone number is absent. `POST .../contact` reveals it, once,
 * and records who asked.
 */
export const GET = apiRoute({ auth: "session" }, async (ctx) => {
  const { rows: [d] } = await ctx.db.query(
    `select id, tracking_id, status, pickup_location_code,
            payment_method, is_prepaid, amount_to_collect_paise,
            promised_from, promised_to
       from delivery.delivery where id = $1`, [ctx.params.id]);

  if (!d) {
    return { status: 404, body: { error: { code: "not_found",
                                           message: "That task is not yours." } } };
  }

  const [address, items] = await Promise.all([
    ctx.db.query(
      `select recipient_name, line1, line2, city, state, pincode, lat, lng, instructions
         from delivery.delivery_address where delivery_id = $1`, [ctx.params.id]),
    ctx.db.query(
      `select sku, name, quantity from delivery.delivery_item
        where delivery_id = $1 order by name`, [ctx.params.id]),
  ]);

  const a = address.rows[0] ?? null;
  const step = RIDER_STEP[d.status as keyof typeof RIDER_STEP] ?? null;

  return {
    body: {
      task: d,
      address: a,
      items: items.rows,
      // A plain maps link. No SDK, no key, works on every phone.
      navigation_url: a
        ? `https://www.google.com/maps/dir/?api=1&destination=${a.lat},${a.lng}`
        : null,
      next_step: step,
      can_complete: d.status === "ARRIVED",
      accepts_location: isCarrying(d.status),
    },
  };
});
