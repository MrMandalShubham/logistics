import { apiRoute } from "@/lib/api/handler";
import { ingestOrder } from "@/lib/delivery/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/integration/inbound-events/:id/retry
 *
 * Replay a stored payload through the same ingest path.
 *
 * ── The reason this endpoint exists ──
 *
 * Until Grocery attaches a delivery address to an order (Q1), every
 * real order is refused here. Those payloads are kept so that the day
 * the address arrives, the backlog can be pushed through rather than
 * reconstructed from nothing.
 *
 * Replay uses the SAME ingest command as a live request. A retry path
 * with its own validation is a second implementation that will drift.
 *
 * A caller may pass `payload` to replay a corrected version -- useful
 * when the fix is upstream and the original is known-bad. The
 * original row is never overwritten; a replay is a new fact about it.
 */
export const POST = apiRoute(
  { auth: "session", permission: "integration:retry" },
  async (ctx) => {
    const { rows: [e] } = await ctx.db.query(
      "select id, status, payload from integration.inbound_event where id = $1",
      [ctx.params.id]);

    if (!e) {
      return { status: 404, body: { error: { code: "not_found", message: "No such event." } } };
    }

    if (e.status === "ACCEPTED" || e.status === "REPLAYED") {
      return {
        status: 409,
        body: {
          error: {
            code: "already_resolved",
            message: `This event is already ${e.status.toLowerCase()}. There is nothing to replay.`,
          },
        },
      };
    }

    const envelope = ctx.body?.payload ?? e.payload;
    const data = envelope?.data ?? envelope;

    const result = await ingestOrder(ctx.db, data);

    if (!result.ok) {
      // Still broken. Count the attempt, leave it replayable, and say
      // what is wrong now -- which may differ from what was wrong before.
      await ctx.db.query(
        `update integration.inbound_event
            set attempts = attempts + 1, error_code = $2, error_detail = $3
          where id = $1`,
        [ctx.params.id, result.rejection.code, result.rejection.message]);

      return {
        status: 422,
        body: {
          error: { ...result.rejection, still_replayable: true },
        },
      };
    }

    await ctx.db.query("select integration.mark_replayed($1)", [ctx.params.id]);

    return {
      body: {
        ok: true,
        delivery_id: result.deliveryId,
        tracking_id: result.trackingId,
        created: result.created,
      },
    };
  },
);
