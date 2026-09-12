import { apiRoute } from "@/lib/api/handler";
import { RIDER_STEP, type DeliveryStatus } from "@/lib/delivery/states";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/me/tasks/:id/step
 *
 * One step along the path: going to collect, collected, on my way,
 * arrived.
 *
 * ── Why the rider does not name the destination ──
 *
 * The server works out what comes next from where the delivery
 * actually is. A client that could name its own target could post
 * `ARRIVED` without ever leaving the shop.
 *
 * Arriving mints the customer's code, inside the database function,
 * and the rider never sees it.
 *
 * Ownership is checked in the database, not here.
 */
export const POST = apiRoute({ auth: "session" }, async (ctx) => {
  const { rows: [d] } = await ctx.db.query(
    "select status from delivery.delivery where id = $1", [ctx.params.id]);

  if (!d) {
    return {
      status: 404,
      body: { error: { code: "not_found", message: "That task is not yours." } },
    };
  }

  const step = RIDER_STEP[d.status as DeliveryStatus];

  if (!step) {
    return {
      status: 409,
      body: {
        error: {
          code: "no_next_step",
          message: d.status === "ARRIVED"
            ? "You have arrived — complete the delivery with the customer's code."
            : `There is no next step from ${d.status}.`,
          status: d.status,
        },
      },
    };
  }

  await ctx.db.query("select delivery.rider_step($1,$2,$3,null)",
    [ctx.params.id, step.to, step.to.toLowerCase()]);

  const next = RIDER_STEP[step.to];

  return {
    body: {
      ok: true,
      status: step.to,
      next_step: next ?? null,
      ...(step.to === "ARRIVED"
        ? { message: "Ask the customer for their 6-digit code." }
        : {}),
    },
  };
});
