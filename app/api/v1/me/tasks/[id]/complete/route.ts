import { apiRoute } from "@/lib/api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/me/tasks/:id/complete   { otp, photo_ref? }
 *
 * The handover.
 *
 * Requires the customer's code — which the rider has never been
 * shown. They have to be at the door, with the customer, to get it.
 * That is the whole proof.
 *
 * The response tells a wrong code apart from an expired one and a
 * locked one, because a rider standing on a doorstep needs to know
 * whether to try again or ring support.
 *
 * ── What this does NOT wait for ──
 *
 * The commit to Inventory. It is queued and retried; a rider must not
 * stand at a door while another system decides whether it is feeling
 * well. If that commit later proves impossible, it raises a loud
 * exception for a person — it does not un-deliver the parcel.
 */
export const POST = apiRoute({ auth: "session" }, async (ctx) => {
  const otp = String(ctx.body?.otp ?? "").trim();

  if (!otp) {
    return {
      status: 400,
      body: {
        error: {
          code: "otp_required",
          message: "Ask the customer for their 6-digit code.",
        },
      },
    };
  }

  const { rows: [r] } = await ctx.db.query(
    "select delivery.complete_delivery($1,$2,$3) as result",
    [ctx.params.id, otp, ctx.body?.photo_ref ?? null]);

  const result = r.result as Record<string, unknown>;

  if (!result.ok) {
    const code = String(result.code ?? "OTP_WRONG");
    return {
      status: code === "OTP_LOCKED" ? 423 : 422,
      body: {
        error: {
          code: code.toLowerCase(),
          message: result.message,
          ...(result.attempts_left !== undefined
            ? { attempts_left: result.attempts_left }
            : {}),
        },
      },
    };
  }

  return {
    body: { ok: true, status: "DELIVERED", message: "Delivered. Thank you." },
  };
});
