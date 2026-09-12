// Apply migrations, in order, exactly once.
//
//   node scripts/migrate.mjs
//
// Each file runs inside its own transaction, so a failure halfway
// through leaves the database at the last good migration rather than
// in a state no file describes.
//
// Applied files are recorded with a checksum. Editing a migration
// that has already run is refused: the database would silently differ
// from the file, and nobody would find out until the next fresh
// deploy disagreed with production.

import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import pg from "pg";
import { CONNECTION, MIGRATIONS_DIR } from "./db-config.mjs";

const LEDGER = `
  create schema if not exists ops;
  create table if not exists ops.schema_migration (
    filename   text primary key,
    checksum   text not null,
    applied_at timestamptz not null default now(),
    ms         integer
  );
`;

const client = new pg.Client({ connectionString: CONNECTION });
await client.connect();

try {
  await client.query(LEDGER);

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const { rows } = await client.query(
    "select filename, checksum from ops.schema_migration");
  const applied = new Map(rows.map((r) => [r.filename, r.checksum]));

  let ran = 0;

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");

    if (applied.has(file)) {
      if (applied.get(file) !== checksum) {
        throw new Error(
          `${file} has changed since it was applied.\n` +
          "A migration that has run is history. Write a new one instead.",
        );
      }
      continue;
    }

    const started = Date.now();
    process.stdout.write(`  applying ${file} ... `);

    try {
      await client.query("begin");
      await client.query(sql);
      await client.query(
        "insert into ops.schema_migration (filename, checksum, ms) values ($1,$2,$3)",
        [file, checksum, Date.now() - started]);
      await client.query("commit");
      console.log(`${Date.now() - started}ms`);
      ran += 1;
    } catch (e) {
      await client.query("rollback").catch(() => {});
      console.log("FAILED");
      throw new Error(`${file}: ${e.message}`);
    }
  }

  console.log(
    ran === 0
      ? `up to date (${files.length} migrations)`
      : `applied ${ran} of ${files.length}`);
} finally {
  await client.end();
}
