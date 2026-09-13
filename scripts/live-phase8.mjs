/**
 * Phase 8 live check — giving the shops a location, and watching
 * dispatch change because of it.
 *
 *   npm run live:phase8
 *
 * ── This TRUNCATES the delivery tables ──
 */
if (!/(127\.0\.0\.1|localhost)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("live:phase8 truncates delivery data and only runs against a local database.");
  process.exit(1);
}

import { randomUUID } from "node:crypto";
import { pool } from "../lib/db.ts";
import { hashPassword } from "../lib/auth/password.ts";

// Read off a maps app, the way an operator would.
const REAL = {
  SH1: { lat: 19.1136, lng: 72.8697, name: "Andheri" },
  SH2: { lat: 19.0596, lng: 72.8295, name: "Bandra" },
};

const SYSTEM = { sub: null, role: "system", actor_kind: "SYSTEM",
                 location_codes: [], permissions: ["*"] };

async function as(claims, fn) {
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify(claims)]);
    await db.query("set local role authenticated");
    const out = await fn(db);
    await db.query("commit");
    return out;
  } catch (e) { await db.query("rollback").catch(() => {}); throw e; }
  finally { db.release(); }
}
const raw = async (fn) => {
  const db = await pool.connect();
  try { return await fn(db); } finally { db.release(); }
};
const claimsFor = (email) => raw(async (db) => {
  const { rows: [r] } = await db.query(
    `select u.id, u.role, u.location_codes, identity.permissions_for(u.role) as perms
       from identity.app_user u where u.email=$1`, [email]);
  return { sub: r.id, role: r.role, actor_kind: "USER",
           location_codes: r.location_codes, permissions: r.perms };
});

await raw((db) => db.query(`
  truncate integration.rider_event, integration.outbound_event restart identity cascade;
  truncate fleet.rider_location, fleet.assignment, fleet.rider_availability,
           fleet.rider restart identity cascade;
  truncate delivery.delivery, delivery.delivery_address, delivery.delivery_item,
           delivery.delivery_otp, delivery.delivery_proof,
           delivery.delivery_exception restart identity cascade;
  alter table delivery.delivery_status_history disable trigger delivery_history_no_delete;
  delete from delivery.delivery_status_history;
  alter table delivery.delivery_status_history enable trigger delivery_history_no_delete;
  update integration.location_ref
     set lat=null, lng=null, geo_source='NONE', geo_set_by=null, geo_set_at=null;
  delete from identity.app_user where email like '%@live.test';
`));

const hash = await hashPassword("a-long-enough-password");
await as(SYSTEM, async (db) => {
  for (const [c, n] of [["SH1", "Shop 1 — Andheri"], ["SH2", "Shop 2 — Bandra"]]) {
    await db.query("select integration.sync_location($1,null,$2,'STORE',null,null,'INVENTORY')",
      [c, n]);
  }
  for (const [e, n, r] of [["admin@live.test", "Admin", "admin"],
                           ["dispatch@live.test", "Dispatcher", "dispatcher"]]) {
    await db.query("select identity.create_user($1,$2,$3,$4,'{}',false)", [e, n, r, hash]);
  }
});
const admin = await claimsFor("admin@live.test");
const dispatcher = await claimsFor("dispatch@live.test");

const riders = {};
await as(admin, async (db) => {
  for (const [email, name, code, home] of [
    ["asha@live.test", "Asha Menon", "RDR-L8A", "SH1"],
    ["bo@live.test",   "Bo Lin",     "RDR-L8B", "SH2"],
    ["cal@live.test",  "Cal Dias",   "RDR-L8C", "SH1"],
  ]) {
    const { rows: [r] } = await db.query(
      "select * from fleet.create_rider($1,$2,$3,$4,$5,'BIKE',$6,5)",
      [email, name, "+9190000" + code.slice(-1), hash, code, home]);
    riders[code] = r.rider_id;
  }
});
await raw((db) => db.query(
  "update identity.app_user set must_change_password=false where email like '%@live.test'"));
for (const id of Object.values(riders)) {
  await as(admin, (db) => db.query("select fleet.set_availability($1,true,'on shift')", [id]));
}

