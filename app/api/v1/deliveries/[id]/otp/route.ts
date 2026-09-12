import { apiRoute } from "@/lib/api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/deliveries/:id/otp — issue a fresh code, shown once.
 *
 * ── Why this rotates rather than reads ──
 *
 * The code is stored hashed, like every other secret here, so it
 * cannot be read back. Support asking for it issues a new one. A code
 * that can be read repeatedly can leak repeatedly, and rotating means
 * whatever the customer is given is always fresh.
 *
 * ── Why it exists at all ──
 *
 * There is no SMS provider anywhere in this estate, and logistics
 * cannot reach the customer until Phase 5. Until then support reads
 * the code out. The code is real and enforced from day one; only its
 * delivery channel is manual.
 *
 * A rider is refused by the database, not by this route.
 */
export const POST = apiRoute(
  { auth: "session", permission: "deliveries:read" },
  async (ctx) => {
    const { rows: [d] } = await ctx.db.query(
      "select status, tracking_id from delivery.delivery where id = $1",
      [ctx.params.id]);

    if (!d) {
      return {
        status: 404,
        body: { error: { code: "not_found", message: "No such delivery." } },
      };
    }

    const { rows: [r] } = await ctx.db.query(
      "select delivery.issue_otp($1) as code", [ctx.params.id]);

    return {
      body: {
        tracking_id: d.tracking_id,
        delivery_status: d.status,
        code: r.code,
        expires_in_seconds: 900,
        note: "Read this to the customer. Asking again issues a new code.",
      },
    };
  },
);
