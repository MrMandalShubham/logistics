// Forget on schedule.
//
//   npm run retention                    what WOULD happen (dry run)
//   npm run retention -- --confirm       do it
//   npm run retention -- --pii-days 90   override a window
//
// ── Why this defaults to doing nothing ──
//
// It is the only scheduled work in this system that destroys data on
// purpose. A flag you have to add is cheap; a purge you cannot undo
// is not. The worker calls ops.retention_purge directly on its own
// schedule — this script exists so a person can look first, and so
// the same numbers are inspectable afterwards.
//
// ── What it does NOT delete ──
//
// The delivery address is ANONYMISED, not removed. Deleting it would
// break every report that joins to it and lose the fact that the
// delivery had an address at all — the difference between "personal
// data was removed on schedule" and "this record is broken". The
// name, phone, street and instructions go; the city, the pincode and
// a geocode rounded to about a kilometre stay.
//
// The audit log is not purged. It has append-only triggers for a
// reason and seven years is longer than this system has existed. What
// happens instead is a narrow, definer-only redaction of four named
// PII keys inside before/after -- documented in 0012 -- with the
// triggers otherwise untouched and every run itself audited.

import pg from "pg";
import { CONNECTION, PG } from "./db-config.mjs";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const num = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : d;
};

const LOCATION_DAYS = num("--location-days", 30);
const PROOF_DAYS = num("--proof-days", 90);
const PII_DAYS = num("--pii-days", 180);

const db = new pg.Client({ ...PG });
await db.connect();

try {
  const { rows: preview } = await db.query(
    "select * from ops.retention_preview($1,$2,$3)",
    [LOCATION_DAYS, PROOF_DAYS, PII_DAYS]);

  console.log(`\nwindows: location ${LOCATION_DAYS}d · proof ${PROOF_DAYS}d · PII ${PII_DAYS}d\n`);
  console.log("target".padEnd(34) + "rows".padStart(8) + "   rule");
  let total = 0;
  for (const r of preview) {
    total += Number(r.rows_affected);
    console.log(
      r.target.padEnd(34) + String(r.rows_affected).padStart(8) + "   " + r.rule);
  }

  if (total === 0) {
    console.log("\nnothing is due.");
  } else if (!has("--confirm")) {
    console.log(
      `\n${total} rows would be affected. Nothing has been changed.\n` +
      "Run again with --confirm to apply.");
  } else {
    const { rows: [{ r }] } = await db.query(
      "select ops.retention_purge($1,$2,$3) as r",
      [LOCATION_DAYS, PROOF_DAYS, PII_DAYS]);

    console.log("\napplied:");
    for (const [k, v] of Object.entries(r)) {
      if (Number(v) > 0) console.log(`  ${k.padEnd(30)} ${v}`);
    }

    // Say it plainly rather than leaving somebody to infer it.
    console.log(
      "\nAddresses were anonymised, not deleted: the city, pincode and a " +
      "coarsened geocode remain so reports still work.");
  }
} finally {
  await db.end().catch(() => {});
}
