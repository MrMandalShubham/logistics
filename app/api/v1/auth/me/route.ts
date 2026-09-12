import { apiRoute } from "@/lib/api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/auth/me
 *
 * Who am I, what may I do, and which locations am I bound to.
 *
 * The permissions list comes from the claims, which came from the
 * role_permission table -- so the UI and the database can never
 * disagree about what a role can do. The UI hides what this list
 * omits; the server refuses it regardless.
 */
export const GET = apiRoute({ auth: "session" }, async (ctx) => ({
  body: {
    user: {
      id: ctx.userId,
      email: ctx.claims.email,
      full_name: ctx.claims.full_name,
      role: ctx.role,
      location_codes: ctx.claims.location_codes,
      permissions: ctx.permissions,
    },
  },
}));
