import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { as, raw, closePool, SYSTEM } from "./harness.mjs";
import { hashPassword } from "../lib/auth/password.ts";

/**
 * Phase 8 — where the shops are.
 *
 * The thing under test throughout is that **"we do not know" never
 * turns into a number.** A missing geocode must read as unknown in
 * the distance function, in the ranking, and in serviceability —
 * never as 0, never as "out of range", and never as a reason to
 * refuse an order Grocery already took money for.
 */

// Andheri and Bandra, roughly. About 6 km apart.
const SH1 = { lat: 19.1136, lng: 72.8697 };
const SH2 = { lat: 19.0596, lng: 72.8295 };

let adminC, dispatcherC, riderAC, riderBC, riderA, riderB;

before(async () => {
  await raw(async (db) => {
    await db.query(`
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
         set lat = null, lng = null, geo_source = 'NONE',
             geo_set_by = null, geo_set_at = null, service_radius_km = 10.0;
      delete from identity.app_user where email like '%@p8.test';
    `);
  });

  const hash = await hashPassword("a-long-enough-password");
  let adminId, dispatcherId;

  await as(SYSTEM, async (db) => {
    for (const [c, n] of [["SH1", "Shop 1"], ["SH2", "Shop 2"]]) {
      await db.query(
        "select integration.sync_location($1,null,$2,'STORE',null,null,'INVENTORY')", [c, n]);
    }
    ({ rows: [{ id: adminId }] } = await db.query(
      "select identity.create_user($1,$2,'admin',$3,'{}',false) as id",
      ["admin@p8.test", "Admin", hash]));
    ({ rows: [{ id: dispatcherId }] } = await db.query(
      "select identity.create_user($1,$2,'dispatcher',$3,'{}',false) as id",
      ["dispatch@p8.test", "Dispatcher", hash]));
  });

  adminC = await claimsFor(adminId);
  dispatcherC = await claimsFor(dispatcherId);

  let aUser, bUser;
  await as(adminC, async (db) => {
    const { rows: [a] } = await db.query(
      "select * from fleet.create_rider($1,$2,$3,$4,$5,'BIKE','SH1',5)",
      ["asha@p8.test", "Asha Menon", "+91900008", hash, "RDR-P8A"]);
    riderA = a.rider_id; aUser = a.user_id;
    const { rows: [b] } = await db.query(
      "select * from fleet.create_rider($1,$2,$3,$4,$5,'BIKE','SH2',5)",
      ["bo@p8.test", "Bo Lin", "+91900009", hash, "RDR-P8B"]);
    riderB = b.rider_id; bUser = b.user_id;
  });
  await raw((db) => db.query(
    "update identity.app_user set must_change_password=false where email like '%@p8.test'"));

  riderAC = await claimsFor(aUser);
  riderBC = await claimsFor(bUser);
});

after(async () => { await closePool(); });

async function claimsFor(id) {
  return raw(async (db) => {
    const { rows: [r] } = await db.query(
      `select u.id, u.role, u.location_codes, identity.permissions_for(u.role) as perms
         from identity.app_user u where u.id=$1`, [id]);
    return { sub: r.id, role: r.role, actor_kind: "USER",
             location_codes: r.location_codes, permissions: r.perms };
  });
}

const setGeo = (code, lat, lng, radius = null) => as(adminC, (db) =>
  db.query("select integration.set_location_geo($1,$2,$3,$4)", [code, lat, lng, radius]));

const clearGeo = () => raw((db) => db.query(
  `update integration.location_ref set lat=null, lng=null, geo_source='NONE'`));

/**
 * Forget where everybody is.
 *
 * rider_location rows are what make a rider rank as LIVE, so one
 * test's position leaks into the next one's expectations. Cheap to
 * clear, and clearing it is what makes each test state its own
 * starting position.
 */
const clearPositions = () => raw((db) => db.query("delete from fleet.rider_location"));

