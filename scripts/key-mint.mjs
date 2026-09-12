// Mint an API key for a machine caller.
//
//   node scripts/key-mint.mjs "Grocery storefront" orders:ingest,deliveries:read
//
// The key is printed once. Only its SHA-256 is stored, so a lost key
// is replaced, never recovered.

import pg from "pg";
import { CONNECTION } from "./db-config.mjs";

const name = process.argv[2];
const scopes = (process.argv[3] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const env = process.argv[4] ?? "LIVE";

if (!name || scopes.length === 0) {
  console.error('Usage: node scripts/key-mint.mjs "Name" scope1,scope2 [LIVE|SANDBOX]');
  console.error("Scopes: orders:ingest deliveries:read deliveries:write");
  console.error("        riders:read riders:write reports:read");
  process.exit(1);
}

const client = new pg.Client({ connectionString: CONNECTION });
await client.connect();

try {
  await client.query("begin");
  await client.query("select set_config('request.jwt.claims', $1, true)",
    [JSON.stringify({ sub: null, role: "system", actor_kind: "SYSTEM" })]);

  const { rows } = await client.query(
    "select * from integration.create_api_client($1,$2,'{}',$3)",
    [name, scopes, env]);

  await client.query("commit");

  console.log(`
  Key minted for "${name}".

    client_id  ${rows[0].client_id}
    key        ${rows[0].api_key}
    scopes     ${scopes.join(", ")}
    env        ${env}

  Store it now. Only the hash is kept.
`);
} catch (e) {
  await client.query("rollback").catch(() => {});
  console.error(e.message);
  process.exit(1);
} finally {
  await client.end();
}
