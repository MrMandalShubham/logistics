import { apiRoute } from "@/lib/api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/whoami
 *
 * The endpoint an integrator hits first: "is my key wired up, and
 * what does it actually hold?" Cheap to build, and it saves a support
 * conversation every single time somebody pastes a sandbox key into
 * production and wonders why nothing works.
 *
 * It reports the key prefix, never the key.
 */
export const GET = apiRoute({ auth: "key" }, async (ctx) => {
  const { rows } = await ctx.db.query(
    `select name, key_prefix, scopes, location_codes, environment,
            rate_limit_per_min, created_at, last_used_at
       from integration.api_client where id = $1`, [ctx.clientId]);

  const c = rows[0];

  return {
    body: {
      client: {
        id: ctx.clientId,
        name: c?.name ?? ctx.claims.name,
        key_prefix: c?.key_prefix ?? null,
        environment: c?.environment ?? ctx.claims.environment,
        scopes: ctx.scopes,
        // Empty means every location. Say so, rather than showing an
        // empty list that reads as "none".
        locations: (c?.location_codes?.length ? c.location_codes : "ALL"),
        rate_limit_per_min: c?.rate_limit_per_min ?? ctx.claims.rate_limit,
        created_at: c?.created_at ?? null,
        last_used_at: c?.last_used_at ?? null,
      },
    },
  };
});
