import { test, before, beforeEach, after, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { as, raw, refuses, closePool, SYSTEM } from "./harness.mjs";
import { hashPassword } from "../lib/auth/password.ts";
import { allowedNext, STATUSES } from "../lib/delivery/states.ts";

let adminC, dispatcherC, riderAC, riderBC;
let riderA, riderB;           // fleet.rider ids
let riderAUser, riderBUser;   // identity.app_user ids

before(async () => {
  await raw(async (db) => {
    await db.query(`
      truncate fleet.assignment, fleet.rider_availability, fleet.rider restart identity cascade;
      truncate delivery.delivery, delivery.delivery_address,
               delivery.delivery_item restart identity cascade;
      alter table delivery.delivery_status_history disable trigger delivery_history_no_delete;
      delete from delivery.delivery_status_history;
      alter table delivery.delivery_status_history enable trigger delivery_history_no_delete;
      delete from identity.app_user where email like '%@p3.test';
    `);
  });

  const hash = await hashPassword("a-long-enough-password");

  // Ids are collected inside the transaction; claims are resolved AFTER
  // it commits. claimsFor() opens its own connection, so it cannot see
  // rows that are still uncommitted — which is exactly how the first
  // version of this hook failed.
  let adminId, dispatcherId;

  await as(SYSTEM, async (db) => {
    for (const [c, n] of [["SH1", "Shop 1"], ["SH2", "Shop 2"]]) {
      await db.query(
        "select integration.upsert_location_ref($1,null,$2,'STORE',null,null,'SEED')", [c, n]);
    }

    ({ rows: [{ id: adminId }] } = await db.query(
      "select identity.create_user($1,$2,'admin',$3,'{}',false) as id",
      ["admin@p3.test", "P3 Admin", hash]));

    ({ rows: [{ id: dispatcherId }] } = await db.query(
      "select identity.create_user($1,$2,'dispatcher',$3,'{}',false) as id",
      ["dispatch@p3.test", "P3 Dispatcher", hash]));
  });

  adminC = await claimsFor(adminId);
  dispatcherC = await claimsFor(dispatcherId);

  // Riders are created through the real path, so the test exercises
  // the same two-row transaction an onboarding does.
  await as(adminC, async (db) => {
    const { rows: [a] } = await db.query(
      "select * from fleet.create_rider($1,$2,$3,$4,$5,$6,$7,$8)",
      ["rider-a@p3.test", "Rider A", "+919000000001", hash, "RDR-A", "BIKE", "SH1", 10]);
    riderA = a.rider_id; riderAUser = a.user_id;

    const { rows: [b] } = await db.query(
      "select * from fleet.create_rider($1,$2,$3,$4,$5,$6,$7,$8)",
      ["rider-b@p3.test", "Rider B", "+919000000002", hash, "RDR-B", "SCOOTER", "SH1", 10]);
    riderB = b.rider_id; riderBUser = b.user_id;
  });

  // create_rider forces a password change; clear it so the rider can
  // act in these tests the way they would after first sign-in.
  await raw((db) => db.query(
    "update identity.app_user set must_change_password=false where email like '%@p3.test'"));

  riderAC = await claimsFor(riderAUser);
  riderBC = await claimsFor(riderBUser);
});

after(async () => { await closePool(); });

async function claimsFor(id) {
  return raw(async (db) => {
    const { rows } = await db.query(
      `select u.id, u.role, u.location_codes, identity.permissions_for(u.role) as perms
         from identity.app_user u where u.id = $1`, [id]);
    const r = rows[0];
    return { sub: r.id, role: r.role, actor_kind: "USER",
             location_codes: r.location_codes, permissions: r.perms };
  });
}

/** An admitted delivery, ready to be assigned. */
async function admittedDelivery(location = "SH1") {
  const orderId = `ORD-${randomUUID().slice(0, 8)}`;
  const r = await as(SYSTEM, async (db) => {
    const { rows } = await db.query(
      `select * from delivery.ingest_order($1,null,$2,$3::jsonb,$4::jsonb,'{}'::jsonb,
                                           null,null,null,'held',null)`,
      [orderId, location,
       JSON.stringify({ recipient_name: "A", phone: "1", line1: "L1",
                        city: "Mumbai", pincode: "400058", lat: 19.1, lng: 72.8 }),
       JSON.stringify([{ sku: "SKU-1", name: "Thing", quantity: 1 }])]);
    return rows[0];
  });

  await as(adminC, (db) =>
    db.query("select delivery.transition($1,'READY_FOR_ASSIGNMENT','admitted',null)",
      [r.delivery_id]));

  return r.delivery_id;
}

/**
 * Free every rider by closing their live assignments.
 *
 * Tests share riders, and a rider still holding a parcel from an
 * earlier test is legitimately at capacity — which is the guard
 * working, not a bug. Phase 4 will close assignments when a delivery
 * completes; until then the tests do it explicitly.
 */
async function clearLoad() {
  await raw((db) => db.query(
    `update fleet.assignment set status = 'COMPLETED', responded_at = now()
      where status in ('OFFERED','ACCEPTED')`));
}

async function online(riderId, on = true) {
  return as(adminC, (db) =>
    db.query("select fleet.set_availability($1,$2,'test')", [riderId, on]));
}

// ───────────────────── riders ─────────────────────

describe("riders", () => {
  test("creating one makes a login AND a profile", async () => {
    const { rows } = await raw((db) => db.query(
      `select r.code, r.display_name, u.email, u.role, u.must_change_password
         from fleet.rider r join identity.app_user u on u.id = r.user_id
        where r.id = $1`, [riderA]));

    assert.equal(rows[0].code, "RDR-A");
    assert.equal(rows[0].role, "rider");
    assert.equal(rows[0].email, "rider-a@p3.test");
  });

  test("a new rider starts OFFLINE", async () => {
    const { rows } = await raw((db) => db.query(
      "select is_online from fleet.rider_current where id = $1", [riderB]));
    assert.equal(rows[0].is_online, false,
      "somebody who has not said they are working is not working");
  });

  test("a duplicate code is refused", async () => {
    const hash = await hashPassword("a-long-enough-password");
    await refuses(() => as(adminC, (db) =>
      db.query("select * from fleet.create_rider($1,$2,$3,$4,$5)",
        ["dupe@p3.test", "Dupe", "+91900", hash, "RDR-A"])), /duplicate key|unique/i);
  });

  test("a dispatcher cannot create a rider", async () => {
    const hash = await hashPassword("a-long-enough-password");
    await refuses(() => as(dispatcherC, (db) =>
      db.query("select * from fleet.create_rider($1,$2,$3,$4)",
        ["nope@p3.test", "Nope", "+91900", hash])), /FORBIDDEN/);
  });

  test("a dispatcher CAN read riders", async () => {
    const { rows } = await as(dispatcherC, (db) =>
      db.query("select id from fleet.rider"));
    assert.ok(rows.length >= 2);
  });

  test("a rider sees only themselves", async () => {
    const { rows } = await as(riderAC, (db) =>
      db.query("select id from fleet.rider"));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, riderA);
  });

  test("offboarding also disables the login", async () => {
    const hash = await hashPassword("a-long-enough-password");
    const { rows: [t] } = await as(adminC, (db) =>
      db.query("select * from fleet.create_rider($1,$2,$3,$4,$5)",
        ["gone@p3.test", "Gone", "+91900", hash, "RDR-Z"]));

    await as(adminC, (db) =>
      db.query("select fleet.set_rider_status($1,'OFFBOARDED','left')", [t.rider_id]));

    const { rows } = await raw((db) => db.query(
      "select status from identity.app_user where id = $1", [t.user_id]));
    assert.equal(rows[0].status, "DISABLED",
      "a roster change that leaves the door open is not an offboarding");
  });
});

