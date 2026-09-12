import { apiRoute } from "@/lib/api/handler";
import { dispatchError } from "@/lib/fleet/dispatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/deliveries/:id/assign   { rider_id, expires_seconds? }
 *
 * Offer a delivery to a rider.
 *
 * Two dispatchers racing on the same delivery produce one winner and
 * one 409 — the database decides, via a row lock and a partial unique
 * index, not by whoever's request happened to arrive first.
 */
export const POST = apiRoute(
  { auth: "session", permission: "deliveries:assign" },
  async (ctx) => {
    const riderId = ctx.body?.rider_id;
    if (!riderId) {
      return {
        status: 400,
        body: { error: { code: "bad_request", message: "Send { rider_id }." } },
      };
    }

    try {
      const { rows: [r] } = await ctx.db.query(
        "select fleet.assign_delivery($1,$2,$3) as assignment_id",
        [ctx.params.id, riderId, Number(ctx.body?.expires_seconds) || 120]);

      return {
        status: 201,
        body: { ok: true, assignment_id: r.assignment_id, status: "ASSIGNED" },
      };
    } catch (e) {
      const mapped = dispatchError(e);
      if (mapped) {
        return { status: mapped.status, body: { error: mapped } };
      }
      throw e;
    }
  },
);
