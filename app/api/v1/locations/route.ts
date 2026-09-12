import { apiRoute } from "@/lib/api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/locations
 *
 * The pickup points logistics knows about -- a CACHE of Inventory's
 * locations, refreshed by `npm run locations:sync`.
 *
 * `source` is in the response on purpose. SEED means the row came
 * from a fixture because no Inventory key was configured, and an
 * operator should always be able to tell a guess from a fact.
 *
 * Row-level security scopes this: a dispatcher bound to SH1 sees SH1.
 * There is no filtering in this handler because there does not need
 * to be -- the policy does it, and a policy cannot be forgotten the
 * way a WHERE clause can.
 */
export const GET = apiRoute(
  { permission: "locations:read", scope: "deliveries:read" },
  async (ctx) => {
    const { rows } = await ctx.db.query(
      `select code, external_location_id, name, type, lat, lng,
              is_active, source, synced_at
         from integration.location_ref
        where is_active
        order by case type when 'HUB' then 0 else 1 end, code`);

    return {
      body: {
        locations: rows,
        stale: rows.some((r: any) => !r.synced_at || r.source === "SEED"),
      },
    };
  },
);
