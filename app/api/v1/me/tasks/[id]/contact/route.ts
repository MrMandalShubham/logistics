import { apiRoute } from "@/lib/api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/me/tasks/:id/contact
 *
 * Reveal the customer's phone number.
 *
 * A POST, and its own endpoint rather than a field on the task,
 * because handing somebody's phone number to a worker is an event
 * worth recording. Every reveal writes an audit row naming the rider.
 *
 * No masking provider exists in this estate yet, so this is the real
 * number. When one is chosen, this is the single place that changes.
 */
export const POST = apiRoute({ auth: "session" }, async (ctx) => {
  const { rows: [a] } = await ctx.db.query(
    `select recipient_name, phone from delivery.delivery_address
      where delivery_id = $1`, [ctx.params.id]);

  if (!a) {
    return {
      status: 404,
      body: { error: { code: "not_found", message: "That task is not yours." } },
    };
  }

  await ctx.db.query(
    "select ops.audit($1,$2,$3)",
    ["delivery.contact_revealed", "delivery", ctx.params.id]);

  return {
    body: {
      recipient_name: a.recipient_name,
      phone: a.phone,
      note: "This reveal was recorded against your account.",
    },
  };
});
