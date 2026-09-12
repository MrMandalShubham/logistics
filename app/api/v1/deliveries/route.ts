import { apiRoute } from "@/lib/api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/deliveries?status=&location=&limit=&cursor=
 *
 * The dispatcher's queue.
 *
 * No location filtering is done here on purpose: row-level security
 * already scopes a dispatcher to their own shops. A WHERE clause can
 * be forgotten in the next handler someone writes; a policy cannot.
 * The `location` parameter only NARROWS what RLS already allows.
 *
 * The customer's phone is deliberately absent from the list. A queue
 * screen does not need it, and a list is the easiest thing to leak.
 */
export const GET = apiRoute(
  { permission: "deliveries:read", scope: "deliveries:read" },
  async (ctx) => {
    const url = new URL(ctx.req.url);
    const status = url.searchParams.get("status");
    const location = url.searchParams.get("location");
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200);

    const { rows } = await ctx.db.query(
      `select d.id, d.tracking_id, d.external_order_id, d.status,
              d.pickup_location_code, d.hold_status, d.hold_expires_at,
              d.promised_from, d.promised_to, d.created_at,
              a.city, a.pincode, a.recipient_name,
              (select count(*)::int from delivery.delivery_item i
                where i.delivery_id = d.id) as item_count
         from delivery.delivery d
         left join delivery.delivery_address a on a.delivery_id = d.id
        where ($1::text is null or d.status = $1)
          and ($2::text is null or d.pickup_location_code = upper($2))
        order by d.created_at desc
        limit $3`,
      [status, location, limit]);

    return { body: { deliveries: rows, count: rows.length } };
  },
);
