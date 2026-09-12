import { apiRoute } from "@/lib/api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/deliveries/:id/cancel   { reason }
 *
 * Terminal. Admin only, and a reason is required -- a cancelled
 * delivery with no explanation is a support ticket waiting to happen.
 *
 * ── What this does NOT do ──
 *
 * It does not release the inventory hold. That call belongs with the
 * rest of the outbound writes in Phase 6, alongside returns, and
 * building it here without the retry and dead-letter machinery would
 * mean a failed release silently stranding stock. Until then the hold
 * lapses on its own after 30 minutes, which is the same outcome by a
 * slower route.
 */
export const POST = apiRoute(
  { auth: "session", permission: "deliveries:cancel" },
  async (ctx) => {
    const reason = typeof ctx.body?.reason === "string" ? ctx.body.reason.trim() : "";

    if (!reason) {
      return {
        status: 400,
        body: { error: { code: "reason_required",
                         message: "Send { reason }. A cancellation without one cannot be explained later." } },
      };
    }

    const { rows: [d] } = await ctx.db.query(
      "select status from delivery.delivery where id = $1", [ctx.params.id]);

    if (!d) {
      return { status: 404, body: { error: { code: "not_found", message: "No such delivery." } } };
    }

    await ctx.db.query(
      "select delivery.transition($1,'CANCELLED',$2,$3)",
      [ctx.params.id, "cancelled", reason]);

    return {
      body: {
        ok: true,
        status: "CANCELLED",
        note: "The inventory hold was not released; it lapses on its own. Release lands in Phase 6.",
      },
    };
  },
);