// ───────────────────── availability ─────────────────────

describe("availability", () => {
  test("going online is recorded with who did it", async () => {
    await online(riderA, true);
    const { rows } = await raw((db) => db.query(
      `select is_online, changed_by from fleet.rider_availability
        where rider_id = $1 order by id desc limit 1`, [riderA]));
    assert.equal(rows[0].is_online, true);
    assert.ok(rows[0].changed_by, "staff action records the actor");
  });

  test("a rider may toggle themselves, and that is recorded as self", async () => {
    await as(riderAC, (db) =>
      db.query("select fleet.set_availability($1,true,'starting my shift')", [riderA]));

    const { rows } = await raw((db) => db.query(
      `select changed_by from fleet.rider_availability
        where rider_id = $1 order by id desc limit 1`, [riderA]));
    assert.equal(rows[0].changed_by, null, "null means the rider did it themselves");
  });

  test("a rider may NOT toggle somebody else", async () => {
    await refuses(() => as(riderAC, (db) =>
      db.query("select fleet.set_availability($1,true,'not mine')", [riderB])),
      /FORBIDDEN/);
  });

  test("a suspended rider cannot go online", async () => {
    await as(adminC, (db) =>
      db.query("select fleet.set_rider_status($1,'SUSPENDED','test')", [riderB]));

    await refuses(() => as(adminC, (db) =>
      db.query("select fleet.set_availability($1,true,null)", [riderB])),
      /RIDER_NOT_ACTIVE/);

    await as(adminC, (db) =>
      db.query("select fleet.set_rider_status($1,'ACTIVE','test')", [riderB]));
  });

  test("the view reflects the latest entry", async () => {
    await online(riderB, true);
    await online(riderB, false);
    const { rows } = await raw((db) => db.query(
      "select is_online from fleet.rider_current where id = $1", [riderB]));
    assert.equal(rows[0].is_online, false);
  });
});

