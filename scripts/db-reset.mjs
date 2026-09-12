// Drop every logistics schema and migrate from empty.
//
// Guarded: refuses to run against a non-local DATABASE_URL unless
// ALLOW_DESTRUCTIVE=true. Emptying the wrong database should require
// setting the wrong variable, not merely forgetting which one it is.

import { execSync } from "node:child_process";
import pg from "pg";
import { CONNECTION, assertNotProduction, ROOT } from "./db-config.mjs";

assertNotProduction("reset the database");

const client = new pg.Client({ connectionString: CONNECTION });
await client.connect();
try {
  await client.query(`
    drop schema if exists ops cascade;
    drop schema if exists identity cascade;
    drop schema if exists integration cascade;
    drop schema if exists delivery cascade;
    drop schema if exists fleet cascade;
  `);
  console.log("dropped logistics schemas");
} finally {
  await client.end();
}

execSync("node scripts/migrate.mjs", { cwd: ROOT, stdio: "inherit" });