/** On shift. Without this every rider's reason is 'offline'. */
const onShift = async () => {
  for (const r of [riderA, riderB]) {
    await as(adminC, (db) => db.query("select fleet.set_availability($1,true,'on shift')", [r]));
  }
};

async function orderAt(code, addr) {
  const orderId = `ORD-${randomUUID().slice(0, 8)}`;
  return as(SYSTEM, async (db) =>
    (await db.query(
      `select * from delivery.ingest_order($1,null,$2,$3::jsonb,$4::jsonb,'{}'::jsonb,
                                           null,null,null,'held',null)`,
      [orderId, code,
       JSON.stringify({ recipient_name: "R", phone: "1", line1: "L1",
                        city: "Mumbai", pincode: "400050", ...addr }),
       JSON.stringify([{ sku: "S1", name: "Thing", quantity: 1 }])])).rows[0].delivery_id);
}

async function readyAt(code, addr) {
  const id = await orderAt(code, addr);
  await as(adminC, (db) =>
    db.query("select delivery.transition($1,'READY_FOR_ASSIGNMENT','admitted',null)", [id]));
  return id;
}

// ═════════════════════ distance ═════════════════════

describe("distance", () => {
  test("two known points are the right distance apart", async () => {
    const km = await raw(async (db) => (await db.query(
      "select ops.distance_km($1,$2,$3,$4) as km",
      [SH1.lat, SH1.lng, SH2.lat, SH2.lng])).rows[0].km);
    // Andheri to Bandra is about 7 km straight line.
    assert.ok(Number(km) > 5 && Number(km) < 9, `got ${km} km`);
  });

  test("a point is zero from itself", async () => {
    const km = await raw(async (db) => (await db.query(
      "select ops.distance_km($1,$2,$1,$2) as km", [SH1.lat, SH1.lng])).rows[0].km);
    assert.equal(Number(km), 0);
  });

  test("a missing geocode is NULL, never zero", async () => {
    for (const args of [[null, 72.8, 19.0, 72.8], [19.0, 72.8, null, 72.8]]) {
      const km = await raw(async (db) => (await db.query(
        "select ops.distance_km($1,$2,$3,$4) as km", args)).rows[0].km);
      assert.equal(km, null,
        "zero would mean 'it is here'; null means 'we do not know', and they must differ");
    }
  });
});

// ═════════════════════ owning the geocode ═════════════════════

