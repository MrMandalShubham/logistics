import { apiRoute } from "@/lib/api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/me/tasks — what I am carrying or have been offered.
 *
 * This closes the Phase 3 gap: row-level security already let a rider
 * read their own delivery, but every read route required
 * `deliveries:read`, which a rider does not hold. The policy was
 * right and the gate was wrong.
 *
 * Deliberately no phone number in the list. A list is the easiest
 * thing to leak; the number is revealed one task at a time, and the
 * reveal is audited.
 */
export const GET = apiRoute({ auth: "session" }, async (ctx) => {
  const { rows } = await ctx.db.query(
    `select d.id, d.tracking_id, d.status, d.pickup_location_code,
            d.promised_from, d.promised_to,
            a.line1, a.line2, a.city, a.pincode, a.lat, a.lng, a.instructions,
            asg.status as assignment_status, asg.expires_at,
            (select count(*)::int from delivery.delivery_item i
              where i.delivery_id = d.id) as item_count
       from delivery.delivery d
       join fleet.assignment asg
         on asg.delivery_id = d.id and asg.status in ('OFFERED','ACCEPTED')
       join fleet.rider r on r.id = asg.rider_id
       left join delivery.delivery_address a on a.delivery_id = d.id
      where r.user_id = $1
      order by asg.assigned_at`,
    [ctx.userId]);

  return { body: { tasks: rows, count: rows.length } };
});
