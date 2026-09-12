import pg from "pg";

/**
 * One pool for the process.
 *
 * Next.js reloads modules in development, so the pool is parked on
 * globalThis. Without that, every hot reload leaks a pool and the
 * database runs out of connections after about twenty edits.
 */
const globalForPg = globalThis as unknown as { _logisticsPool?: pg.Pool };

function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    // Fail loudly at first use rather than falling back to a
    // placeholder. A system that starts fine and fails on the first
    // real request is harder to diagnose than one that refuses to
    // start.
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env and fill it in.",
    );
  }
  return url;
}

export const pool: pg.Pool =
  globalForPg._logisticsPool ??
  new pg.Pool({
    connectionString: connectionString(),
    max: Number(process.env.PG_POOL_MAX ?? 8),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

// A pool that has ever had an idle client dropped emits 'error' on
// the pool itself; with no handler Node treats it as unhandled and
// takes the process down.
pool.on("error", (e) => {
  console.error(JSON.stringify({ level: "error", msg: "pg pool error", err: e.message }));
});

if (process.env.NODE_ENV !== "production") globalForPg._logisticsPool = pool;

export type Claims = Record<string, unknown>;

/**
 * Run a unit of work with claims set and row-level security applied.
 *
 * Everything goes through here -- an API key, the admin UI, a script.
 * There is no second path that skips RLS, which is the only way
 * "whatever an integrator cannot do, we cannot do either" is true
 * rather than aspirational.
 *
 * SET LOCAL is transaction-scoped, so COMMIT restores the
 * connection's own role and the client is safe to reuse.
 */
export async function withClaims<T>(
  claims: Claims,
  fn: (db: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify(claims),
    ]);
    await db.query("set local role authenticated");
    const out = await fn(db);
    await db.query("commit");
    return out;
  } catch (e) {
    await db.query("rollback").catch(() => {});
    throw e;
  } finally {
    db.release();
  }
}

/** The claim set a trusted local script runs under. Never reachable over HTTP. */
export const SYSTEM_CLAIMS: Claims = {
  sub: null,
  role: "system",
  actor_kind: "SYSTEM",
  location_codes: [],
};