// ── An order, before anybody knows where the shop is ──
const orderId = `ORD-P8-${randomUUID().slice(0, 8)}`;
const id = await as(SYSTEM, async (db) =>
  (await db.query(
    `select * from delivery.ingest_order($1,null,'SH1',$2::jsonb,$3::jsonb,'{}'::jsonb,
                                         null,null,null,'held',null)`,
    [orderId,
     JSON.stringify({ recipient_name: "R Iyer", phone: "+91900111", line1: "12 Hill Rd",
                      city: "Mumbai", pincode: "400058", lat: 19.1200, lng: 72.8600 }),
     JSON.stringify([{ sku: "S1", name: "Milk", quantity: 2 }])])).rows[0].delivery_id);
await as(admin, (db) =>
  db.query("select delivery.transition($1,'READY_FOR_ASSIGNMENT','admitted',null)", [id]));

const show = async (label) => {
  console.log(`\n── ${label} ──`);
  const ranked = await as(dispatcher, async (db) =>
    (await db.query("select * from fleet.rank_riders_for($1)", [id])).rows);
  for (const r of ranked) {
    console.log(`  ${String(r.rank)}. ${r.code.padEnd(9)} ${r.display_name.padEnd(12)} ` +
                `${String(r.distance_km ?? "—").padStart(6)} km  ${r.position_source.padEnd(5)} ` +
                `${r.why}`);
  }
  const [s] = await as(admin, async (db) =>
    (await db.query("select * from delivery.serviceability($1)", [id])).rows);
  console.log(`  serviceability: ${s.verdict} — ${s.detail}`);
};

await show("before anybody set a geocode");

// ── An admin reads the coordinates off a map ──
for (const [code, g] of Object.entries(REAL)) {
  await as(admin, (db) =>
    db.query("select integration.set_location_geo($1,$2,$3,10)", [code, g.lat, g.lng]));
  console.log(`\nset ${code} (${g.name}) to ${g.lat}, ${g.lng}`);
}

// Cal just dropped something off round the corner from SH1.
await raw((db) => db.query(
  `insert into fleet.rider_location (rider_id, delivery_id, lat, lng, recorded_at)
   values ($1,$2,19.1150,72.8710, now())`, [riders["RDR-L8C"], id]));

await show("with coordinates, and Cal a street away");

// ── The swap that a range check cannot catch ──
console.log("\n── what happens if somebody swaps them ──");
try {
  await as(admin, (db) =>
    db.query("select integration.set_location_geo('SH2',72.8295,19.0596,null)"));
  console.log("  PROBLEM: accepted");
} catch (e) {
  console.log(" ", e.message.split(". ").slice(0, 2).join(". "));
}

// ── An order from far away ──
const farId = await as(SYSTEM, async (db) =>
  (await db.query(
    `select * from delivery.ingest_order($1,null,'SH1',$2::jsonb,$3::jsonb,'{}'::jsonb,
                                         null,null,null,'held',null)`,
    [`ORD-P8-${randomUUID().slice(0, 8)}`,
     JSON.stringify({ recipient_name: "Far Away", phone: "1", line1: "Somewhere",
                      city: "Pune", pincode: "411001", lat: 18.5204, lng: 73.8567 }),
     JSON.stringify([{ sku: "S1", name: "Milk", quantity: 1 }])])).rows[0].delivery_id);

const [far] = await as(admin, async (db) =>
  (await db.query("select * from delivery.serviceability($1)", [farId])).rows);
const farStatus = await raw(async (db) => (await db.query(
  "select status from delivery.delivery where id=$1", [farId])).rows[0].status);

console.log("\n── an order from Pune, 120 km away ──");
console.log(`  serviceability : ${far.verdict} — ${far.detail}`);
console.log(`  delivery status: ${farStatus}   (ingested anyway, on purpose)`);

const x = await as(admin, async (db) =>
  (await db.query("select * from delivery.open_exceptions(20)")).rows
    .filter((e) => e.delivery_id === farId));
for (const e of x) console.log(`  flagged        : ${e.code} (${e.severity}) — ${e.note}`);

await pool.end();
