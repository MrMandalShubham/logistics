import { apiRoute } from "@/lib/api/handler";
import { assignmentHistory } from "@/lib/fleet/dispatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/deliveries/:id/assignments
 *
 * Every attempt, oldest first — superseded ones included. A history
 * showing only the current rider cannot answer "who was asked first",
 * which is the question a complaint usually turns on.
 */
export const GET = apiRoute(
  { permission: "deliveries:read", scope: "deliveries:read" },
  async (ctx) => {
    const attempts = await assignmentHistory(ctx.db, ctx.params.id);
    return {
      body: {
        assignments: attempts,
        attempts: attempts.length,
        current: attempts.find((a: { status: string }) =>
          a.status === "OFFERED" || a.status === "ACCEPTED") ?? null,
      },
    };
  },
);
