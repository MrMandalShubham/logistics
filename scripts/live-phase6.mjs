/**
 * Phase 6 live check — the journey with no happy path.
 *
 *   node scripts/grocery-stub.mjs     (in another terminal)
 *   npm run live:phase6
 *
 * Unlike every earlier live check, this uses a REAL Inventory
 * reservation, so the release at the end is verified against stock
 * that actually moved rather than against a 404.
 *
 * ── This TRUNCATES the delivery tables ──
 */
if (!/(127\.0\.0\.1|localhost)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("live:phase6 truncates delivery data and only runs against a local database.");
  process.exit(1);
}

process.env.GROCERY_BASE_URL = "http://127.0.0.1:3399";
process.env.GROCERY_WEBHOOK_SECRET = "stub-secret";

import { randomUUID } from "node:crypto";
import { pool } from "../lib/db.ts";
import { drainOnce } from "../lib/outbound.ts";
import { hashPassword } from "../lib/auth/password.ts";

const INV = process.env.INVENTORY_API_URL;
const KEY = process.env.INVENTORY_API_KEY;
const SKU = process.env.P6_SKU ?? "PRD-FIXTURE-A";
const QTY = 2;

const inv = async (path, body) => {
  const res = await fetch(INV + path, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
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

async function drain(label) {
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify(SYSTEM)]);
    await db.query("set local role authenticated");
    const r = await drainOnce(db, { batch: 20, worker: "live-p6" });
    await db.query("commit");
    if (r.claimed) console.log(`   queue: ${JSON.stringify(r)}`);
  } finally { db.release(); }
}

// ── clean slate ──
await raw((db) => db.query(`
  truncate ops.notification restart identity cascade;
  truncate integration.rider_event, integration.outbound_event restart identity cascade;
  truncate fleet.rider_location, fleet.assignment, fleet.rider_availability,
           fleet.rider restart identity cascade;
  truncate delivery.delivery, delivery.delivery_address, delivery.delivery_item,
           delivery.delivery_otp, delivery.delivery_proof,
           delivery.delivery_exception restart identity cascade;
  alter table delivery.delivery_status_history disable trigger delivery_history_no_delete;
  delete from delivery.delivery_status_history;
  alter table delivery.delivery_status_history enable trigger delivery_history_no_delete;
  delete from identity.app_user where email like '%@live.test';
`));

const hash = await hashPassword("a-long-enough-password");
await as(SYSTEM, async (db) => {
  await db.query(
    "select integration.upsert_location_ref('SH1',null,'Shop 1','STORE',null,null,'SEED')");
  for (const [e, n, r] of [["admin@live.test", "Admin", "admin"],
                           ["dispatch@live.test", "Dispatcher", "dispatcher"]]) {
    await db.query("select identity.create_user($1,$2,$3,$4,'{}',false)", [e, n, r, hash]);
  }
});
const admin = await claimsFor("admin@live.test");
const dispatcher = await claimsFor("dispatch@live.test");
const riderId = await as(admin, async (db) =>
  (await db.query("select * from fleet.create_rider($1,$2,$3,$4,$5,'BIKE','SH1',5)",
    ["asha@live.test", "Asha Menon", "+91900005", hash, "RDR-L6"])).rows[0].rider_id);
await raw((db) => db.query(
  "update identity.app_user set must_change_password=false where email like '%@live.test'"));
const rider = await claimsFor("asha@live.test");

// ── 1. A REAL reservation in Inventory ──
const orderId = `ORD-P6-${randomUUID().slice(0, 8)}`;
const reserved = await inv("/api/inventory/reserve",
  { order_id: orderId, location: "SH1", items: [{ sku: SKU, quantity: QTY }] });

if (!reserved.ok) {
  console.error("could not reserve in Inventory:", JSON.stringify(reserved));
  process.exit(1);
}
const before = await inv(`/api/inventory/order/${orderId}`);
console.log(`order ${orderId}`);
console.log(`  reserved ${QTY} x ${SKU} at SH1 -> inventory says "${before.status}"`);
console.log(`  hold expires ${before.items[0].expires_at}\n`);

// ── 2. Into logistics ──
const id = await as(SYSTEM, async (db) =>
  (await db.query(
    `select * from delivery.ingest_order($1,'CUST-6','SH1',$2::jsonb,$3::jsonb,'{}'::jsonb,
                                         null,null,null,'held',null)`,
    [orderId,
     JSON.stringify({ recipient_name: "R Iyer", phone: "+91900111", line1: "12 Hill Rd",
                      city: "Mumbai", pincode: "400050", lat: 19.06, lng: 72.83 }),
     JSON.stringify([{ sku: SKU, name: "Fixture Product A", quantity: QTY }])])).rows[0].delivery_id);