// ───────────────────── the state machine ─────────────────────

describe("state machine", () => {
  test("the TypeScript mirror still agrees with the database", async () => {
    for (const status of STATUSES) {
      const { rows } = await raw((db) => db.query(
        "select delivery.allowed_next($1) as next", [status]));
      assert.deepEqual(
        [...rows[0].next].sort(), [...allowedNext(status)].sort(),
        `allowed_next('${status}') differs between SQL and lib/delivery/states.ts`);
    }
  });

  test("ASSIGNED and ACCEPTED are now reachable", async () => {
    assert.ok(allowedNext("READY_FOR_ASSIGNMENT").includes("ASSIGNED"));
    assert.ok(allowedNext("ASSIGNED").includes("ACCEPTED"));
  });
});

// ───────────────────── assignment ─────────────────────

describe("assignment", () => {
  beforeEach(clearLoad);

  test("assigning an available rider works and is recorded", async () => {
    await online(riderA, true);
    const d = await admittedDelivery();

    await as(dispatcherC, (db) =>
      db.query("select fleet.assign_delivery($1,$2,120)", [d, riderA]));

    const { rows } = await raw((db) => db.query(
      `select d.status, a.status as assignment_status, a.expires_at
         from delivery.delivery d
         join fleet.assignment a on a.delivery_id = d.id
        where d.id = $1`, [d]));

    assert.equal(rows[0].status, "ASSIGNED");
    assert.equal(rows[0].assignment_status, "OFFERED");
    assert.ok(rows[0].expires_at > new Date());
  });

  test("an OFFLINE rider is refused, and the reason says so", async () => {
    await online(riderB, false);
    const d = await admittedDelivery();
    const e = await refuses(() => as(dispatcherC, (db) =>
      db.query("select fleet.assign_delivery($1,$2)", [d, riderB])), /RIDER_UNAVAILABLE/);
    assert.match(e.message, /offline/);
  });

  test("a SUSPENDED rider is refused, with a different reason", async () => {
    await as(adminC, (db) =>
      db.query("select fleet.set_rider_status($1,'SUSPENDED','test')", [riderB]));
    const d = await admittedDelivery();
    const e = await refuses(() => as(dispatcherC, (db) =>
      db.query("select fleet.assign_delivery($1,$2)", [d, riderB])), /RIDER_UNAVAILABLE/);
    assert.match(e.message, /suspended/);
    await as(adminC, (db) =>
      db.query("select fleet.set_rider_status($1,'ACTIVE','test')", [riderB]));
  });

  test("a rider AT CAPACITY is refused", async () => {
    // Its own rider, with max_concurrent = 1, so this cannot depend on
    // what any other test left behind.
    const hash = await hashPassword("a-long-enough-password");
    const { rows: [one] } = await as(adminC, (db) =>
      db.query("select * from fleet.create_rider($1,$2,$3,$4,$5,'BIKE','SH1',1)",
        ["solo@p3.test", "Solo", "+91900", hash, "RDR-S"]));

    await online(one.rider_id, true);

    const first = await admittedDelivery();
    await as(dispatcherC, (db) =>
      db.query("select fleet.assign_delivery($1,$2)", [first, one.rider_id]));

    const second = await admittedDelivery();
    const e = await refuses(() => as(dispatcherC, (db) =>
      db.query("select fleet.assign_delivery($1,$2)", [second, one.rider_id])),
      /RIDER_UNAVAILABLE/);
    assert.match(e.message, /capacity/);
  });

  test("a delivery that is not admitted cannot be assigned", async () => {
    const orderId = `ORD-${randomUUID().slice(0, 8)}`;
    const r = await as(SYSTEM, async (db) => {
      const { rows } = await db.query(
        `select * from delivery.ingest_order($1,null,'SH1',$2::jsonb,$3::jsonb,'{}'::jsonb,
                                             null,null,null,'held',null)`,
        [orderId,
         JSON.stringify({ recipient_name: "A", phone: "1", line1: "L1",
                          city: "M", pincode: "400058", lat: 19.1, lng: 72.8 }),
         JSON.stringify([{ sku: "S", name: "T", quantity: 1 }])]);
      return rows[0];
    });

    await online(riderB, true);
    await refuses(() => as(dispatcherC, (db) =>
      db.query("select fleet.assign_delivery($1,$2)", [r.delivery_id, riderB])),
      /ILLEGAL_TRANSITION/);
  });

  test("FIVE CONCURRENT assigns of one delivery yield exactly ONE live assignment", async () => {
    // The partial unique index does this, not application luck. Two
    // riders at one door is not a bug you apologise your way out of.
    const hash = await hashPassword("a-long-enough-password");
    const ids = [];
    await as(adminC, async (db) => {
      for (let i = 0; i < 5; i += 1) {
        const { rows: [x] } = await db.query(
          "select * from fleet.create_rider($1,$2,$3,$4,$5,'BIKE','SH1',5)",
          [`race${i}@p3.test`, `Race ${i}`, "+91900", hash, `RDR-R${i}`]);
        ids.push(x.rider_id);
      }
    });
    for (const id of ids) await online(id, true);

    const d = await admittedDelivery();

    const results = await Promise.allSettled(
      ids.map((riderId) => as(dispatcherC, (db) =>
        db.query("select fleet.assign_delivery($1,$2)", [d, riderId]))));

    const ok = results.filter((r) => r.status === "fulfilled").length;
    assert.equal(ok, 1, "exactly one dispatcher may win");

    const { rows } = await raw((db) => db.query(
      `select count(*)::int n from fleet.assignment
        where delivery_id = $1 and status in ('OFFERED','ACCEPTED')`, [d]));
    assert.equal(rows[0].n, 1);
  });
});

