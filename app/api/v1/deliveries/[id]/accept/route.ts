import { apiRoute } from "@/lib/api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/deliveries/:id/accept
 *
 * The rider takes the job.
 *
 * ── Why there is no rider_id parameter ──
 *
 * The rider is whoever is signed in. Accepting "on behalf of" someone
 * is a dispatcher action and needs deliveries:assign; a rider can only
 * ever accept their own offer, and the database checks that the offer
 * is actually theirs — holding `deliveries:respond` means "you are a
 * rider", not "you may accept this".
 *
 * The rider UI arrives in Phase 4. This endpoint is built now because
 * the dispatcher's flow cannot be tested without it.
 */
export const POST = apiRoute({ auth: "session" }, async (ctx) => {
  const { rows: [r] } = await ctx.db.query(
    "select fleet.respond_to_assignment($1,true,null) as outcome", [ctx.params.id]);

  return { body: { ok: true, outcome: r.outcome, status: "ACCEPTED" } };
});
