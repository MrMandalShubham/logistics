import { apiRoute } from "@/lib/api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/me/tasks/:id/location   { lat, lng, accuracy_m? }
 *
 * A position ping, accepted only while the parcel is actually being
 * carried. Outside that window it is refused rather than quietly
 * dropped: the difference matters when somebody later asks what was
 * collected, and when.
 *
 * Tracking a named worker is not something to do by default, so the
 * window is a rule in the database and no future client can widen it.
 */
export const POST = apiRoute({ auth: "session" }, async (ctx) => {
  const lat = Number(ctx.body?.lat);
  const lng = Number(ctx.body?.lng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return {
      status: 400,
      body: { error: { code: "bad_request", message: "Send { lat, lng }." } },
    };
  }

  await ctx.db.query("select fleet.record_location($1,$2,$3,$4)",
    [ctx.params.id, lat, lng, Number(ctx.body?.accuracy_m) || null]);

  return { body: { ok: true } };
});