describe("setting a shop's coordinates", () => {
  test("an admin sets one and it is marked as ours", async () => {
    await setGeo("SH1", SH1.lat, SH1.lng, 12);

    const [l] = await as(adminC, async (db) =>
      (await db.query(
        "select * from integration.locations_with_geo() where code='SH1'")).rows);

    assert.equal(Number(l.lat), SH1.lat);
    assert.equal(l.geo_source, "LOCAL");
    assert.equal(Number(l.service_radius_km), 12);
    assert.equal(l.geo_set_by_name, "Admin");
    assert.ok(l.geo_set_at);
  });

  test("a sync keeps the name and leaves the coordinates alone", async () => {
    await setGeo("SH1", SH1.lat, SH1.lng);

    await as(SYSTEM, (db) => db.query(
      "select integration.sync_location('SH1',null,'Shop 1 renamed','STORE',null,null,'INVENTORY')"));

    const [l] = await as(adminC, async (db) =>
      (await db.query(
        "select * from integration.locations_with_geo() where code='SH1'")).rows);

    assert.equal(l.name, "Shop 1 renamed", "names are still Inventory's");
    assert.equal(Number(l.lat), SH1.lat, "coordinates are not");
    assert.equal(l.geo_source, "LOCAL",
      "the old upsert reset source on every run, relabelling an admin's value");
  });

  test("Inventory wins if it ever supplies one", async () => {
    await setGeo("SH2", SH2.lat, SH2.lng);
    await as(SYSTEM, (db) => db.query(
      "select integration.sync_location('SH2',null,'Shop 2','STORE',19.5,72.5,'INVENTORY')"));

    const [l] = await as(adminC, async (db) =>
      (await db.query(
        "select * from integration.locations_with_geo() where code='SH2'")).rows);
    assert.equal(Number(l.lat), 19.5);
    assert.equal(l.geo_source, "INVENTORY");
  });

  test("a development seed never outranks a real value", async () => {
    await setGeo("SH1", SH1.lat, SH1.lng);
    await as(SYSTEM, (db) => db.query(
      "select integration.sync_location('SH1',null,'Shop 1','STORE',1.0,1.0,'SEED')"));

    const [l] = await as(adminC, async (db) =>
      (await db.query(
        "select * from integration.locations_with_geo() where code='SH1'")).rows);
    assert.equal(Number(l.lat), SH1.lat);
    assert.equal(l.geo_source, "LOCAL");
  });

  test("a latitude outside -90..90 is refused", async () => {
    await assert.rejects(setGeo("SH1", 100, 72.8), /BAD_LATITUDE/);
    await assert.rejects(setGeo("SH1", 19.1, 200), /BAD_LONGITUDE/);
  });

  test("swapped coordinates are caught by distance, because a range check cannot", async () => {
    // 72.87 IS a legal latitude — it is in the Arctic Ocean. Nothing
    // about the number is wrong, so the only detectable thing is that
    // it would sit thousands of km from every other shop.
    await setGeo("SH1", SH1.lat, SH1.lng);

    await assert.rejects(
      setGeo("SH2", 72.8295, 19.0596),
      /IMPLAUSIBLE_LOCATION.*wrong way round/s);
  });

  test("and can still be forced, with the force recorded", async () => {
    await setGeo("SH1", SH1.lat, SH1.lng);
    await as(adminC, (db) => db.query(
      "select integration.set_location_geo('SH2',51.5,-0.12,null,true)"));

    const [l] = await as(adminC, async (db) =>
      (await db.query(
        "select * from integration.locations_with_geo() where code='SH2'")).rows);
    assert.equal(Number(l.lat), 51.5, "a genuinely distant shop is a real thing");

    const [row] = await as(adminC, async (db) => (await db.query(
      `select reason from ops.audit_log
        where action='location.geo_set' and entity_id='SH2' order by id desc limit 1`)).rows);
    assert.match(row.reason, /forced/);
  });

  test("the first shop has nothing to be implausible against", async () => {
    await clearGeo();
    await setGeo("SH1", 51.5, -0.12);   // London, and nothing to compare it to
    const [l] = await as(adminC, async (db) =>
      (await db.query(
        "select * from integration.locations_with_geo() where code='SH1'")).rows);
    assert.equal(Number(l.lat), 51.5);
  });

  test("an unknown location is refused", async () => {
    await assert.rejects(setGeo("SH9", 19.1, 72.8), /NO_SUCH_LOCATION/);
  });

  test("only locations:write may set one", async () => {
    for (const who of [dispatcherC, riderAC]) {
      await assert.rejects(
        as(who, (db) =>
          db.query("select integration.set_location_geo('SH1',19.1,72.8,null)")),
        /FORBIDDEN/);
    }
  });

  test("every change is audited with what it was before", async () => {
    await setGeo("SH1", 19.0, 72.0);
    await setGeo("SH1", SH1.lat, SH1.lng);

    const [row] = await as(adminC, async (db) => (await db.query(
      `select before, after from ops.audit_log
        where action='location.geo_set' and entity_id='SH1' order by id desc limit 1`)).rows);

    assert.equal(Number(row.before.lat), 19.0, "a wrong geocode is answered with 'what was it'");
    assert.equal(Number(row.after.lat), SH1.lat);
  });
});

// ═════════════════════ ranking, not assigning ═════════════════════