// ───────────────────── accept and decline ─────────────────────

describe("accept and decline", () => {
  beforeEach(clearLoad);

  test("the named rider accepts", async () => {
    await online(riderB, true);
    const d = await admittedDelivery();
    await as(dispatcherC, (db) =>
      db.query("select fleet.assign_delivery($1,$2)", [d, riderB]));

    const { rows } = await as(riderBC, (db) =>
      db.query("select fleet.respond_to_assignment($1,true,null) as outcome", [d]));

    assert.equal(rows[0].outcome, "ACCEPTED");

    const { rows: after } = await raw((db) => db.query(
      "select status from delivery.delivery where id = $1", [d]));
    assert.equal(after[0].status, "ACCEPTED");
  });

  test("A DIFFERENT RIDER cannot accept it", async () => {
    // The check that matters. Holding deliveries:respond says "you are
    // a rider", not "you may accept this".
    const hash = await hashPassword("a-long-enough-password");
    const { rows: [x] } = await as(adminC, (db) =>
      db.query("select * from fleet.create_rider($1,$2,$3,$4,$5,'BIKE','SH1',3)",
        ["thief@p3.test", "Thief", "+91900", hash, "RDR-T"]));
    await raw((db) => db.query(
      "update identity.app_user set must_change_password=false where id=$1", [x.user_id]));
    const thiefC = await claimsFor(x.user_id);

    await online(riderA, true);
    const d = await admittedDelivery();

    // Give it to somebody with capacity.
    await online(x.rider_id, true);
    await as(dispatcherC, (db) =>
      db.query("select fleet.assign_delivery($1,$2)", [d, x.rider_id]));

    // riderA, who was not offered it, tries to take it.
    await refuses(() => as(riderAC, (db) =>
      db.query("select fleet.respond_to_assignment($1,true,null)", [d])),
      /NOT_YOUR_ASSIGNMENT/);

    // The real one still can.
    const { rows } = await as(thiefC, (db) =>
      db.query("select fleet.respond_to_assignment($1,true,null) as outcome", [d]));
    assert.equal(rows[0].outcome, "ACCEPTED");
  });

  test("declining requires a reason and returns it to the queue", async () => {
    await online(riderB, true);
    const d = await admittedDelivery();
    await as(dispatcherC, (db) =>
      db.query("select fleet.assign_delivery($1,$2)", [d, riderB]));

    await refuses(() => as(riderBC, (db) =>
      db.query("select fleet.respond_to_assignment($1,false,null)", [d])),
      /REASON_REQUIRED/);

    await as(riderBC, (db) =>
      db.query("select fleet.respond_to_assignment($1,false,$2)",
        [d, "too far from my area"]));

    const { rows } = await raw((db) => db.query(
      `select d.status, a.status as astatus, a.decline_reason
         from delivery.delivery d join fleet.assignment a on a.delivery_id = d.id
        where d.id = $1`, [d]));

    assert.equal(rows[0].status, "READY_FOR_ASSIGNMENT");
    assert.equal(rows[0].astatus, "DECLINED");
    assert.equal(rows[0].decline_reason, "too far from my area");
  });

  test("accepting twice is refused", async () => {
    await online(riderB, true);
    const d = await admittedDelivery();
    await as(dispatcherC, (db) =>
      db.query("select fleet.assign_delivery($1,$2)", [d, riderB]));
    await as(riderBC, (db) =>
      db.query("select fleet.respond_to_assignment($1,true,null)", [d]));

    await refuses(() => as(riderBC, (db) =>
      db.query("select fleet.respond_to_assignment($1,true,null)", [d])),
      /NO_LIVE_OFFER/);
  });

  test("an expired offer cannot be accepted", async () => {
    await online(riderA, true);
    const d = await admittedDelivery();
    await as(dispatcherC, (db) =>
      db.query("select fleet.assign_delivery($1,$2)", [d, riderA]));

    await raw((db) => db.query(
      "update fleet.assignment set expires_at = now() - interval '1 second' where delivery_id=$1",
      [d]));

    await refuses(() => as(riderAC, (db) =>
      db.query("select fleet.respond_to_assignment($1,true,null)", [d])),
      /OFFER_EXPIRED/);
  });

  test("a rider suspended between offer and answer cannot accept", async () => {
    await online(riderB, true);
    const d = await admittedDelivery();
    await as(dispatcherC, (db) =>
      db.query("select fleet.assign_delivery($1,$2)", [d, riderB]));

    await as(adminC, (db) =>
      db.query("select fleet.set_rider_status($1,'SUSPENDED','mid-offer')", [riderB]));

    await refuses(() => as(riderBC, (db) =>
      db.query("select fleet.respond_to_assignment($1,true,null)", [d])),
      /RIDER_NOT_ACTIVE/);

    await as(adminC, (db) =>
      db.query("select fleet.set_rider_status($1,'ACTIVE','test')", [riderB]));
  });
});

