import { apiRoute } from "@/lib/api/handler";
import { dispatchError } from "@/lib/fleet/dispatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/deliveries/:id/reassign   { rider_id, reason }
 *
 * Move a delivery to somebody else. Works from ASSIGNED and from
 * ACCEPTED: a rider whose bike has broken down should not strand a
 * parcel.
 *
 * The old assignment is SUPERSEDED, never overwritten, and the
 * delivery passes back through READY_FOR_ASSIGNMENT so the timeline
 * shows what happened rather than a rider silently changing.
 */
export const POST = apiRoute(
  { auth: "session", permission: "deliveries:assign" },
  async (ctx) => {
    const riderId = ctx.body?.rider_id;
    const reason = typeof ctx.body?.reason === "string" ? ctx.body.reason.trim() : "";

    if (!riderId || !reason) {
      return {
        status: 400,
        body: { error: { code: "bad_request",
                         message: "Send { rider_id, reason }. A reassignment without a reason cannot be explained later." } },
      };
    }

    try {
      const { rows: [r] } = await ctx.db.query(
        "select fleet.reassign_delivery($1,$2,$3) as assignment_id",
        [ctx.params.id, riderId, reason]);

      return { body: { ok: true, assignment_id: r.assignment_id, status: "ASSIGNED" } };
    } catch (e) {
      const mapped = dispatchError(e);
      if (mapped) return { status: mapped.status, body: { error: mapped } };
      throw e;
    }
  },
);
