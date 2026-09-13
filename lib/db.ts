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

/**
 * TLS, for everything that is not on this machine.
 *
 * ── Why this is not left to the connection string ──
 *
 * `?sslmode=require` connects and then fails with "self-signed
 * certificate in certificate chain": managed Postgres — Supabase,
 * RDS, most others — presents a certificate signed by its own
 * authority, which Node's default trust store does not carry. The
 * failure is a TLS error rather than a connection error, so it is
 * easy to misread as "SSL is not supported here" and disable it.
 *
 * ── What rejectUnauthorized: false costs, stated plainly ──
 *
 * The connection is encrypted. It is NOT authenticated: a party who
 * can intercept the route could present their own certificate. That
 * is the standard posture for every Supabase client guide, and it is
 * genuinely weaker than verifying.
 *
 * To do it properly, download the provider's CA bundle and set
 * `ssl: { ca: fs.readFileSync(...) }` instead. Worth doing before
 * this carries real customer addresses over a network you do not own.
 *
 * Localhost keeps plain TCP: a container on the same machine has no
 * route to intercept, and requiring TLS there would mean generating
 * certificates for every developer.
 */
function sslFor(url: string): pg.PoolConfig["ssl"] {
  const local = /@(localhost|127\.0\.0\.1|\[::1\]|host\.docker\.internal)[:/]/.test(url);
  return local ? undefined : { rejectUnauthorized: false };
}

/**
 * The pool, created on FIRST USE rather than on import.
 *
 * ── Why this is lazy ──
 *
 * It used to be built at module scope, which meant importing this
 * file needed DATABASE_URL — and `next build` imports every route to
 * collect page data. So the build failed on any host that supplies
 * environment variables at runtime rather than at build time:
 *
 *     Failed to collect page data for /api/health
 *     DATABASE_URL is not set.
 *
 * The comment above connectionString() says "fail loudly at first
 * use". It did not: it failed at first IMPORT, which is a different
 * moment and the wrong one. A build should never need a database.
 *
 * The Proxy keeps the export shape — `pool.connect()`, `pool.query()`,
 * `pool.totalCount` all still work — so nothing else had to change.
 */
let realPool: pg.Pool | undefined;

function createPool(): pg.Pool {
  const url = connectionString();
  const p = new pg.Pool({
    connectionString: url,
    ssl: sslFor(url),
    max: Number(process.env.PG_POOL_MAX ?? 8),
    idleTimeoutMillis: 30_000,
    // 10s was fine for a container on this machine and is not enough
    // for a managed database across a slow link — Supabase's direct
    // (IPv6-only) host took 22s to establish from here. Keep it well
    // under the platform's function timeout, or a slow connect
    // arrives as an opaque platform error instead of a database one.
    connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS ?? 30_000),
  });

  // A pool that has ever had an idle client dropped emits 'error' on
  // the pool itself; with no handler Node treats it as unhandled and
  // takes the process down.
  p.on("error", (e) => {
    console.error(JSON.stringify({ level: "error", msg: "pg pool error", err: e.message }));
  });

  return p;
}

function getPool(): pg.Pool {
  if (globalForPg._logisticsPool) return globalForPg._logisticsPool;
  if (!realPool) {
    realPool = createPool();
    // Next.js reloads modules in development, so the pool is parked on
    // globalThis. Without that, every hot reload leaks a pool and the
    // database runs out of connections after about twenty edits.
    if (process.env.NODE_ENV !== "production") globalForPg._logisticsPool = realPool;
  }
  return realPool;
}

export const pool: pg.Pool = new Proxy({} as pg.Pool, {
  get(_t, prop, receiver) {
    const value = Reflect.get(getPool(), prop, receiver);
    return typeof value === "function" ? value.bind(getPool()) : value;
  },
  set(_t, prop, value) {
    return Reflect.set(getPool(), prop, value);
  },
});

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
