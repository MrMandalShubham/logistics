import { apiRoute } from "@/lib/api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/integration/inbound-events?status=REJECTED
 *
 * Everything that arrived, and what became of it.
 *
 * Admin only: the stored payload contains a customer's name, phone
 * and street address. The payload itself is returned only for a
 * single event (see the summary field), not across a list -- a list
 * endpoint is the easiest thing to leak wholesale.
 */
export const GET = apiRoute(
  { auth: "session", permission: "integration:read" },
  async (ctx) => {
    const url = new URL(ctx.req.url);
    const status = url.searchParams.get("status");
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200);

    const { rows } = await ctx.db.query(
      `select id, source, event, event_id, external_order_id, status,
              error_code, error_detail, attempts, received_at, resolved_at
         from integration.inbound_event
        where ($1::text is null or status = $1)
        order by received_at desc
        limit $2`,
      [status, limit]);

    return {
      body: {
        events: rows,
        count: rows.length,
        replayable: rows.filter((r: any) => r.status === "REJECTED" || r.status === "DEAD").length,
      },
    };
  },
);