// ───────────────────── reassignment ─────────────────────

describe("reassignment", () => {
  beforeEach(clearLoad);

  test("moves the delivery and SUPERSEDES the first attempt", async () => {
    await online(riderA, true);
    await online(riderB, true);
    const d = await admittedDelivery();

    await as(dispatcherC, (db) =>
      db.query("select fleet.assign_delivery($1,$2)", [d, riderA]));
    await as(dispatcherC, (db) =>
      db.query("select fleet.reassign_delivery($1,$2,$3)",
        [d, riderB, "bike broke down"]));

    const { rows } = await raw((db) => db.query(
      `select a.status, a.decline_reason, a.superseded_by, r.code
         from fleet.assignment a join fleet.rider r on r.id = a.rider_id
        where a.delivery_id = $1 order by a.assigned_at`, [d]));

    assert.equal(rows.length, 2, "a new row, not an edit");
    assert.equal(rows[0].status, "SUPERSEDED");
    assert.equal(rows[0].code, "RDR-A");
    assert.ok(rows[0].superseded_by, "the old row points at the new one");
    assert.equal(rows[1].status, "OFFERED");
    assert.equal(rows[1].code, "RDR-B");
  });

  test("works from ACCEPTED too", async () => {
    await online(riderA, true);
    await online(riderB, true);
    const d = await admittedDelivery();

    await as(dispatcherC, (db) =>
      db.query("select fleet.assign_delivery($1,$2)", [d, riderA]));
    await as(riderAC, (db) =>
      db.query("select fleet.respond_to_assignment($1,true,null)", [d]));

    await as(dispatcherC, (db) =>
      db.query("select fleet.reassign_delivery($1,$2,$3)", [d, riderB, "customer rescheduled"]));

    const { rows } = await raw((db) => db.query(
      "select status from delivery.delivery where id=$1", [d]));
    assert.equal(rows[0].status, "ASSIGNED");
  });

  test("a reason is required", async () => {
    await online(riderA, true);
    await online(riderB, true);
    const d = await admittedDelivery();
    await as(dispatcherC, (db) =>
      db.query("select fleet.assign_delivery($1,$2)", [d, riderA]));

    await refuses(() => as(dispatcherC, (db) =>
      db.query("select fleet.reassign_delivery($1,$2,$3)", [d, riderB, "  "])),
      /REASON_REQUIRED/);
  });

  test("reassigning to the same rider is refused", async () => {
    await online(riderA, true);
    const d = await admittedDelivery();
    await as(dispatcherC, (db) =>
      db.query("select fleet.assign_delivery($1,$2)", [d, riderA]));

    await refuses(() => as(dispatcherC, (db) =>
      db.query("select fleet.reassign_delivery($1,$2,$3)", [d, riderA, "why"])),
      /SAME_RIDER/);
  });

  test("the timeline shows taken-back then given-out, not a silent swap", async () => {
    await online(riderA, true);
    await online(riderB, true);
    const d = await admittedDelivery();
    await as(dispatcherC, (db) =>
      db.query("select fleet.assign_delivery($1,$2)", [d, riderA]));
    await as(dispatcherC, (db) =>
      db.query("select fleet.reassign_delivery($1,$2,$3)", [d, riderB, "swap"]));

    const { rows } = await raw((db) => db.query(
      `select to_status, reason_code from delivery.delivery_status_history
        where delivery_id=$1 order by occurred_at, id`, [d]));

    const trail = rows.map((r) => `${r.to_status}:${r.reason_code}`);
    assert.ok(trail.includes("READY_FOR_ASSIGNMENT:reassigned"),
      `expected a reassigned step, got ${trail.join(" -> ")}`);
  });
});

