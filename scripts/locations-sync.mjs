// Refresh the location cache from Inventory.
//
//   npm run locations:sync
//
// This is the one place Phase 1 talks to another system. It READS
// Inventory's locations and writes them into integration.location_ref.
// It never writes back. Inventory remains the source of truth for what
// a location is; we keep a copy so a dispatch screen does not make an
// HTTP call to render a dropdown.
//
// With no Inventory key configured it seeds from a fixture instead and
// marks every row source='SEED', so an operator can always tell a
// guess from a fact.

import pg from "pg";
import { CONNECTION } from "./db-config.mjs";
import { getLocations, isConfigured } from "../lib/inventory.ts";

/**
 * Fallback coordinates.
 *
 * Lifted from Grocery's src/config/stores.ts, which holds the only
 * geocodes anywhere in this estate. Development seed only -- a real
 * deployment syncs from Inventory and these rows are replaced.
 */
const SEED = [
  { code: "HUB", name: "Central Hub",   type: "HUB",   lat: 19.1000, lng: 72.9000 },
  { code: "SH1", name: "Shop 1 Andheri", type: "STORE", lat: 19.1136, lng: 72.8697 },
  { code: "SH2", name: "Shop 2 Bandra",  type: "STORE", lat: 19.0596, lng: 72.8295 },
  { code: "SH3", name: "Shop 3 Dadar",   type: "STORE", lat: 19.0178, lng: 72.8478 },
];

function normalise(row) {
  // Inventory's /api/locations returns { id, uuid, name, type, ... }
  // where `id` is the human code and `uuid` the real key. Tolerate
  // either shape rather than assuming one and failing opaquely.
  const code = String(row.code ?? row.id ?? "").toUpperCase();
  const uuid = row.uuid ?? (/^[0-9a-f-]{36}$/i.test(String(row.id)) ? row.id : null);
  const type = String(row.type ?? "STORE").toUpperCase();

  return {
    code,
    uuid,
    name: row.name ?? code,
    type: ["HUB", "STORE", "WAREHOUSE", "VIRTUAL"].includes(type) ? type : "STORE",
    lat: row.lat ?? null,
    lng: row.lng ?? null,
  };
}

let rows;
let source;

if (isConfigured()) {
  try {
    const live = await getLocations();
    rows = live.map(normalise).filter((r) => r.code);
    source = "INVENTORY";
    console.log(`  fetched ${rows.length} locations from Inventory`);
  } catch (e) {
    // A sync failure must leave the existing cache intact. Stale data
    // beats an empty dropdown, and the health check reports the
    // staleness either way.
    console.error(`  Inventory sync failed: ${e.message}`);
    console.error("  The existing cache is unchanged.");
    process.exit(1);
  }
} else {
  rows = SEED.map(normalise);
  source = "SEED";
  console.log("  INVENTORY_API_URL / INVENTORY_API_KEY not set - seeding from fixture");
}

const client = new pg.Client({ connectionString: CONNECTION });
await client.connect();

try {
  await client.query("begin");
  await client.query("select set_config('request.jwt.claims', $1, true)",
    [JSON.stringify({ sub: null, role: "system", actor_kind: "SYSTEM" })]);

  for (const r of rows) {
    await client.query(
      "select integration.upsert_location_ref($1,$2,$3,$4,$5,$6,$7)",
      [r.code, r.uuid, r.name, r.type, r.lat, r.lng, source]);
  }

  // A shop that has closed stops appearing in Inventory's response.
  // An upsert alone would leave it cached and active forever, and a
  // dispatcher would go on sending riders to collect parcels from a
  // shut store. Deactivate rather than delete: a past delivery still
  // refers to it, and history should stay resolvable.
  //
  // Only rows from a real sync are touched. A SEED row is a
  // placeholder, not a claim about what Inventory currently has.
  if (source === "INVENTORY") {
    const { rowCount } = await client.query(
      `update integration.location_ref
          set is_active = false
        where source = 'INVENTORY'
          and is_active
          and code <> all($1::text[])`,
      [rows.map((r) => r.code)]);

    if (rowCount > 0) console.log(`  deactivated ${rowCount} location(s) Inventory no longer lists`);
  }

  await client.query("select ops.audit($1,$2,$3,null,$4)", [
    "location.synced", "location_ref", null,
    JSON.stringify({ count: rows.length, source }),
  ]);

  await client.query("commit");
  console.log(`  cached ${rows.length} locations (source: ${source})`);
} catch (e) {
  await client.query("rollback").catch(() => {});
  console.error(e.message);
  process.exit(1);
} finally {
  await client.end();
}
