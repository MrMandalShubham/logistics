import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { COOKIE_NAME, hashToken } from "@/lib/auth/session";
import * as inventory from "@/lib/inventory";
import * as grocery from "@/lib/grocery";
import { correlationId } from "@/lib/logging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EXPECTED_MIGRATIONS = 9;

/**
 * GET /api/health          liveness  -- is the process up?
 * GET /api/health?deep=1   readiness -- is it actually able to work?
 *
 * ── Why these are different answers ──
 *
 * Shallow health must return 200 even when the database is down. It
 * answers "is this process alive", and it is what a load balancer
 * polls. If it went red during a brief database blip, the balancer
 * would kill healthy processes and turn a recoverable incident into
 * an outage.
 *
 * Deep health is the one a human reads. It is allowed to be red.
 */
export async function GET(req: NextRequest) {
  const cid = correlationId(req);
  const deep = new URL(req.url).searchParams.get("deep");

  if (!deep) {
    return NextResponse.json(
      { status: "ok", service: "logistics-core", version: "0.1.0",
        as_of: new Date().toISOString() },
      { status: 200, headers: { "X-Api-Version": "v1", "X-Correlation-Id": cid } });
  }

  // Deep health needs a caller who is allowed to see internals: pool
  // sizes and upstream failures are useful to an attacker too.
  const allowed = await isAllowedDeep(req);
  if (!allowed) {
    return NextResponse.json(
      { error: { code: "forbidden", message: "Deep health requires system:health:deep." } },
      { status: 403, headers: { "X-Api-Version": "v1", "X-Correlation-Id": cid } });
  }

  const checks: Record<string, unknown> = {};
  let ok = true;

  // ── database ──
  const dbStart = Date.now();
  try {
    const c = await pool.connect();
    try {
      await c.query("select 1");
      const { rows } = await c.query(
        "select count(*)::int as n, max(applied_at) as last from ops.schema_migration");
      checks.database = { ok: true, ms: Date.now() - dbStart };
      checks.migrations = {
        ok: rows[0].n >= EXPECTED_MIGRATIONS,
        applied: rows[0].n,
        expected: EXPECTED_MIGRATIONS,
        last_applied_at: rows[0].last,
      };
      if (rows[0].n < EXPECTED_MIGRATIONS) ok = false;

      // Clock skew matters because Phase 2's webhook signatures carry
      // a 300-second tolerance. Better to see the drift now than to
      // debug "invalid signature" blind later.
      const { rows: t } = await c.query("select now() as db_now");
      checks.clock_skew_ms = Math.abs(Date.now() - new Date(t[0].db_now).getTime());
    } finally {
      c.release();
    }
  } catch (e: any) {
    ok = false;
    checks.database = { ok: false, error: e?.message, ms: Date.now() - dbStart };
  }

  // ── the two systems we work with ──
  //
  // Not configured is reported, not failed: a developer without an
  // Inventory key should still see a usable health screen.
  const [inv, gro] = await Promise.all([inventory.ping(), grocery.ping()]);
  checks.inventory = inv;
  checks.grocery = gro;

  checks.pool = { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount };

  return NextResponse.json(
    { status: ok ? "ok" : "degraded", service: "logistics-core", version: "0.1.0",
      checks, as_of: new Date().toISOString() },
    { status: ok ? 200 : 503,
      headers: { "X-Api-Version": "v1", "X-Correlation-Id": cid } });
}

async function isAllowedDeep(req: NextRequest): Promise<boolean> {
  try {
    const c = await pool.connect();
    try {
      const bearer = req.headers.get("authorization") ?? "";
      const key = bearer.startsWith("Bearer ") ? bearer.slice(7).trim() : null;
      if (key) {
        const { rows } = await c.query(
          "select integration.authenticate_api_key($1) as claims", [key]);
        return Boolean(rows[0]?.claims);
      }
      const cookie = req.cookies.get(COOKIE_NAME)?.value;
      if (!cookie) return false;
      const { rows } = await c.query(
        "select identity.resolve_session($1) as claims", [hashToken(cookie)]);
      const perms: string[] = rows[0]?.claims?.permissions ?? [];
      return perms.includes("system:health:deep");
    } finally {
      c.release();
    }
  } catch {
    // If we cannot check, we do not show internals.
    return false;
  }
}