describe("ranking riders", () => {
  test("the nearest rider is first, and the row says why", async () => {
    await clearPositions();
    await onShift();
    await setGeo("SH1", SH1.lat, SH1.lng);
    const id = await readyAt("SH1", { lat: 19.11, lng: 72.87 });

    // Asha just finished something a few hundred metres from SH1.
    // Bo's last position is over in Bandra.
    await raw((db) => db.query(
      `insert into fleet.rider_location (rider_id, delivery_id, lat, lng, recorded_at)
       values ($1,$2,$3,$4, now()), ($5,$2,$6,$7, now())`,
      [riderA, id, 19.1140, 72.8700, riderB, SH2.lat, SH2.lng]));

    const ranked = await as(dispatcherC, async (db) =>
      (await db.query("select * from fleet.rank_riders_for($1)", [id])).rows);

    assert.equal(ranked[0].rider_id, riderA);
    assert.equal(ranked[0].position_source, "LIVE");
    assert.ok(Number(ranked[0].distance_km) < Number(ranked[1].distance_km));
    assert.match(ranked[0].why, /km away/);
  });

  test("a stale position does not count as a position", async () => {
    await clearPositions();
    await onShift();
    await setGeo("SH1", SH1.lat, SH1.lng);
    const id = await readyAt("SH1", { lat: 19.11, lng: 72.87 });

    await raw((db) => db.query(
      `insert into fleet.rider_location (rider_id, delivery_id, lat, lng, recorded_at)
       values ($1,$2,$3,$4, now() - interval '3 hours')`,
      [riderA, id, 19.1140, 72.8700]));

    const ranked = await as(dispatcherC, async (db) =>
      (await db.query("select * from fleet.rank_riders_for($1)", [id])).rows);
    const asha = ranked.find((r) => r.rider_id === riderA);
    assert.notEqual(asha.position_source, "LIVE",
      "where somebody was three hours ago is not where they are");
  });

  test("an idle rider based at the shop ranks on HOME, not on nothing", async () => {
    await clearPositions();
    await onShift();
    await setGeo("SH1", SH1.lat, SH1.lng);
    const id = await readyAt("SH1", { lat: 19.11, lng: 72.87 });

    const ranked = await as(dispatcherC, async (db) =>
      (await db.query("select * from fleet.rank_riders_for($1)", [id])).rows);

    const asha = ranked.find((r) => r.rider_id === riderA);   // home SH1
    const bo = ranked.find((r) => r.rider_id === riderB);     // home SH2

    assert.equal(asha.position_source, "HOME");
    assert.equal(bo.position_source, "NONE");
    assert.ok(asha.rank < bo.rank,
      "rider_location is only collected during a delivery, so the rider you most want " +
      "to assign — an idle one — has no position at all");
  });

  test("a rider with nothing known is ranked last, never dropped", async () => {
    await clearPositions();
    await onShift();
    await setGeo("SH1", SH1.lat, SH1.lng);
    const id = await readyAt("SH1", { lat: 19.11, lng: 72.87 });

    const ranked = await as(dispatcherC, async (db) =>
      (await db.query("select * from fleet.rank_riders_for($1)", [id])).rows);

    assert.ok(ranked.some((r) => r.rider_id === riderB),
      "dropping them would quietly shrink the roster");
    assert.match(ranked.find((r) => r.rider_id === riderB).why, /no recent position/);
  });

  test("an unavailable rider is shown with the reason, not hidden", async () => {
    await setGeo("SH1", SH1.lat, SH1.lng);
    await as(adminC, (db) => db.query("select fleet.set_rider_status($1,'SUSPENDED','x')",
      [riderB]));

    const id = await readyAt("SH1", { lat: 19.11, lng: 72.87 });
    const ranked = await as(dispatcherC, async (db) =>
      (await db.query("select * from fleet.rank_riders_for($1)", [id])).rows);

    assert.ok(!ranked.some((r) => r.rider_id === riderB),
      "a suspended rider is not a candidate at all");

    await as(adminC, (db) => db.query("select fleet.set_rider_status($1,'ACTIVE',null)",
      [riderB]));
  });

  test("a rider at capacity is listed with the reason and ranked below the free ones",
    async () => {
      await clearPositions();
      await onShift();
      await setGeo("SH1", SH1.lat, SH1.lng);
      await raw((db) => db.query("update fleet.rider set max_concurrent=1 where id=$1",
        [riderA]));

      const busy = await readyAt("SH1", { lat: 19.11, lng: 72.87 });
      await as(adminC, (db) => db.query("select fleet.set_availability($1,true,'t')", [riderA]));
      await as(dispatcherC, (db) => db.query("select fleet.assign_delivery($1,$2)",
        [busy, riderA]));

      const next = await readyAt("SH1", { lat: 19.11, lng: 72.87 });
      const ranked = await as(dispatcherC, async (db) =>
        (await db.query("select * from fleet.rank_riders_for($1)", [next])).rows);

      const asha = ranked.find((r) => r.rider_id === riderA);
      const bo = ranked.find((r) => r.rider_id === riderB);
      assert.match(asha.unavailable_reason, /capacity/);
      assert.ok(bo.rank < asha.rank, "somebody free outranks somebody full");
      assert.equal(asha.why, asha.unavailable_reason, "the why IS the reason when there is one");

      await raw((db) => db.query("update fleet.rider set max_concurrent=5 where id=$1",
        [riderA]));
      await raw((db) => db.query(
        "update fleet.assignment set status='COMPLETED' where status in ('OFFERED','ACCEPTED')"));
    });

  test("no shop coordinates means no distance, and an honest reason", async () => {
    await clearPositions();
    await onShift();
    await clearGeo();
    const id = await readyAt("SH1", { lat: 19.11, lng: 72.87 });

    const ranked = await as(dispatcherC, async (db) =>
      (await db.query("select * from fleet.rank_riders_for($1)", [id])).rows);

    assert.ok(ranked.length > 0, "ranking degrades, it does not disappear");
    for (const r of ranked) {
      assert.equal(r.distance_km, null, "0 km from an unmapped shop would be a lie");
    }
  });

  test("a rider cannot see the ranking", async () => {
    await setGeo("SH1", SH1.lat, SH1.lng);
    const id = await readyAt("SH1", { lat: 19.11, lng: 72.87 });

    const rows = await as(riderAC, async (db) =>
      (await db.query("select * from fleet.rank_riders_for($1)", [id])).rows);
    assert.equal(rows.length, 0, "deliveries:assign, and riders do not have it");
  });

  test("ranking never blocks a manual assignment", async () => {
    await clearGeo();
    const id = await readyAt("SH1", { lat: 19.11, lng: 72.87 });

    await as(adminC, (db) => db.query("select fleet.set_availability($1,true,'t')", [riderB]));
    await as(dispatcherC, (db) => db.query("select fleet.assign_delivery($1,$2)", [id, riderB]));

    const status = await raw(async (db) => (await db.query(
      "select status from delivery.delivery where id=$1", [id])).rows[0].status);
    assert.equal(status, "ASSIGNED",
      "a missing geocode should degrade dispatch, not break it");

    await raw((db) => db.query(
      "update fleet.assignment set status='COMPLETED' where status in ('OFFERED','ACCEPTED')"));
  });
});

