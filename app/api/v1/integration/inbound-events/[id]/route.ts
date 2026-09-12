import { apiRoute } from "@/lib/api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/integration/inbound-events/:id
 *
 * One event, including the payload exactly as it arrived -- which is
 * what somebody needs to see in order to work out why it was refused.
 */
export const GET = apiRoute(
  { auth: "session", permission: "integration:read" },
  async (ctx) => {
    const { rows: [e] } = await ctx.db.query(
      `select id, source, event, event_id, external_order_id, payload, status,
              error_code, error_detail, attempts, correlation_id,
              received_at, resolved_at
         from integration.inbound_event where id = $1`, [ctx.params.id]);

    if (!e) {
      return { status: 404, body: { error: { code: "not_found", message: "No such event." } } };
    }
    return { body: { event: e } };
  },
);
