import { apiRoute } from "@/lib/api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/v1/me/availability   { online } — a rider toggling themselves. */
export const POST = apiRoute({ auth: "session" }, async (ctx) => {
  if (typeof ctx.body?.online !== "boolean") {
    return {
      status: 400,
      body: { error: { code: "bad_request", message: "Send { online: true | false }." } },
    };
  }

  const { rows: [r] } = await ctx.db.query(
    "select id from fleet.rider where user_id = $1", [ctx.userId]);

  if (!r) {
    return { status: 404, body: { error: { code: "not_a_rider",
                                           message: "This account has no rider profile." } } };
  }

  await ctx.db.query("select fleet.set_availability($1,$2,$3)",
    [r.id, ctx.body.online, ctx.body?.reason ?? null]);

  return { body: { ok: true, online: ctx.body.online } };
});