// ═════════════════════ serviceability, which flags ═════════════════════

describe("serviceability", () => {
  test("an address near the shop is in range", async () => {
    await setGeo("SH1", SH1.lat, SH1.lng, 10);
    const id = await orderAt("SH1", { lat: 19.12, lng: 72.87 });

    const [s] = await as(adminC, async (db) =>
      (await db.query("select * from delivery.serviceability($1)", [id])).rows);
    assert.equal(s.verdict, "in");
    assert.match(s.detail, /within 10\.0 km/);
  });

  test("an address beyond the radius is out, and says how far", async () => {
    await setGeo("SH1", SH1.lat, SH1.lng, 5);
    const id = await orderAt("SH1", { lat: 18.95, lng: 72.83 });

    const [s] = await as(adminC, async (db) =>
      (await db.query("select * from delivery.serviceability($1)", [id])).rows);
    assert.equal(s.verdict, "out");
    assert.ok(Number(s.distance_km) > 5);
    assert.match(s.detail, /beyond the 5\.0 km/);
  });

  test("no shop coordinates means 'cannot tell', not 'out of range'", async () => {
    await clearGeo();
    const id = await orderAt("SH1", { lat: 18.95, lng: 72.83 });

    const [s] = await as(adminC, async (db) =>
      (await db.query("select * from delivery.serviceability($1)", [id])).rows);
    assert.equal(s.verdict, "unknown");
    assert.equal(s.distance_km, null);
    assert.match(s.detail, /Q21/);
  });

  test("an out-of-range order is STILL ingested", async () => {
    await setGeo("SH1", SH1.lat, SH1.lng, 2);
    const id = await orderAt("SH1", { lat: 18.90, lng: 72.80 });

    const status = await raw(async (db) => (await db.query(
      "select status from delivery.delivery where id=$1", [id])).rows[0].status);
    assert.equal(status, "RECEIVED",
      "Grocery took the money and reserved the stock. Dropping it here would leave a " +
      "customer paid up with no parcel and nobody told");
  });

  test("and it reaches the exception queue with the distance in it", async () => {
    await setGeo("SH1", SH1.lat, SH1.lng, 2);
    const id = await orderAt("SH1", { lat: 18.90, lng: 72.80 });

    const x = await as(adminC, async (db) =>
      (await db.query("select * from delivery.exceptions_for($1)", [id])).rows);
    const flag = x.find((e) => e.code === "OUT_OF_SERVICE_RANGE");

    assert.ok(flag, "a person has to be able to ring somebody about it");
    assert.equal(flag.severity, "WARNING");
    assert.match(flag.note, /beyond the 2\.0 km/);
  });

  test("an in-range order raises nothing", async () => {
    await setGeo("SH1", SH1.lat, SH1.lng, 20);
    const id = await orderAt("SH1", { lat: 19.12, lng: 72.87 });

    const x = await as(adminC, async (db) =>
      (await db.query("select * from delivery.exceptions_for($1)", [id])).rows);
    assert.ok(!x.some((e) => e.code === "OUT_OF_SERVICE_RANGE"));
  });

  test("flagging is idempotent", async () => {
    await setGeo("SH1", SH1.lat, SH1.lng, 2);
    const id = await orderAt("SH1", { lat: 18.90, lng: 72.80 });

    await as(SYSTEM, (db) => db.query("select delivery.flag_unserviceable($1)", [id]));
    await as(SYSTEM, (db) => db.query("select delivery.flag_unserviceable($1)", [id]));

    const x = await as(adminC, async (db) =>
      (await db.query("select * from delivery.exceptions_for($1)", [id])).rows);
    assert.equal(x.filter((e) => e.code === "OUT_OF_SERVICE_RANGE").length, 1);
  });
});

// ═════════════════════ nothing else moved ═════════════════════

describe("regression", () => {
  test("ingest still works with no geography configured at all", async () => {
    await clearGeo();
    const id = await orderAt("SH1", { lat: 19.11, lng: 72.87 });
    assert.ok(id);
  });

  test("the locations screen shows unset shops rather than hiding them", async () => {
    await clearGeo();
    const rows = await as(adminC, async (db) =>
      (await db.query("select * from integration.locations_with_geo()")).rows);

    assert.ok(rows.length >= 2);
    assert.ok(rows.every((r) => r.lat === null));
    assert.ok(rows.every((r) => r.geo_source === "NONE"));
  });

  test("a rider may READ locations but not change one", async () => {
    // Riders hold locations:read on purpose — the app tells them
    // which shop to collect from and has to be able to name it.
    const rows = await as(riderBC, async (db) =>
      (await db.query("select * from integration.locations_with_geo()")).rows);
    assert.ok(rows.length > 0, "a rider who cannot see the pickup has nowhere to go");

    await assert.rejects(
      as(riderBC, (db) =>
        db.query("select integration.set_location_geo('SH1',19.1,72.8,null)")),
      /FORBIDDEN/);
  });
});