const step = async (label, fn) => {
  await fn();
  const s = await raw(async (db) =>
    (await db.query("select status from delivery.delivery where id=$1", [id])).rows[0].status);
  console.log(`${label.padEnd(38)} ${s}`);
  await drain(label);
};

await step("dispatcher admits it", () => as(admin, (db) =>
  db.query("select delivery.transition($1,'READY_FOR_ASSIGNMENT','admitted',null)", [id])));
await step("assigns Asha, Asha accepts", async () => {
  await as(admin, (db) => db.query("select fleet.set_availability($1,true,'on shift')", [riderId]));
  await as(dispatcher, (db) => db.query("select fleet.assign_delivery($1,$2)", [id, riderId]));
  await as(rider, (db) => db.query("select fleet.respond_to_assignment($1,true,null)", [id]));
});
for (const to of ["PICKUP_PENDING", "PICKED_UP", "OUT_FOR_DELIVERY", "ARRIVED"]) {
  await step(`Asha taps ${to}`, () => as(rider, (db) =>
    db.query("select delivery.rider_step($1,$2,'step',null)", [id, to])));
}

// ── 3. Nobody home ──
await step("nobody home", () => as(rider, (db) =>
  db.query("select delivery.fail_delivery($1,'CUSTOMER_UNREACHABLE','rang twice, no answer')",
    [id])));

const held = await raw(async (db) => (await db.query(
  `select r.display_name from delivery.delivery d
     join fleet.rider r on r.id = d.parcel_with_rider_id where d.id=$1`, [id])).rows[0]);
console.log(`   the parcel is with ${held.display_name}, and the assignment is still theirs\n`);

// ── 4. A person decides ──
const ret = await as(dispatcher, async (db) =>
  (await db.query("select delivery.require_return($1,'customer moved away') as r", [id]))
    .rows[0].r);
console.log(`dispatcher decides: bring it back to ${ret.return_to}`);
await drain("return ordered");

console.log(`   releases queued so far: ${await releases()} (the parcel is still in a bag)\n`);

await step("Asha taps RETURN_IN_TRANSIT", () => as(rider, (db) =>
  db.query("select delivery.rider_step($1,'RETURN_IN_TRANSIT','carrying it back',null)", [id])));
await step("Asha hands it back at SH1", () => as(rider, (db) =>
  db.query("select delivery.rider_step($1,'RETURNED','handed back',null)", [id])));

async function releases() {
  return raw(async (db) => (await db.query(
    `select count(*)::int n from integration.outbound_event
      where delivery_id=$1 and event='inventory.release'`, [id])).rows[0].n);
}

// ── 5. Inventory is told, and the telling is verified ──
const after = await inv(`/api/inventory/order/${orderId}`);
const rs = await raw(async (db) => (await db.query(
  "select release_status, returned_at from delivery.delivery where id=$1", [id])).rows[0]);

console.log("\n── Inventory ──");
console.log(`   before: "${before.status}"   after: "${after.status}"`);
console.log(`   logistics records the release as: ${rs.release_status}`);
console.log(`   returned_at ${rs.returned_at?.toISOString?.() ?? rs.returned_at}`);

// ── 6. The customer ──
const seen = await (await fetch("http://127.0.0.1:3399/__received")).json();
console.log("\n── what the customer's order page said ──");
for (const r of seen.received) {
  console.log(`   ${String(r.status).padEnd(10)} ${String(r.step ?? "-").padEnd(17)} ${r.message}`);
}

// ── 7. The exception, and closing it ──
const open = await as(dispatcher, async (db) =>
  (await db.query("select * from delivery.open_exceptions(50)")).rows);
console.log("\n── the dispatcher's queue ──");
for (const x of open) {
  console.log(`   ${x.code.padEnd(24)} ${x.severity.padEnd(8)} ${x.tracking_id}  (${x.status})`);
}

if (open.length) {
  await as(dispatcher, (db) =>
    db.query("select delivery.resolve_exception($1,'RETURNED_TO_SHOP',$2)",
      [open[0].id, "customer moved; parcel back on the shelf at SH1"]));
}

const trail = await as(admin, async (db) =>
  (await db.query("select * from delivery.exceptions_for($1)", [id])).rows);
console.log("\n── the record it leaves ──");
for (const x of trail) {
  console.log(`   ${x.code}: "${x.note}"`);
  console.log(`     -> ${x.resolution_code ?? "OPEN"}` +
              (x.resolved_by_name ? ` by ${x.resolved_by_name}: "${x.resolution}"` : ""));
}

const left = await as(dispatcher, async (db) =>
  (await db.query("select count(*)::int n from delivery.open_exceptions(50)")).rows[0].n);
console.log(`\n   open exceptions remaining: ${left}`);

await pool.end();
