// Start a local Postgres for development.
//
// Port 55433, not 5432, so it cannot collide with a system Postgres
// or with the Inventory container on 55432.

import { execSync } from "node:child_process";

const NAME = process.env.PG_CONTAINER ?? "logistics-pg";
const PORT = process.env.PG_PORT ?? "55433";

function sh(cmd) { return execSync(cmd, { encoding: "utf8" }).trim(); }

try {
  const existing = sh(`docker ps -aq --filter name=^${NAME}$`);
  if (existing) {
    sh(`docker start ${NAME}`);
    console.log(`started existing container ${NAME} on :${PORT}`);
  } else {
    sh(`docker run -d --name ${NAME} -p ${PORT}:5432 ` +
       `-e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=logistics_core ` +
       `postgres:17-alpine`);
    console.log(`created ${NAME} on :${PORT}`);
  }
} catch (e) {
  console.error("Could not start Postgres. Is Docker Desktop running?");
  console.error(e.message);
  process.exit(1);
}

// Wait for it to accept connections. A container that is "running" is
// not yet a database that answers.
const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  try {
    sh(`docker exec ${NAME} pg_isready -U postgres -d logistics_core`);
    console.log("ready");
    process.exit(0);
  } catch {
    await new Promise((r) => setTimeout(r, 1000));
  }
}
console.error("Postgres did not become ready within 60s");
process.exit(1);