// ───────────────────── the timeout sweep ─────────────────────

describe("offer timeout", () => {
  beforeEach(clearLoad);

  test("an unanswered offer goes back to the queue", async () => {
    await online(riderA, true);
    const d = await admittedDelivery();
    await as(dispatcherC, (db) =>
      db.query("select fleet.assign_delivery($1,$2)", [d, riderA]));

    await raw((db) => db.query(
      "update fleet.assignment set expires_at = now() - interval '1 minute' where delivery_id=$1",
      [d]));

    const { rows: [n] } = await as(SYSTEM, (db) =>
      db.query("select fleet.expire_assignments() as n"));
    assert.ok(Number(n.n) >= 1);

    const { rows } = await raw((db) => db.query(
      `select d.status, a.status as astatus
         from delivery.delivery d join fleet.assignment a on a.delivery_id=d.id
        where d.id=$1`, [d]));
    assert.equal(rows[0].status, "READY_FOR_ASSIGNMENT");
    assert.equal(rows[0].astatus, "EXPIRED");
  });

  test("the DRY RUN agrees with the real sweep", async () => {
    // It did not. The dry run selected from the tables directly, under
    // RLS, as a role holding no permissions — so it saw nothing and
    // reported "nothing to do" while the real sweep found work. A dry
    // run that disagrees with the real run is worse than none.
    await online(riderA, true);
    const d = await admittedDelivery();
    await as(dispatcherC, (db) =>
      db.query("select fleet.assign_delivery($1,$2)", [d, riderA]));

    await raw((db) => db.query(
      "update fleet.assignment set expires_at = now() - interval '1 minute' where delivery_id=$1",
      [d]));

    // Exactly what the script runs, claims and all.
    const listed = await as(SYSTEM, (db) =>
      db.query("select * from fleet.expiring_assignments()"));

    assert.ok(listed.rows.length >= 1, "the dry run must see what the sweep will do");
    assert.ok(listed.rows.some((r) => r.rider_code === "RDR-A"));

    const { rows: [n] } = await as(SYSTEM, (db) =>
      db.query("select fleet.expire_assignments() as n"));

    assert.equal(Number(n.n), listed.rows.length,
      "the sweep must return exactly what the dry run listed");
  });

  test("the sweep is idempotent", async () => {
    const { rows: [n] } = await as(SYSTEM, (db) =>
      db.query("select fleet.expire_assignments() as n"));
    assert.equal(Number(n.n), 0, "nothing left to expire");
  });

  test("an ACCEPTED offer is not swept", async () => {
    await online(riderB, true);
    const d = await admittedDelivery();
    await as(dispatcherC, (db) =>
      db.query("select fleet.assign_delivery($1,$2)", [d, riderB]));
    await as(riderBC, (db) =>
      db.query("select fleet.respond_to_assignment($1,true,null)", [d]));

    await raw((db) => db.query(
      "update fleet.assignment set expires_at = now() - interval '1 hour' where delivery_id=$1",
      [d]));

    await as(SYSTEM, (db) => db.query("select fleet.expire_assignments()"));

    const { rows } = await raw((db) => db.query(
      "select status from delivery.delivery where id=$1", [d]));
    assert.equal(rows[0].status, "ACCEPTED", "an accepted job is not an unanswered offer");
  });
});

