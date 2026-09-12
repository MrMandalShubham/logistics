import { apiRoute } from "@/lib/api/handler";
import { orderForSync, type OutboxEvent } from "@/lib/offline/outbox";
import { logger } from "@/lib/logging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTIONS = ["step", "complete", "fail", "location"];

/**
 * POST /api/v1/me/sync   { events: [...] }
 *
 * A phone reporting what its rider did while it had no signal.
 *
 * ── Per-event results, not a batch verdict ──
 *
 * One conflicted event must not discard nine good ones, and the rider
 * needs to know WHICH one needs a conversation. So every event gets
 * its own answer and the response never fails as a unit.
 *
 * ── Not wrapper-idempotent ──
 *
 * Idempotency here is per event, keyed on the id the DEVICE generated
 * at capture. A batch is not a request that can be replayed as a
 * unit: a retry after a partial failure carries a different set.
 *
 * ── Applied in CAPTURE order ──
 *
 * Not arrival order. A queue drained badly can offer "arrived" before
 * "picked up"; replaying them as they happened is what keeps the
 * server's state machine agreeing with the world.
 */
export const POST = apiRoute({ auth: "session" }, async (ctx) => {
  const raw = Array.isArray(ctx.body?.events) ? ctx.body.events : null;

  if (!raw) {
    return {
      status: 400,
      body: { error: { code: "bad_request", message: "Send { events: [...] }." } },
    };
  }

  if (raw.length > 100) {
    return {
      status: 413,
      body: {
        error: {
          code: "too_many_events",
          message: "Send at most 100 events at a time.",
        },
      },
    };
  }

  const valid: OutboxEvent[] = [];
  const rejected: { client_event_id?: string; status: string; message: string }[] = [];

  for (const e of raw as Record<string, unknown>[]) {
    const id = typeof e?.client_event_id === "string" ? e.client_event_id : null;
    const deliveryId = typeof e?.delivery_id === "string" ? e.delivery_id : null;
    const action = typeof e?.action === "string" ? e.action : null;
    const capturedAt = typeof e?.captured_at === "string" ? e.captured_at : null;

    if (!id || !deliveryId || !action || !ACTIONS.includes(action) || !capturedAt
        || Number.isNaN(Date.parse(capturedAt))) {
      rejected.push({
        client_event_id: id ?? undefined,
        status: "REJECTED",
        message: "Malformed event — needs client_event_id, delivery_id, action, captured_at.",
      });
      continue;
    }

    valid.push({
      client_event_id: id,
      delivery_id: deliveryId,
      action: action as OutboxEvent["action"],
      payload: (e.payload ?? {}) as Record<string, unknown>,
      captured_at: capturedAt,
      seq: Number(e.seq) || 0,
      attempts: 0,
    });
  }

  const results: unknown[] = [...rejected];

  // One at a time, in capture order. A batch that applied events
  // concurrently could move a delivery through two states at once and
  // lose the ordering the rider actually experienced.
  for (const e of orderForSync(valid)) {
    const { rows: [r] } = await ctx.db.query(
      "select integration.apply_rider_event($1,$2,$3,$4::jsonb,$5) as result",
      [e.client_event_id, e.delivery_id, e.action,
       JSON.stringify(e.payload), e.captured_at]);

    results.push(r.result);
  }

  const conflicts = results.filter(
    (r) => (r as { status?: string })?.status === "CONFLICT").length;

  if (conflicts > 0) {
    logger.warn("sync produced conflicts", {
      rider: ctx.userId, events: valid.length, conflicts,
    });
  }

  return {
    body: {
      results,
      summary: {
        received: raw.length,
        applied: results.filter((r) => (r as { status?: string })?.status === "APPLIED").length,
        noop: results.filter((r) => (r as { status?: string })?.status === "NOOP").length,
        conflicts,
        rejected: rejected.length,
      },
    },
  };
});
