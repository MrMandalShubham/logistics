// The scheduler.
//
//   npm run worker                    run everything on its schedule
//   npm run worker -- --once          one pass of every job, then exit
//   npm run worker -- --only drain    just one job
//   npm run worker -- --list          what is scheduled, and its health
//
// ── Why a process and not cron ──
//
// Cron will run these. It will not tell you when it stops, and that
// is the failure that matters: a scheduler that silently dies leaves
// everything looking fine while a customer's order page freezes on
// "packed" and Inventory's ledger stays silent.
//
// So every run writes a row to ops.job_run, and ops.job_health turns
// that into a check the deep health endpoint fails on. The scheduling
// is the easy half.
//
// ── Why not a serverless function ──
//
// Q15, and Inventory's own webhook-worker header documents it: billed
// by wall-clock, and killed mid-flight. A job killed between "claimed"
// and "recorded" is exactly the state the outbound queue's SENDING
// status exists to survive, and there is no reason to manufacture it
// every twenty seconds.
//
// ── Why an advisory lock ──
//
// Two workers during a deploy, or one somebody forgot about, must not
// double-drain the queue. pg_try_advisory_lock is held for the life
// of the connection and released if the process dies, which is the
// behaviour a lock table would have to reimplement badly.

import pg from "pg";
import { CONNECTION, PG } from "./db-config.mjs";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d = null) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const WORKER = val("--name", `worker-${process.pid}`);
const ONLY = val("--only");
const ONCE = has("--once");

const pool = new pg.Pool({ ...PG, max: 6 });
pool.on("error", () => {});

const log = (msg, extra = {}) =>
  console.log(JSON.stringify({
    ts: new Date().toISOString(), worker: WORKER, msg, ...extra }));

/** A lock key per job. Stable across restarts, unique per job name. */
function lockKey(job) {
  let h = 0;
  for (const ch of job) h = (Math.imul(31, h) + ch.charCodeAt(0)) | 0;
  return h;
}

/**
 * Run one job, once, under a lock, with the outcome recorded either
 * way.
 *
 * A job that throws is recorded as a failure and the worker carries
 * on. One bad job must not take the scheduler down — that would turn
 * a stale Grocery status into a stopped ledger.
 */
async function runJob(job, fn) {
  const db = await pool.connect();
  let runId = null;

  try {
    const { rows: [l] } = await db.query(
      "select pg_try_advisory_lock($1) as got", [lockKey(job)]);
    if (!l.got) {
      log("skipped: another worker holds it", { job });
      return;
    }

    try {
      ({ rows: [{ id: runId }] } = await db.query(
        "select ops.job_started($1,$2) as id", [job, WORKER]));

      const stats = await fn(db);

      await db.query("select ops.job_finished($1,true,null,$2::jsonb)",
        [runId, JSON.stringify(stats ?? {})]);

      // Quiet when there is nothing to say. A log line every twenty
      // seconds saying "0" is how real messages get missed.
      if (stats && Object.values(stats).some((v) => Number(v) > 0)) {
        log("ran", { job, ...stats });
      }
    } finally {
      await db.query("select pg_advisory_unlock($1)", [lockKey(job)]).catch(() => {});
    }
  } catch (e) {
    const detail = e?.message ?? String(e);
    log("FAILED", { job, err: detail });
    if (runId) {
      await db.query("select ops.job_finished($1,false,$2,null)", [runId, detail])
        .catch(() => {});
    }
  } finally {
    db.release();
  }
}

// ─────────────── the jobs ───────────────

async function asSystem(db, fn) {
  await db.query("begin");
  try {
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({
      sub: null, role: "system", actor_kind: "SYSTEM",
      location_codes: [], permissions: ["*"] })]);
    await db.query("set local role authenticated");
    const out = await fn(db);
    await db.query("commit");
    return out;
  } catch (e) {
    await db.query("rollback").catch(() => {});
    throw e;
  }
}

const JOBS = {
  "outbound.drain": async (db) => {
    const { drainOnce } = await import("../lib/outbound.ts");
    return asSystem(db, (c) => drainOnce(c, { batch: 20, worker: WORKER }));
  },

  "assignments.expire": async (db) =>
    asSystem(db, async (c) => {
      const { rows } = await c.query("select fleet.expire_assignments() as n");
      return { expired: Number(rows[0].n ?? 0) };
    }),

  "holds.expire": async (db) =>
    asSystem(db, async (c) => {
      const { rows } = await c.query("select delivery.flag_expiring_holds(10) as n");
      return { flagged: Number(rows[0].n ?? 0) };
    }),

  // Runs as the owner, not as `authenticated`: retention_purge has
  // EXECUTE revoked from PUBLIC and from authenticated on purpose, so
  // no signed-in user can reach it through any screen.
  "retention.purge": async (db) => {
    const { rows } = await db.query("select ops.retention_purge() as r");
    return rows[0].r ?? {};
  },
};

// ─────────────── the loop ───────────────

async function schedule() {
  const { rows } = await pool.query(
    "select job, interval_seconds from ops.job_schedule where enabled order by job");
  return rows.filter((r) => JOBS[r.job] && (!ONLY || r.job.includes(ONLY)));
}

async function listHealth() {
  const { rows } = await pool.query("select * from ops.job_health()");
  console.log(
    "job".padEnd(20) + "every".padEnd(9) + "last success".padEnd(26) + "state");
  for (const r of rows) {
    const last = r.last_success
      ? new Date(r.last_success).toISOString().replace("T", " ").slice(0, 19)
      : "never";
    const state = !r.enabled ? "disabled"
      : r.overdue ? (r.seconds_since === null
          ? "OVERDUE (has never succeeded)"
          : `OVERDUE (${r.seconds_since}s since a success)`)
      : r.running ? "running" : "ok";
    console.log(
      r.job.padEnd(20) + `${r.interval_seconds}s`.padEnd(9) + last.padEnd(26) + state);
    if (r.last_outcome === false && r.last_detail) {
      console.log("".padEnd(29) + `last error: ${r.last_detail}`);
    }
  }
}

async function main() {
  if (has("--list")) {
    await listHealth();
    await pool.end();
    return;
  }

  const jobs = await schedule();
  if (!jobs.length) {
    console.error(ONLY ? `no enabled job matches "${ONLY}"` : "nothing is scheduled");
    await pool.end();
    process.exitCode = 1;
    return;
  }

  if (ONCE) {
    for (const j of jobs) await runJob(j.job, JOBS[j.job]);
    await listHealth();
    await pool.end();
    return;
  }

  log("started", { jobs: jobs.map((j) => `${j.job}/${j.interval_seconds}s`) });

  const timers = jobs.map((j) => {
    // Run immediately, then on the interval. A worker that has just
    // started should not wait twenty minutes before its first drain.
    runJob(j.job, JOBS[j.job]);
    return setInterval(() => runJob(j.job, JOBS[j.job]), j.interval_seconds * 1000);
  });

  const stop = async (sig) => {
    log("stopping", { sig });
    for (const t of timers) clearInterval(t);
    // Let anything in flight finish; the advisory lock is released
    // when the connection closes either way.
    await new Promise((r) => setTimeout(r, 500));
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
