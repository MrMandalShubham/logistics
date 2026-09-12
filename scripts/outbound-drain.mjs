// Drain the outbound queue.
//
//   npm run outbound:drain                 one pass
//   npm run outbound:drain -- --loop 5     every 5 seconds
//   npm run outbound:drain -- --show       what is waiting, without sending
//
// ── What this actually does ──
//
// Commits delivered orders to Inventory — the write this estate has
// never made. Every commit is followed by a read that verifies the
// stock really was consumed, because the commit endpoint reports
// success for a released hold exactly as it does for a consumed one.
//
// Not a serverless function. It is billed by wall-clock time and
// killed mid-flight, which is precisely the crash the SENDING state
// exists to survive. Run it as a small always-on process, or from a
// scheduler.

import pg from "pg";
import { CONNECTION } from "./db-config.mjs";
import { drainOnce } from "../lib/outbound.ts";

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const value = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : d;
};

const pool = new pg.Pool({ connectionString: CONNECTION, max: 2 });
pool.on("error", (e) => console.error("[outbound] pool error:", e.message));

const SYSTEM = JSON.stringify({
  sub: null, role: "system", actor_kind: "SYSTEM", location_codes: [],
});

let running = true;
for (const sig of ["SIGINT", "SIGTERM"]) {
  // Finish the pass in flight rather than abandoning claimed rows.
  process.on(sig, () => { running = false; });
}

async function withSystem(fn) {
  const db = await pool.connect();
  try {
    await db.query("select set_config('request.jwt.claims',$1,false)", [SYSTEM]);
    await db.query("set role authenticated");
    return await fn(db);
  } finally {
    await db.query("reset role").catch(() => {});
    db.release();
  }
}

if (flag("show")) {
  // Through the definer function, not a plain SELECT. Reading the
  // table directly under RLS as a role with no permissions returns
  // nothing and reports an empty queue — which is exactly what the
  // first version did while three commits sat stuck in SENDING.
  const rows = await withSystem((db) =>
    db.query("select * from integration.pending_outbound()").then((r) => r.rows));

  console.log(`\n  ${rows.length} outbound event(s) not delivered:\n`);
  for (const r of rows) {
    console.log(`    #${r.id}  ${r.target}/${r.event}  ${r.status}  attempts ${r.attempts}`);
    if (r.last_error) console.log(`        ${r.last_error.slice(0, 140)}`);
  }
  console.log();
  await pool.end();
  process.exit(0);
}

const interval = value("loop", 0);

try {
  do {
    const r = await withSystem((db) => drainOnce(db, { batch: 20, worker: `w-${process.pid}` }));

    if (r.claimed) {
      console.log(
        `[outbound] claimed ${r.claimed}  delivered ${r.delivered}` +
        `  retrying ${r.retrying}  dead ${r.dead}`);
    } else if (!interval) {
      console.log("[outbound] queue is empty");
    }

    // Only sleep when the queue was empty. A full batch means more is
    // waiting, and sleeping through a backlog is how a queue that
    // "works" still runs an hour behind.
    if (running && interval && r.claimed < 20) {
      await new Promise((res) => setTimeout(res, interval * 1000));
    }
  } while (running && interval);
} finally {
  await pool.end();
}
