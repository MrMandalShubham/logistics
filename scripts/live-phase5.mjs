/**
 * Phase 5 live check — one order, start to finish, against a receiver
 * that verifies the signature exactly as Grocery's route does.
 *
 *   node scripts/grocery-stub.mjs           (in another terminal)
 *   npm run live:phase5
 *
 * ── This TRUNCATES the delivery tables ──
 *
 * It is a development check that needs a clean queue to count events
 * in, so it refuses to run against anything but a local database.
 */
if (!/(127\.0\.0\.1|localhost)/.test(process.env.DATABASE_URL ?? "")) {
  console.error(
    "live:phase5 truncates delivery data and will only run against a local " +
    "database. DATABASE_URL does not look local — refusing.");
  process.exit(1);
}

process.env.GROCERY_BASE_URL = "http://127.0.0.1:3399";
process.env.GROCERY_WEBHOOK_SECRET = "stub-secret";

import { randomUUID } from "node:crypto";
import { pool } from "../lib/db.ts";
import { drainOnce } from "../lib/outbound.ts";
import { hashPassword } from "../lib/auth/password.ts";

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
    const r = await drainOnce(db, { batch: 20, worker: "live-p5" });
    await db.query("commit");
    console.log(`   queue: claimed ${r.claimed}, delivered ${r.delivered}, ` +
                `retrying ${r.retrying}, dead ${r.dead}`);
  } finally { db.release(); }
}

// ── a clean slate, and one rider ──
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
  await db.query("select identity.create_user($1,$2,'admin',$3,'{}',false)",
    ["admin@live.test", "Admin", hash]);
  await db.query("select identity.create_user($1,$2,'dispatcher',$3,'{}',false)",
    ["dispatch@live.test", "Dispatcher", hash]);
});
const admin = await claimsFor("admin@live.test");
const dispatcher = await claimsFor("dispatch@live.test");

const riderId = await as(admin, async (db) =>
  (await db.query("select * from fleet.create_rider($1,$2,$3,$4,$5,'BIKE','SH1',5)",
    ["asha@live.test", "Asha Menon", "+91900005", hash, "RDR-L1"])).rows[0].rider_id);
await raw((db) => db.query(
  "update identity.app_user set must_change_password=false where email like '%@live.test'"));
const rider = await claimsFor("asha@live.test");

// ── one order ──
const orderId = `ORD-${randomUUID().slice(0, 8)}`;
const id = await as(SYSTEM, async (db) =>
  (await db.query(
    `select * from delivery.ingest_order($1,'CUST-1','SH1',$2::jsonb,$3::jsonb,'{}'::jsonb,
                                         null,null,null,'held',null)`,
    [orderId,
     JSON.stringify({ recipient_name: "R Iyer", phone: "+91900111", line1: "12 Hill Rd",
                      city: "Mumbai", pincode: "400050", lat: 19.06, lng: 72.83,
                      instructions: "key under the blue pot" }),
     JSON.stringify([{ sku: "MILK-1L", name: "Milk 1L", quantity: 2 }])])).rows[0].delivery_id);

console.log(`order ${orderId}  ->  delivery ${id}\n`);

const step = async (label, fn) => {
  await fn();
  const s = await raw(async (db) =>
    (await db.query("select status from delivery.delivery where id=$1", [id])).rows[0].status);
  console.log(`${label.padEnd(34)} logistics: ${s}`);
  await drain(label);
};

await step("dispatcher admits it", () => as(admin, (db) =>
  db.query("select delivery.transition($1,'READY_FOR_ASSIGNMENT','admitted',null)", [id])));
await step("dispatcher assigns Asha", async () => {
  await as(admin, (db) => db.query("select fleet.set_availability($1,true,'on shift')", [riderId]));
  await as(dispatcher, (db) => db.query("select fleet.assign_delivery($1,$2)", [id, riderId]));
});
await step("Asha accepts", () => as(rider, (db) =>
  db.query("select fleet.respond_to_assignment($1,true,null)", [id])));
for (const to of ["PICKUP_PENDING", "PICKED_UP", "OUT_FOR_DELIVERY", "ARRIVED"]) {
  await step(`Asha taps ${to}`, () => as(rider, (db) =>
    db.query("select delivery.rider_step($1,$2,'step',null)", [id, to])));
}
const code = await as(admin, async (db) =>
  (await db.query("select delivery.issue_otp($1) as c", [id])).rows[0].c);
console.log(`\n   support reads the code out: ${code}  (never sent to Grocery)\n`);
await step("Asha enters the code", () => as(rider, (db) =>
  db.query("select delivery.complete_delivery($1,$2,null)", [id, code])));

// ── what the customer saw ──
const s = await (await fetch("http://127.0.0.1:3399/__received")).json();

console.log("\n── what the customer's order page said, in order ──");
for (const r of s.received) {
  console.log(`   ${String(r.status).padEnd(10)} ${String(r.step ?? "-").padEnd(17)} ` +
              `seq=${String(r.seq).padEnd(3)} ${r.message}`);
}
console.log(`\n   ${s.received.length} events for a 8-transition journey.`);

console.log("\n── Grocery's order row now ──");
console.log("  ", JSON.stringify(s.orders[0]?.[1]));

const notif = await as(admin, async (db) =>
  (await db.query(
    `select channel, status, payload->>'customer_status' as cs
       from ops.notification where delivery_id=$1 order by id`, [id])).rows);
console.log("\n── notification log ──");
for (const n of notif) console.log(`   ${n.channel}  ${n.status.padEnd(9)} ${n.cs}`);

const health = await as(admin, async (db) =>
  (await db.query("select * from integration.outbound_health()")).rows);
console.log("\n── outbound health ──");
for (const h of health) console.log(`   ${h.target.padEnd(10)} ${h.status.padEnd(10)} ${h.n}`);

await pool.end();
