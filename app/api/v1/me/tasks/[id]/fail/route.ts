import { apiRoute } from "@/lib/api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The reasons a delivery can fail at the door.
 *
 * A fixed list rather than free text, because dispatch has to act on
 * these and "failed" is not something anybody can act on. The note
 * carries the detail.
 *
 * Phase 6 turns these into a full exception workflow with evidence
 * and support notes.
 */
const REASONS = [
  "CUSTOMER_UNREACHABLE",
  "ADDRESS_WRONG",
  "CUSTOMER_REFUSED",
  "PACKAGE_DAMAGED",
  "NO_ACCESS",
  "RIDER_UNABLE",
  "OTHER",
];

/**
 * POST /api/v1/me/tasks/:id/fail   { reason_code, note? }
 *
 * It did not happen.
 *
 * The rider still has the parcel, so the assignment stays live — it
 * closes only when a delivery reaches a terminal state, and a failure
 * is not one. Somebody still has to bring it back or try again.
 */
export const POST = apiRoute({ auth: "session" }, async (ctx) => {
  const code = String(ctx.body?.reason_code ?? "").toUpperCase();

  if (!REASONS.includes(code)) {
    return {
      status: 400,
      body: {
        error: {
          code: "bad_reason",
          message: "Choose why it failed — dispatch needs something it can act on.",
          allowed: REASONS,
        },
      },
    };
  }

  if (code === "OTHER" && !String(ctx.body?.note ?? "").trim()) {
    return {
      status: 400,
      body: {
        error: {
          code: "note_required",
          message: "\"Other\" needs a note saying what happened.",
        },
      },
    };
  }

  await ctx.db.query("select delivery.fail_delivery($1,$2,$3)",
    [ctx.params.id, code, ctx.body?.note ?? null]);

  return {
    body: {
      ok: true,
      status: "DELIVERY_FAILED",
      message: "Recorded. You still have the parcel — dispatch will tell you what to do next.",
    },
  };
});
