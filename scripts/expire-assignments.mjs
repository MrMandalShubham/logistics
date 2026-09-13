// Return offers nobody answered.
//
//   npm run expire:assignments
//   npm run expire:assignments -- --dry-run
//   npm run expire:assignments -- --loop 30      (every 30 seconds)
//
// ── Why this must run ──
//
// An offer holds a delivery in ASSIGNED. If the rider never answers —
// phone in a pocket, app closed, bike in a tunnel — the parcel sits
// there looking dispatched while nobody is carrying it. Nothing else
// notices, because nothing failed.
//
// Idempotent: an offer already accepted, declined or expired is not
// touched. Safe to run alongside itself (FOR UPDATE SKIP LOCKED).

import pg from "pg";
import { CONNECTION, PG } from "./db-config.mjs";

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const value = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : d;
};

const pool = new pg.Pool({ ...PG, max: 2 });
pool.on("error", (e) => console.error("[expire] pool error:", e.message));

const SYSTEM = JSON.stringify({
  sub: null, role: "system", actor_kind: "SYSTEM", location_codes: [],
});

async function pass() {
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query("select set_config('request.jwt.claims',$1,true)", [SYSTEM]);
    await db.query("set local role authenticated");

    if (flag("dry-run")) {
      // Through the SAME definer function the real sweep uses.
      //
      // The first version selected from the tables directly, under
      // row-level security, as a role holding no permissions — so it
      // saw nothing and cheerfully reported "nothing to do" while the
      // real sweep went on to find work. A dry run that disagrees with
      // the real run is worse than no dry run at all.
      const { rows } = await db.query("select * from fleet.expiring_assignments()");
      await db.query("rollback");
      return { dryRun: true, rows };
    }

    const { rows: [r] } = await db.query("select fleet.expire_assignments() as n");
    await db.query("commit");
    return { expired: Number(r.n) };
  } catch (e) {
    await db.query("rollback").catch(() => {});
    throw e;
  } finally {
    db.release();
  }
}

try {
  const interval = value("loop", 0);

  do {
    const r = await pass();

    if (r.dryRun) {
      console.log(`\n  ${r.rows.length} offer(s) would be returned to the queue:\n`);
      for (const x of r.rows) {
        console.log(`    ${x.tracking_id}  offered to ${x.rider_code}  lapsed ${x.expires_at.toISOString()}`);
      }
      console.log();
      break;
    }

    // Only speak when something happened. A sweep that logs every idle
    // pass buries the one line that mattered.
    if (r.expired > 0) {
      console.log(`[expire] returned ${r.expired} offer(s) to the queue`);
    } else if (!interval) {
      console.log("[expire] nothing to return");
    }

    if (interval) await new Promise((res) => setTimeout(res, interval * 1000));
  } while (interval);
} finally {
  await pool.end();
}
