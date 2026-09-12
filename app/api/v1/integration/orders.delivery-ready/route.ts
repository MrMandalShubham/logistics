import { apiRoute } from "@/lib/api/handler";
import { ingestOrder } from "@/lib/delivery/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/integration/orders.delivery-ready
 *
 * The front door. An order that is paid for and reserved becomes a
 * delivery here, exactly once.
 *
 * Three independent controls, because one is a single point of
 * failure:
 *
 *   bearer key      proves which system is calling
 *   HMAC signature  proves it knows the shared secret, and is recent
 *   idempotency key proves this is the same request, not a new one
 *
 * ── Every arrival is journalled, accepted or not ──
 *
 * No order in this estate carries a delivery address yet (Q1), so
 * until Grocery sends one, real orders WILL be refused here. A
 * refusal that was only an HTTP status would lose them. Instead the
 * payload is kept and an admin can replay it once the sender is
 * fixed.
 *
 * ── A 4xx is never retried ──
 *
 * A malformed payload will be malformed on the tenth attempt. Retry
 * is for our failures, not the sender's.
 */
export const POST = apiRoute(
  {
    auth: "key",
    scope: "orders:ingest",
    idempotent: true,
    signature: { secretEnv: "INBOUND_WEBHOOK_SECRET" },
  },
  async (ctx) => {
    const envelope = ctx.body ?? {};
    // Accept both the enveloped form ({event, data}) and a bare
    // payload. Senders differ, and the distinction carries no meaning.
    const data = envelope.data ?? envelope;

    const orderId =
      typeof data?.external_order_id === "string" ? data.external_order_id : null;

    const journal = (status: string, code?: string, detail?: string) =>
      ctx.db.query(
        "select integration.record_inbound($1,$2,$3,$4,$5::jsonb,$6,$7,$8)",
        [
          "GROCERY",
          typeof envelope.event === "string" ? envelope.event : "order.delivery_ready",
          typeof envelope.event_id === "string" ? envelope.event_id : null,
          orderId,
          JSON.stringify(envelope),
          status,
          code ?? null,
          detail ?? null,
        ]);

    const result = await ingestOrder(ctx.db, data);

    if (!result.ok) {
      const { code, message, fields } = result.rejection;
      await journal("REJECTED", code, message);

      return {
        status: 422,
        body: {
          error: {
            code,
            message,
            ...(fields ? { fields } : {}),
            // Say plainly that nothing was lost. An integrator staring
            // at a 422 should not have to guess whether to re-send.
            recoverable:
              "This payload has been stored. Fix it at source and an admin can replay it.",
          },
        },
      };
    }

    await journal("ACCEPTED");

    return {
      status: result.created ? 201 : 200,
      body: {
        ok: true,
        delivery_id: result.deliveryId,
        tracking_id: result.trackingId,
        status: result.status,
        ...(result.created ? {} : { already_ingested: true }),
      },
    };
  },
);
