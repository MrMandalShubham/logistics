import { apiRoute } from "@/lib/api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/deliveries/:id/admit
 *
 * RECEIVED -> READY_FOR_ASSIGNMENT. A dispatcher has looked at the
 * order and confirmed it can actually be delivered.
 *
 * ── Why a human gates this at all ──
 *
 * The delivery-ready definition has four conditions and only two of
 * them can be checked automatically today: the order is paid, and
 * Inventory says the stock is held. Whether the address is sane, and
 * whether the hold is still good, is a judgement until Q1 and Q4 are
 * resolved. Phase 8 can automate the promotion once the inputs are
 * trustworthy.
 *
 * The transition itself is enforced in the database, so this route
 * cannot admit something that is not admissible.
 */
export const POST = apiRoute(
  { auth: "session", permission: "deliveries:admit" },
  async (ctx) => {
    const { rows: [d] } = await ctx.db.query(
      "select status, hold_status from delivery.delivery where id = $1",
      [ctx.params.id]);

    if (!d) {
      return { status: 404, body: { error: { code: "not_found", message: "No such delivery." } } };
    }

    await ctx.db.query(
      "select delivery.transition($1,'READY_FOR_ASSIGNMENT',$2,$3)",
      [ctx.params.id, "admitted", ctx.body?.note ?? null]);

    return {
      body: {
        ok: true,
        status: "READY_FOR_ASSIGNMENT",
        // Admitting an unverified hold is allowed, and worth saying out
        // loud rather than burying in a report.
        ...(d.hold_status !== "held"
          ? { warning: `Inventory hold is "${d.hold_status}", not "held". Check before dispatch.` }
          : {}),
      },
    };
  },
);
