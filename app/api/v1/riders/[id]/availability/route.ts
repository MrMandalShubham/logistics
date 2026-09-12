import { apiRoute } from "@/lib/api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/riders/:id/availability   { online, reason }
 *
 * A rider may toggle themselves; anyone else needs
 * `riders:availability`. Both checks live in the database function,
 * so this route cannot be the place the rule is forgotten.
 */
export const POST = apiRoute({ auth: "session" }, async (ctx) => {
  if (typeof ctx.body?.online !== "boolean") {
    return {
      status: 400,
      body: { error: { code: "bad_request", message: "Send { online: true | false }." } },
    };
  }

  await ctx.db.query("select fleet.set_availability($1,$2,$3)",
    [ctx.params.id, ctx.body.online, ctx.body?.reason ?? null]);

  return { body: { ok: true, online: ctx.body.online } };
});
