import { apiRoute } from "@/lib/api/handler";
import { ridersForDispatch, queueForDispatch, inFlight } from "@/lib/fleet/dispatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/dispatch?location=SH1
 *
 * Everything a dispatcher needs on one call: what is waiting, who is
 * free, and what is already out.
 *
 * No location filtering is done for security here — row-level
 * security already scopes a dispatcher to their own shops. The
 * parameter only narrows what RLS has already allowed.
 */
export const GET = apiRoute(
  { permission: "deliveries:read", scope: "deliveries:read" },
  async (ctx) => {
    const location = new URL(ctx.req.url).searchParams.get("location");

    const [queue, riders, active] = await Promise.all([
      queueForDispatch(ctx.db, location),
      ridersForDispatch(ctx.db, location),
      inFlight(ctx.db, location),
    ]);

    return {
      body: {
        queue,
        riders,
        in_flight: active,
        summary: {
          waiting: queue.length,
          available_riders: riders.filter((r) => r.unavailable_reason === null).length,
          out: active.length,
          // An offer nobody has answered yet. Worth seeing at a glance:
          // it is the thing that quietly holds a parcel still.
          awaiting_response: active.filter((a) => a.assignment_status === "OFFERED").length,
        },
      },
    };
  },
);