// ───────────────────── visibility ─────────────────────

describe("rider visibility", () => {
  beforeEach(clearLoad);

  test("a rider sees the delivery they are carrying, and only that one", async () => {
    await online(riderA, true);
    const mine = await admittedDelivery();
    const notMine = await admittedDelivery();

    await as(dispatcherC, (db) =>
      db.query("select fleet.assign_delivery($1,$2)", [mine, riderA]));

    const { rows } = await as(riderAC, (db) =>
      db.query("select id from delivery.delivery"));

    const ids = rows.map((r) => r.id);
    assert.ok(ids.includes(mine), "they must see the parcel they are carrying");
    assert.ok(!ids.includes(notMine), "and nothing else");
  });

  test("a rider sees the address of their own delivery", async () => {
    // Self-contained: leaning on the previous test's assignment made
    // this pass for the wrong reason, and fail the moment the suite
    // started clearing rider load between tests.
    await online(riderA, true);
    const d = await admittedDelivery();
    await as(dispatcherC, (db) =>
      db.query("select fleet.assign_delivery($1,$2)", [d, riderA]));

    const { rows } = await as(riderAC, (db) =>
      db.query("select recipient_name, phone from delivery.delivery_address"));

    assert.equal(rows.length, 1, "they cannot deliver to an address they cannot read");
    assert.equal(rows[0].recipient_name, "A");
  });

  test("access ENDS when the assignment does", async () => {
    await online(riderB, true);
    const d = await admittedDelivery();
    await as(dispatcherC, (db) =>
      db.query("select fleet.assign_delivery($1,$2)", [d, riderB]));

    let { rows } = await as(riderBC, (db) =>
      db.query("select id from delivery.delivery where id=$1", [d]));
    assert.equal(rows.length, 1);

    await as(riderBC, (db) =>
      db.query("select fleet.respond_to_assignment($1,false,'changed my mind')", [d]));

    ({ rows } = await as(riderBC, (db) =>
      db.query("select id from delivery.delivery where id=$1", [d])));
    assert.equal(rows.length, 0,
      "the address is visible for as long as it is needed, and no longer");
  });

  test("a rider cannot assign anything", async () => {
    await online(riderA, true);
    const d = await admittedDelivery();
    await refuses(() => as(riderAC, (db) =>
      db.query("select fleet.assign_delivery($1,$2)", [d, riderA])), /FORBIDDEN/);
  });

  test("a rider still cannot read the audit log", async () => {
    const { rows } = await as(riderAC, (db) =>
      db.query("select * from ops.audit_log limit 5"));
    assert.equal(rows.length, 0);
  });
});
