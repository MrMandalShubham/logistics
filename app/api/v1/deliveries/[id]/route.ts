import { apiRoute } from "@/lib/api/handler";
import { allowedNext } from "@/lib/delivery/states";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/deliveries/:id
 *
 * The full record: snapshot, items, hold state and the timeline.
 *
 * A delivery the caller may not see returns 404, not 403. Telling
 * somebody a delivery exists at a shop they have no access to is
 * itself a disclosure.
 */
export const GET = apiRoute(
  { permission: "deliveries:read", scope: "deliveries:read" },
  async (ctx) => {
    const id = ctx.params.id;

    const { rows: [d] } = await ctx.db.query(
      `select id, tracking_id, external_order_id, external_customer_id, status,
              pickup_location_code, payment_method, is_prepaid,
              amount_to_collect_paise, order_total_paise,
              promised_from, promised_to,
              hold_status, hold_expires_at, hold_confirmed,
              placed_at, created_at, updated_at
         from delivery.delivery where id = $1`, [id]);

    if (!d) {
      return {
        status: 404,
        body: { error: { code: "not_found", message: "No such delivery." } },
      };
    }

    const [address, items, timeline] = await Promise.all([
      ctx.db.query(
        `select recipient_name, phone, line1, line2, city, state, pincode,
                lat, lng, instructions
           from delivery.delivery_address where delivery_id = $1`, [id]),
      ctx.db.query(
        `select sku, name, quantity, external_product_id, reservation_id
           from delivery.delivery_item where delivery_id = $1 order by name`, [id]),
      ctx.db.query(
        `select from_status, to_status, actor_role, actor_kind,
                reason_code, note, occurred_at
           from delivery.delivery_status_history
          where delivery_id = $1 order by occurred_at, id`, [id]),
    ]);

    return {
      body: {
        delivery: d,
        address: address.rows[0] ?? null,
        items: items.rows,
        // Oldest first: a timeline is read forwards.
        timeline: timeline.rows,
        // So a UI does not have to embed the state machine to know
        // which buttons to show.
        allowed_next: allowedNext(d.status),
      },
    };
  },
);
