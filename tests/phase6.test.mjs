import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { as, raw, closePool, SYSTEM } from "./harness.mjs";
import { hashPassword } from "../lib/auth/password.ts";

/**
 * Phase 6 — the unhappy paths.
 *
 * The thing under test throughout is that **a person decided**, and
 * that the decision is as recorded as the problem was. A resolution
 * that leaves no trace of who, why, or what the original account said
 * is not a resolution; it is a deletion with better manners.
 */

let adminC, dispatcherC, riderC, riderBC, riderId, riderBId;

before(async () => {
  await raw(async (db) => {
    await db.query(`
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
      delete from identity.app_user where email like '%@p6.test';
    `);
  });

  const hash = await hashPassword("a-long-enough-password");
  let adminId, dispatcherId;

  await as(SYSTEM, async (db) => {
    await db.query(
      "select integration.upsert_location_ref('SH1',null,'Shop 1','STORE',null,null,'SEED')");
    ({ rows: [{ id: adminId }] } = await db.query(
      "select identity.create_user($1,$2,'admin',$3,'{}',false) as id",
      ["admin@p6.test", "Admin", hash]));
    ({ rows: [{ id: dispatcherId }] } = await db.query(
      "select identity.create_user($1,$2,'dispatcher',$3,'{}',false) as id",
      ["dispatch@p6.test", "Dispatcher", hash]));
  });

  adminC = await claimsFor(adminId);
  dispatcherC = await claimsFor(dispatcherId);

  let riderUser, riderBUser;
  await as(adminC, async (db) => {
    const { rows: [a] } = await db.query(
      "select * from fleet.create_rider($1,$2,$3,$4,$5,'BIKE','SH1',10)",
      ["asha@p6.test", "Asha Menon", "+91900006", hash, "RDR-P6A"]);
    riderId = a.rider_id; riderUser = a.user_id;
    const { rows: [b] } = await db.query(
      "select * from fleet.create_rider($1,$2,$3,$4,$5,'BIKE','SH1',10)",
      ["bo@p6.test", "Bo Lin", "+91900007", hash, "RDR-P6B"]);
    riderBId = b.rider_id; riderBUser = b.user_id;
  });

  await raw((db) => db.query(
    "update identity.app_user set must_change_password=false where email like '%@p6.test'"));

  riderC = await claimsFor(riderUser);
  riderBC = await claimsFor(riderBUser);
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

async function newDelivery() {
  const orderId = `ORD-${randomUUID().slice(0, 8)}`;
  const id = await as(SYSTEM, async (db) =>
    (await db.query(
      `select * from delivery.ingest_order($1,'CUST-6','SH1',$2::jsonb,$3::jsonb,'{}'::jsonb,
                                           null,null,null,'held',null)`,
      [orderId,
       JSON.stringify({ recipient_name: "R", phone: "1", line1: "L1",
                        city: "M", pincode: "400058", lat: 19.1, lng: 72.8 }),
       JSON.stringify([{ sku: "S1", name: "Thing", quantity: 1 }])])).rows[0].delivery_id);
  return { id, orderId };
}

async function accepted(who = riderC, whoId = riderId) {
  const { id, orderId } = await newDelivery();
  await raw((db) => db.query(
    "update fleet.assignment set status='COMPLETED' where status in ('OFFERED','ACCEPTED')"));
  await as(adminC, (db) =>
    db.query("select delivery.transition($1,'READY_FOR_ASSIGNMENT','admitted',null)", [id]));
  await as(adminC, (db) => db.query("select fleet.set_availability($1,true,'t')", [whoId]));
  await as(dispatcherC, (db) => db.query("select fleet.assign_delivery($1,$2)", [id, whoId]));
  await as(who, (db) => db.query("select fleet.respond_to_assignment($1,true,null)", [id]));
  return { id, orderId };
}

/** Walk to the door and fail there. The rider still has the parcel. */
async function failedAtDoor(reason = "CUSTOMER_UNREACHABLE") {
  const { id, orderId } = await accepted();
  for (const s of ["PICKUP_PENDING", "PICKED_UP", "OUT_FOR_DELIVERY", "ARRIVED"]) {
    await as(riderC, (db) =>
      db.query("select delivery.rider_step($1,$2,'step',null)", [id, s]));
  }
  await as(riderC, (db) =>
    db.query("select delivery.fail_delivery($1,$2,'nobody home')", [id, reason]));
  return { id, orderId };
}

const statusOf = (id) => raw(async (db) =>
  (await db.query("select status from delivery.delivery where id=$1", [id])).rows[0].status);

const releasesFor = (id) => raw(async (db) =>
  (await db.query(
    `select id, event, payload, event_key from integration.outbound_event
      where delivery_id=$1 and event='inventory.release' order by id`, [id])).rows);

const openFor = (id) => as(adminC, async (db) =>
  (await db.query("select * from delivery.exceptions_for($1)", [id])).rows);

// ═════════════════════ the return path ═════════════════════

describe("the return", () => {
  test("a dispatcher orders it, the rider walks it back", async () => {
    const { id } = await failedAtDoor();

    const r = await as(dispatcherC, async (db) =>
      (await db.query("select delivery.require_return($1,'customer moved away') as r",
        [id])).rows[0].r);
    assert.equal(r.status, "RETURN_REQUIRED");
    assert.equal(r.return_to, "SH1", "Q14: back to the shop it came from");

    await as(riderC, (db) =>
      db.query("select delivery.rider_step($1,'RETURN_IN_TRANSIT','carrying',null)", [id]));
    await as(riderC, (db) =>
      db.query("select delivery.rider_step($1,'RETURNED','handed back',null)", [id]));

    assert.equal(await statusOf(id), "RETURNED");
  });

  test("the release fires at RETURNED and NOT before", async () => {
    const { id } = await failedAtDoor();
    await as(dispatcherC, (db) => db.query("select delivery.require_return($1,null)", [id]));

    assert.equal((await releasesFor(id)).length, 0,
      "RETURN_REQUIRED means a dispatcher decided; the parcel is still in a bag");

    await as(riderC, (db) =>
      db.query("select delivery.rider_step($1,'RETURN_IN_TRANSIT','c',null)", [id]));
    assert.equal((await releasesFor(id)).length, 0, "still in the bag, on a bicycle");

    await as(riderC, (db) =>
      db.query("select delivery.rider_step($1,'RETURNED','back',null)", [id]));

    const rel = await releasesFor(id);
    assert.equal(rel.length, 1, "somebody confirmed it came back — now tell Inventory");
    assert.match(rel[0].payload.reason, /^returned:/);
  });

  test("a rider cannot skip straight to RETURNED", async () => {
    const { id } = await failedAtDoor();
    await as(dispatcherC, (db) => db.query("select delivery.require_return($1,null)", [id]));

    await assert.rejects(
      as(riderC, (db) => db.query("select delivery.rider_step($1,'RETURNED','x',null)", [id])),
      /ILLEGAL_TRANSITION/);
  });

  test("returning closes the assignment and frees the rider", async () => {
    const { id } = await failedAtDoor();
    await as(dispatcherC, (db) => db.query("select delivery.require_return($1,null)", [id]));
    for (const s of ["RETURN_IN_TRANSIT", "RETURNED"]) {
      await as(riderC, (db) => db.query("select delivery.rider_step($1,$2,'x',null)", [id, s]));
    }

    const live = await raw(async (db) =>
      (await db.query(
        `select count(*)::int n from fleet.assignment
          where delivery_id=$1 and status in ('OFFERED','ACCEPTED')`, [id])).rows[0].n);
    assert.equal(live, 0);
  });

  test("the parcel's holder is tracked and cleared", async () => {
    const { id } = await accepted();
    await as(riderC, (db) =>
      db.query("select delivery.rider_step($1,'PICKUP_PENDING','p',null)", [id]));

    let held = await raw(async (db) => (await db.query(
      "select parcel_with_rider_id from delivery.delivery where id=$1", [id]))
      .rows[0].parcel_with_rider_id);
    assert.equal(held, null, "still on the shelf");

    await as(riderC, (db) =>
      db.query("select delivery.rider_step($1,'PICKED_UP','p',null)", [id]));

    held = await raw(async (db) => (await db.query(
      "select parcel_with_rider_id from delivery.delivery where id=$1", [id]))
      .rows[0].parcel_with_rider_id);
    assert.equal(held, riderId, "in Asha's bag");

    for (const s of ["OUT_FOR_DELIVERY", "ARRIVED"]) {
      await as(riderC, (db) => db.query("select delivery.rider_step($1,$2,'s',null)", [id, s]));
    }
    const code = await as(adminC, async (db) =>
      (await db.query("select delivery.issue_otp($1) as c", [id])).rows[0].c);
    await as(riderC, (db) =>
      db.query("select delivery.complete_delivery($1,$2,null)", [id, code]));

    held = await raw(async (db) => (await db.query(
      "select parcel_with_rider_id from delivery.delivery where id=$1", [id]))
      .rows[0].parcel_with_rider_id);
    assert.equal(held, null, "handed over — no longer anybody's to carry");
  });

  test("release marks the delivery, and a failure raises a CRITICAL", async () => {
    const { id } = await failedAtDoor();
    await as(dispatcherC, (db) => db.query("select delivery.require_return($1,null)", [id]));
    for (const s of ["RETURN_IN_TRANSIT", "RETURNED"]) {
      await as(riderC, (db) => db.query("select delivery.rider_step($1,$2,'x',null)", [id, s]));
    }

    let rs = await raw(async (db) => (await db.query(
      "select release_status, returned_at from delivery.delivery where id=$1", [id])).rows[0]);
    assert.equal(rs.release_status, "pending");
    assert.ok(rs.returned_at);

    await as(SYSTEM, (db) => db.query(
      "select delivery.record_release_result($1,'failed','INVENTORY_RELEASE_UNVERIFIED',$2)",
      [id, "inventory says the stock was consumed"]));

    rs = await raw(async (db) => (await db.query(
      "select release_status from delivery.delivery where id=$1", [id])).rows[0]);
    assert.equal(rs.release_status, "failed");

    const x = (await openFor(id)).find((e) => e.code === "INVENTORY_RELEASE_UNVERIFIED");
    assert.ok(x, "stock on a shelf that the ledger has sold needs a person");
    assert.equal(x.severity, "CRITICAL");
  });

  test("the release is deduplicated by order, like the commit", async () => {
    const { id } = await failedAtDoor();
    await as(dispatcherC, (db) => db.query("select delivery.require_return($1,null)", [id]));
    for (const s of ["RETURN_IN_TRANSIT", "RETURNED"]) {
      await as(riderC, (db) => db.query("select delivery.rider_step($1,$2,'x',null)", [id, s]));
    }
    const [rel] = await releasesFor(id);
    await raw(async (db) => {
      await assert.rejects(
        db.query(`insert into integration.outbound_event (target,event,event_key,payload)
                  values ('INVENTORY','inventory.release',$1,'{}'::jsonb)`, [rel.event_key]),
        /duplicate key|unique/i);
    });
  });
});

// ═════════════════════ reschedule ═════════════════════

describe("reschedule", () => {
  test("the job goes back to the pool and the parcel does not", async () => {
    const { id } = await failedAtDoor();

    const r = await as(dispatcherC, async (db) =>
      (await db.query("select delivery.reschedule($1,'try tomorrow') as r", [id])).rows[0].r);

    assert.equal(r.status, "READY_FOR_ASSIGNMENT");
    assert.equal(r.parcel_with_rider_id, riderId,
      "the next rider collects it from Asha, not from a shelf with nothing on it");
  });

  test("it passes through RESCHEDULE_REQUIRED so the timeline shows the decision", async () => {
    const { id } = await failedAtDoor();
    await as(dispatcherC, (db) => db.query("select delivery.reschedule($1,'note')", [id]));

    const path = await as(adminC, async (db) =>
      (await db.query(
        `select to_status from delivery.delivery_status_history
          where delivery_id=$1 order by id`, [id])).rows.map((r) => r.to_status));

    assert.ok(path.includes("RESCHEDULE_REQUIRED"),
      "DELIVERY_FAILED cannot become READY_FOR_ASSIGNMENT directly, and the " +
      "intermediate state is the record that somebody chose to retry");
    assert.equal(path[path.length - 1], "READY_FOR_ASSIGNMENT");
  });

  test("the previous assignment is closed, or the rider stays at capacity", async () => {
    const { id } = await failedAtDoor();
    await as(dispatcherC, (db) => db.query("select delivery.reschedule($1,null)", [id]));

    const live = await raw(async (db) => (await db.query(
      `select count(*)::int n from fleet.assignment
        where delivery_id=$1 and status in ('OFFERED','ACCEPTED')`, [id])).rows[0].n);
    assert.equal(live, 0,
      "READY_FOR_ASSIGNMENT is not terminal, so 0008's trigger does not do this");
  });

  test("a rider cannot reschedule their own failed delivery", async () => {
    const { id } = await failedAtDoor();
    await assert.rejects(
      as(riderC, (db) => db.query("select delivery.reschedule($1,null)", [id])),
      /FORBIDDEN/);
  });

  test("a returned delivery cannot be rescheduled", async () => {
    const { id } = await failedAtDoor();
    await as(dispatcherC, (db) => db.query("select delivery.require_return($1,null)", [id]));
    for (const s of ["RETURN_IN_TRANSIT", "RETURNED"]) {
      await as(riderC, (db) => db.query("select delivery.rider_step($1,$2,'x',null)", [id, s]));
    }
    await assert.rejects(
      as(dispatcherC, (db) => db.query("select delivery.reschedule($1,null)", [id])),
      /ILLEGAL_TRANSITION/);
  });
});

// ═════════════════════ resolving an exception ═════════════════════

describe("resolving", () => {
  test("a resolution keeps the original account", async () => {
    const { id } = await failedAtDoor("ADDRESS_WRONG");
    const [x] = await openFor(id);

    await as(dispatcherC, (db) =>
      db.query("select delivery.resolve_exception($1,'ACKNOWLEDGED','rang the customer')",
        [x.id]));

    const [after] = (await openFor(id)).filter((e) => e.id === x.id);
    assert.equal(after.code, "ADDRESS_WRONG", "the problem is still on the record");
    assert.equal(after.note, "nobody home", "and so is what the rider said");
    assert.equal(after.resolution, "rang the customer");
    assert.equal(after.resolved_by_name, "Dispatcher");
    assert.ok(after.resolved_at);
  });

  test("resolving twice does not overwrite somebody else's reason", async () => {
    const { id } = await failedAtDoor();
    const [x] = await openFor(id);

    await as(dispatcherC, (db) =>
      db.query("select delivery.resolve_exception($1,'ACKNOWLEDGED','first')", [x.id]));
    const second = await as(adminC, async (db) =>
      (await db.query("select delivery.resolve_exception($1,'ACKNOWLEDGED','second') as r",
        [x.id])).rows[0].r);

    assert.equal(second, "ALREADY_RESOLVED");
    const [after] = (await openFor(id)).filter((e) => e.id === x.id);
    assert.equal(after.resolution, "first");
  });

  test("a rider cannot resolve anything", async () => {
    const { id } = await failedAtDoor();
    const [x] = await openFor(id);
    await assert.rejects(
      as(riderC, (db) =>
        db.query("select delivery.resolve_exception($1,'ACKNOWLEDGED','me')", [x.id])),
      /FORBIDDEN/);
  });

  test("a resolution code is required", async () => {
    const { id } = await failedAtDoor();
    const [x] = await openFor(id);
    await assert.rejects(
      as(dispatcherC, (db) => db.query("select delivery.resolve_exception($1,'  ',null)", [x.id])),
      /RESOLUTION_REQUIRED/);
  });

  test("the open queue is CRITICAL first, then oldest", async () => {
    const rows = await as(dispatcherC, async (db) =>
      (await db.query("select * from delivery.open_exceptions(200)")).rows);

    const sev = rows.map((r) => r.severity);
    const rank = { CRITICAL: 0, WARNING: 1, INFO: 2 };
    assert.deepEqual(sev.map((s) => rank[s]), [...sev.map((s) => rank[s])].sort((a, b) => a - b));
    for (const r of rows) assert.ok(r.tracking_id && r.age_minutes !== null);
  });

  test("the queue only shows what the dispatcher may act on", async () => {
    const blind = await as(riderC, async (db) =>
      (await db.query("select count(*)::int n from delivery.delivery_exception")).rows[0].n);
    const seen = await as(dispatcherC, async (db) =>
      (await db.query("select * from delivery.open_exceptions(200)")).rows);

    assert.equal(blind, 0, "a rider sees none, correctly");
    assert.ok(seen.length > 0,
      "and the definer function sees them — an empty screen must not mean both things");
  });
});

// ═════════════════════ Q30: deciding a conflict ═════════════════════

describe("conflicts", () => {
  /**
   * The Phase 4b scenario, end to end this time.
   *
   * Asha accepts and goes into a basement. Dispatch hears nothing,
   * takes the job back and gives it to Bo. Asha surfaces and syncs.
   */
  async function supersededConflict() {
    const { id } = await accepted(riderC, riderId);

    // Dispatch gives up on Asha and reassigns. ACCEPTED can go back
    // to READY_FOR_ASSIGNMENT; it cannot from PICKUP_PENDING, which
    // is the state machine correctly refusing to reassign a parcel
    // somebody is already walking to a shop to collect.
    await as(adminC, (db) => db.query("select fleet.set_availability($1,true,'t')", [riderBId]));
    await as(dispatcherC, (db) =>
      db.query("select delivery.transition($1,'READY_FOR_ASSIGNMENT','no response',null)", [id]));
    // SUPERSEDED, not COMPLETED: it is what actually happened, and it
    // is the status 0009 looks for when deciding that a rider's late
    // report is a conflict rather than an error.
    await raw((db) => db.query(
      `update fleet.assignment set status='SUPERSEDED'
        where delivery_id=$1 and rider_id=$2`, [id, riderId]));
    await as(dispatcherC, (db) => db.query("select fleet.assign_delivery($1,$2)", [id, riderBId]));
    await as(riderBC, (db) => db.query("select fleet.respond_to_assignment($1,true,null)", [id]));

    // Asha surfaces, still believing the job is hers.
    const r = await as(riderC, async (db) =>
      (await db.query(
        "select integration.apply_rider_event($1,$2,'step',$3::jsonb,$4) as r",
        [randomUUID(), id, JSON.stringify({ to: "PICKUP_PENDING" }),
         new Date().toISOString()])).rows[0].r);

    assert.equal(r.status, "CONFLICT", "setup: this must actually conflict");
    const [ev] = await as(adminC, async (db) =>
      (await db.query("select * from integration.open_conflicts()")).rows
        .filter((c) => c.delivery_id === id));
    return { id, eventId: ev.event_id };
  }

  test("DISCARD leaves the delivery alone and closes the conflict", async () => {
    const { id, eventId } = await supersededConflict();
    const before = await statusOf(id);

    const r = await as(dispatcherC, async (db) =>
      (await db.query("select integration.resolve_conflict($1,'DISCARD',null,$2) as r",
        [eventId, "spoke to both — Bo has the parcel"])).rows[0].r);

    assert.equal(r.decision, "DISCARD");
    assert.equal(r.moved_to, null);
    assert.equal(await statusOf(id), before);

    const still = await as(adminC, async (db) =>
      (await db.query("select * from integration.open_conflicts()")).rows
        .filter((c) => c.delivery_id === id && !c.resolved));
    assert.equal(still.length, 0);
  });

  test("ACCEPT moves the delivery to what the rider said", async () => {
    const { id, eventId } = await supersededConflict();

    const r = await as(dispatcherC, async (db) =>
      (await db.query("select integration.resolve_conflict($1,'ACCEPT',null,$2) as r",
        [eventId, "Asha did go for it; Bo never left the shop"])).rows[0].r);

    assert.equal(r.moved_to, "PICKUP_PENDING");
    assert.equal(await statusOf(id), "PICKUP_PENDING");
  });

  test("RECONCILE needs a named outcome", async () => {
    const { eventId } = await supersededConflict();
    await assert.rejects(
      as(dispatcherC, (db) =>
        db.query("select integration.resolve_conflict($1,'RECONCILE',null,'found out')",
          [eventId])),
      /TO_STATUS_REQUIRED/);
  });

  test("a decision still cannot make an illegal transition", async () => {
    const { eventId } = await supersededConflict();
    await assert.rejects(
      as(dispatcherC, (db) =>
        db.query("select integration.resolve_conflict($1,'RECONCILE','DELIVERED',$2)",
          [eventId, "claiming it arrived"])),
      /ILLEGAL_TRANSITION/,
      "a dispatcher may decide what happened; not that a parcel at the shop was delivered");
  });

  test("a note is not optional — it is the only record of why", async () => {
    const { eventId } = await supersededConflict();
    await assert.rejects(
      as(dispatcherC, (db) =>
        db.query("select integration.resolve_conflict($1,'DISCARD',null,'   ')", [eventId])),
      /NOTE_REQUIRED/);
  });

  test("a rider cannot decide a conflict they are party to", async () => {
    const { eventId } = await supersededConflict();
    await assert.rejects(
      as(riderC, (db) =>
        db.query("select integration.resolve_conflict($1,'ACCEPT',null,'I was right')",
          [eventId])),
      /FORBIDDEN/);
  });

  test("the decision is audited with both accounts", async () => {
    const { id, eventId } = await supersededConflict();
    await as(dispatcherC, (db) =>
      db.query("select integration.resolve_conflict($1,'DISCARD',null,$2)",
        [eventId, "Bo confirmed by phone"]));

    const [row] = await as(adminC, async (db) =>
      (await db.query(
        `select before, after, reason from ops.audit_log
          where action='conflict.resolved' and entity_id=$1 order by id desc limit 1`,
        [id])).rows);

    assert.equal(row.before.rider_said, "step");
    assert.equal(row.after.decision, "DISCARD");
    assert.equal(row.reason, "Bo confirmed by phone");
  });

  test("a conflict with NO exception can still be resolved", async () => {
    // The commonest class: 0009's generic handler labels it
    // ILLEGAL_TRANSITION and raises no delivery_exception at all.
    // Deciding "resolved" by looking for a resolved exception meant
    // these were listed as outstanding forever.
    const { id } = await accepted();
    await as(riderC, (db) =>
      db.query("select delivery.rider_step($1,'PICKUP_PENDING','p',null)", [id]));

    const r = await as(riderC, async (db) =>
      (await db.query("select integration.apply_rider_event($1,$2,'step',$3::jsonb,$4) as r",
        [randomUUID(), id, JSON.stringify({ to: "ARRIVED" }),
         new Date().toISOString()])).rows[0].r);
    assert.equal(r.status, "CONFLICT");
    assert.equal(r.conflict_code, "ILLEGAL_TRANSITION");

    const exceptions = await raw(async (db) => (await db.query(
      `select 1 from delivery.delivery_exception
        where delivery_id=$1 and code='ILLEGAL_TRANSITION'`, [id])).rows);
    assert.equal(exceptions.length, 0, "setup: this class raises none, and that is the point");

    const [ev] = await as(adminC, async (db) =>
      (await db.query("select * from integration.open_conflicts()")).rows
        .filter((c) => c.delivery_id === id));

    await as(dispatcherC, (db) =>
      db.query("select integration.resolve_conflict($1,'DISCARD',null,$2)",
        [ev.event_id, "phone replayed an old tap"]));

    const [after] = await as(adminC, async (db) =>
      (await db.query("select * from integration.open_conflicts()")).rows
        .filter((c) => c.delivery_id === id));
    assert.equal(after.resolved, true);
    assert.equal(after.resolution, "phone replayed an old tap");
  });

  test("resolving a conflict twice keeps the first decision", async () => {
    const { eventId } = await supersededConflict();
    await as(dispatcherC, (db) =>
      db.query("select integration.resolve_conflict($1,'DISCARD',null,'first')", [eventId]));

    const r = await as(adminC, async (db) =>
      (await db.query("select integration.resolve_conflict($1,'ACCEPT',null,'second') as r",
        [eventId])).rows[0].r);

    assert.equal(r.already_resolved, true);
    assert.equal(r.note, "first");
  });

  test("an unresolved conflict stays listed", async () => {
    const { id } = await supersededConflict();
    const open = await as(adminC, async (db) =>
      (await db.query("select * from integration.open_conflicts()")).rows
        .filter((c) => c.delivery_id === id && !c.resolved));
    assert.equal(open.length, 1);
  });
});

// ═════════════════════ §4.1: a disputed proof ═════════════════════

describe("a disputed proof", () => {
  /** Offline completion with a code the server rejects. */
  async function disputed() {
    const { id, orderId } = await accepted();
    for (const s of ["PICKUP_PENDING", "PICKED_UP", "OUT_FOR_DELIVERY", "ARRIVED"]) {
      await as(riderC, (db) => db.query("select delivery.rider_step($1,$2,'s',null)", [id, s]));
    }
    await as(adminC, (db) => db.query("select delivery.issue_otp($1)", [id]));

    const r = await as(riderC, async (db) =>
      (await db.query("select integration.apply_rider_event($1,$2,'complete',$3::jsonb,$4) as r",
        [randomUUID(), id, JSON.stringify({ otp: "000000" }),
         new Date().toISOString()])).rows[0].r);
    assert.equal(r.conflict_code, "PROOF_DISPUTED", "setup");
    return { id, orderId };
  }

  test("a dispatcher can record that it did arrive, and the commit is queued", async () => {
    const { id, orderId } = await disputed();

    await as(dispatcherC, (db) =>
      db.query("select delivery.resolve_disputed_proof($1,'DELIVERED',$2)",
        [id, "rang the customer; they had the parcel and misread a digit"]));

    assert.equal(await statusOf(id), "DELIVERED");

    const commits = await raw(async (db) => (await db.query(
      `select event_key from integration.outbound_event
        where delivery_id=$1 and event='inventory.commit'`, [id])).rows);
    assert.equal(commits.length, 1, `commit:${orderId} — otherwise the sale is never recorded`);
  });

  test("the proof is recorded as an OVERRIDE, not as a verified code", async () => {
    const { id } = await disputed();
    await as(dispatcherC, (db) =>
      db.query("select delivery.resolve_disputed_proof($1,'DELIVERED',$2)",
        [id, "customer confirmed by phone"]));

    const proofs = await as(adminC, async (db) =>
      (await db.query("select type, note from delivery.delivery_proof where delivery_id=$1",
        [id])).rows);

    assert.ok(proofs.some((p) => p.type === "OVERRIDE"));
    assert.ok(!proofs.some((p) => p.type === "OTP"),
      "recording a dispatcher's decision as a verified code would be a lie in the " +
      "one table whose job is to say what happened at a door");
    assert.match(proofs.find((p) => p.type === "OVERRIDE").note, /confirmed by phone/);
  });

  test("it can go the other way, and then no commit is queued", async () => {
    const { id } = await disputed();
    await as(dispatcherC, (db) =>
      db.query("select delivery.resolve_disputed_proof($1,'DELIVERY_FAILED',$2)",
        [id, "customer says nothing arrived; Asha agrees she left"]));

    assert.equal(await statusOf(id), "DELIVERY_FAILED");
    const commits = await raw(async (db) => (await db.query(
      `select 1 from integration.outbound_event
        where delivery_id=$1 and event='inventory.commit'`, [id])).rows);
    assert.equal(commits.length, 0, "nothing was handed over, so nothing was sold");
  });

  test("a note is mandatory in both directions", async () => {
    const { id } = await disputed();
    await assert.rejects(
      as(dispatcherC, (db) =>
        db.query("select delivery.resolve_disputed_proof($1,'DELIVERED','   ')", [id])),
      /NOTE_REQUIRED/);
  });

  test("only two outcomes, and a rider cannot choose either", async () => {
    const { id } = await disputed();
    await assert.rejects(
      as(dispatcherC, (db) =>
        db.query("select delivery.resolve_disputed_proof($1,'CANCELLED','x')", [id])),
      /BAD_OUTCOME/);
    await assert.rejects(
      as(riderC, (db) =>
        db.query("select delivery.resolve_disputed_proof($1,'DELIVERED','I did it')", [id])),
      /FORBIDDEN/);
  });

  test("the exception closes with the decision against it", async () => {
    const { id } = await disputed();
    await as(dispatcherC, (db) =>
      db.query("select delivery.resolve_disputed_proof($1,'DELIVERED',$2)",
        [id, "spoke to the customer"]));

    const x = (await openFor(id)).find((e) => e.code === "PROOF_DISPUTED");
    assert.ok(x.resolved_at);
    assert.equal(x.resolution_code, "DELIVERED");
    assert.equal(x.resolved_by_name, "Dispatcher");
  });
});

// ═════════════════════ the customer, and the offline return ═════════════════════

describe("the rest of the estate", () => {
  test("a return tells the customer, with the real reason in the timeline", async () => {
    const { id } = await failedAtDoor("ADDRESS_WRONG");
    await as(dispatcherC, (db) => db.query("select delivery.require_return($1,null)", [id]));
    for (const s of ["RETURN_IN_TRANSIT", "RETURNED"]) {
      await as(riderC, (db) => db.query("select delivery.rider_step($1,$2,'x',null)", [id, s]));
    }

    const last = await raw(async (db) => (await db.query(
      `select payload from integration.outbound_event
        where delivery_id=$1 and target='GROCERY' order by id desc limit 1`, [id])).rows[0]);

    assert.equal(last.payload.customer_status, "CANCELLED",
      "C-02: Grocery's CHECK has no RETURNED");
    assert.equal(last.payload.status, "RETURNED", "the truth travels alongside it");
  });

  test("the return leg is ranked, so a duplicate offline step is a NOOP not a conflict",
    async () => {
      const { id } = await failedAtDoor();
      await as(dispatcherC, (db) => db.query("select delivery.require_return($1,null)", [id]));
      await as(riderC, (db) =>
        db.query("select delivery.rider_step($1,'RETURN_IN_TRANSIT','c',null)", [id]));

      const r = await as(riderC, async (db) =>
        (await db.query("select integration.apply_rider_event($1,$2,'step',$3::jsonb,$4) as r",
          [randomUUID(), id, JSON.stringify({ to: "RETURN_IN_TRANSIT" }),
           new Date().toISOString()])).rows[0].r);

      assert.equal(r.status, "NOOP",
        "a phone sending the same thing twice is not two people disagreeing");
    });

  test("every status the return path uses is ranked", async () => {
    const ranks = await raw(async (db) => (await db.query(`
      select s, delivery.status_rank(s) as r
        from unnest(array['DELIVERY_FAILED','RESCHEDULE_REQUIRED','RETURN_REQUIRED',
                          'RETURN_IN_TRANSIT','RETURNED']) as s`)).rows);
    for (const row of ranks) {
      assert.notEqual(row.r, null, `${row.s} unranked — a replay would raise a false conflict`);
    }
  });

  test("a rider's position is still only recorded on the way TO a door", async () => {
    const { id } = await failedAtDoor();
    await as(dispatcherC, (db) => db.query("select delivery.require_return($1,null)", [id]));
    await as(riderC, (db) =>
      db.query("select delivery.rider_step($1,'RETURN_IN_TRANSIT','c',null)", [id]));

    await assert.rejects(
      as(riderC, (db) => db.query("select fleet.record_location($1,19.1,72.8,10)", [id])),
      /LOCATION_NOT_ACCEPTED/,
      "walking back to your own shop is not an occasion to track a named worker");
  });
});
