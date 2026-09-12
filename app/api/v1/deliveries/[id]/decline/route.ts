import { apiRoute } from "@/lib/api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/deliveries/:id/decline   { reason }
 *
 * The rider says no, and the delivery goes back to the queue.
 *
 * A reason is required. "Declined" on its own tells dispatch nothing
 * and cannot be acted on; "too far from my area" can be.
 */
export const POST = apiRoute({ auth: "session" }, async (ctx) => {
  const reason = typeof ctx.body?.reason === "string" ? ctx.body.reason.trim() : "";

  if (!reason) {
    return {
      status: 400,
      body: { error: { code: "reason_required",
                       message: "Send { reason }. Dispatch needs to know why to act on it." } },
    };
  }

  const { rows: [r] } = await ctx.db.query(
    "select fleet.respond_to_assignment($1,false,$2) as outcome",
    [ctx.params.id, reason]);

  return { body: { ok: true, outcome: r.outcome, status: "READY_FOR_ASSIGNMENT" } };
});
