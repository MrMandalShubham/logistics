import { test, before, beforeEach, after, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { as, raw, refuses, closePool, SYSTEM } from "./harness.mjs";
import { hashPassword } from "../lib/auth/password.ts";
import { allowedNext, STATUSES, RIDER_STEP, isCarrying } from "../lib/delivery/states.ts";

let adminC, dispatcherC, riderAC, riderBC;
let riderA, riderB;

before(async () => {
  await raw(async (db) => {
    await db.query(`
      truncate integration.outbound_event restart identity cascade;
      truncate fleet.rider_location, fleet.assignment, fleet.rider_availability,
               fleet.rider restart identity cascade;
      truncate delivery.delivery, delivery.delivery_address, delivery.delivery_item,
               delivery.delivery_otp, delivery.delivery_proof,
               delivery.delivery_exception restart identity cascade;
      alter table delivery.delivery_status_history disable trigger delivery_history_no_delete;
      delete from delivery.delivery_status_history;
      alter table delivery.delivery_status_history enable trigger delivery_history_no_delete;
      delete from identity.app_user where email like '%@p4.test';
    `);
  });

  const hash = await hashPassword("a-long-enough-password");
  let adminId, dispatcherId;

  await as(SYSTEM, async (db) => {
    for (const [c, n] of [["SH1", "Shop 1"], ["SH2", "Shop 2"]]) {
      await db.query(
        "select integration.upsert_location_ref($1,null,$2,'STORE',null,null,'SEED')", [c, n]);
    }
    ({ rows: [{ id: adminId }] } = await db.query(
      "select identity.create_user($1,$2,'admin',$3,'{}',false) as id",
      ["admin@p4.test", "P4 Admin", hash]));
    ({ rows: [{ id: dispatcherId }] } = await db.query(
      "select identity.create_user($1,$2,'dispatcher',$3,'{}',false) as id",
      ["dispatch@p4.test", "P4 Dispatcher", hash]));
  });

  adminC = await claimsFor(adminId);
  dispatcherC = await claimsFor(dispatcherId);

  let aUser, bUser;
  await as(adminC, async (db) => {
    const { rows: [a] } = await db.query(
      "select * from fleet.create_rider($1,$2,$3,$4,$5,'BIKE','SH1',10)",
      ["rider-a@p4.test", "Rider A", "+919000000001", hash, "RDR-PA"]);
    riderA = a.rider_id; aUser = a.user_id;

    const { rows: [b] } = await db.query(
      "select * from fleet.create_rider($1,$2,$3,$4,$5,'BIKE','SH1',10)",
      ["rider-b@p4.test", "Rider B", "+919000000002", hash, "RDR-PB"]);
    riderB = b.rider_id; bUser = b.user_id;
  });

  await raw((db) => db.query(
    "update identity.app_user set must_change_password=false where email like '%@p4.test'"));

  riderAC = await claimsFor(aUser);
  riderBC = await claimsFor(bUser);
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

async function clearLoad() {
  await raw((db) => db.query(
    `update fleet.assignment set status='COMPLETED', responded_at=now()
      where status in ('OFFERED','ACCEPTED')`));
}

async function online(riderId, on = true) {
  return as(adminC, (db) =>
    db.query("select fleet.set_availability($1,$2,'test')", [riderId, on]));
}

/** A delivery accepted by a rider, ready to be executed. */
async function acceptedBy(riderId, riderClaims, location = "SH1") {
  const orderId = `ORD-${randomUUID().slice(0, 8)}`;

  const r = await as(SYSTEM, async (db) => {
    const { rows } = await db.query(
      `select * from delivery.ingest_order($1,null,$2,$3::jsonb,$4::jsonb,'{}'::jsonb,
                                           null,null,null,'held',null)`,
      [orderId, location,
       JSON.stringify({ recipient_name: "A. Sharma", phone: "+919876543210",
                        line1: "402 Sunview", city: "Mumbai", pincode: "400058",
                        lat: 19.12, lng: 72.85 }),
       JSON.stringify([{ sku: "SKU-1", name: "Rice", quantity: 1 }])]);
    return rows[0];
  });

  await as(adminC, (db) =>
    db.query("select delivery.transition($1,'READY_FOR_ASSIGNMENT','admitted',null)",
      [r.delivery_id]));
  await online(riderId, true);
  await as(dispatcherC, (db) =>
    db.query("select fleet.assign_delivery($1,$2)", [r.delivery_id, riderId]));
  await as(riderClaims, (db) =>
    db.query("select fleet.respond_to_assignment($1,true,null)", [r.delivery_id]));

  return { deliveryId: r.delivery_id, orderId };
}

/** Walk a rider from ACCEPTED to ARRIVED. */
async function walkToDoor(deliveryId, riderClaims) {
  for (const to of ["PICKUP_PENDING", "PICKED_UP", "OUT_FOR_DELIVERY", "ARRIVED"]) {
    await as(riderClaims, (db) =>
      db.query("select delivery.rider_step($1,$2,$3,null)",
        [deliveryId, to, to.toLowerCase()]));
  }
}

// ───────────────────── the state machine ─────────────────────

describe("state machine", () => {
  test("the TypeScript mirror still agrees with the database", async () => {
    for (const status of STATUSES) {
      const { rows } = await raw((db) => db.query(
        "select delivery.allowed_next($1) as next", [status]));
      assert.deepEqual([...rows[0].next].sort(), [...allowedNext(status)].sort(),
        `allowed_next('${status}') differs between SQL and states.ts`);
    }
  });

  test("DELIVERED is terminal", () => {
    assert.deepEqual(allowedNext("DELIVERED"), []);
  });

  test("location is only accepted while carrying", () => {
    assert.ok(isCarrying("PICKED_UP") && isCarrying("OUT_FOR_DELIVERY") && isCarrying("ARRIVED"));
    assert.ok(!isCarrying("ACCEPTED") && !isCarrying("DELIVERED"));
  });

  test("every rider step has a label", () => {
    for (const [from, step] of Object.entries(RIDER_STEP)) {
      assert.ok(step.label, `${from} needs a label a rider can read`);
      assert.ok(allowedNext(from).includes(step.to),
        `${from} -> ${step.to} must be a legal transition`);
    }
  });
});

// ───────────────────── the happy path ─────────────────────

describe("the happy path", () => {
  beforeEach(clearLoad);

  test("accepted through to delivered", async () => {
    const { deliveryId } = await acceptedBy(riderA, riderAC);
    await walkToDoor(deliveryId, riderAC);

    const code = await as(adminC, (db) =>
      db.query("select delivery.issue_otp($1) as c", [deliveryId]).then((r) => r.rows[0].c));

    const { rows: [res] } = await as(riderAC, (db) =>
      db.query("select delivery.complete_delivery($1,$2,null) as r", [deliveryId, code]));

    assert.equal(res.r.ok, true);

    const { rows } = await raw((db) => db.query(
      "select status, commit_status, delivered_at from delivery.delivery where id=$1",
      [deliveryId]));
    assert.equal(rows[0].status, "DELIVERED");
    assert.equal(rows[0].commit_status, "pending");
    assert.ok(rows[0].delivered_at);
  });

  test("the timeline records every step", async () => {
    const { deliveryId } = await acceptedBy(riderA, riderAC);
    await walkToDoor(deliveryId, riderAC);

    const { rows } = await raw((db) => db.query(
      `select to_status from delivery.delivery_status_history
        where delivery_id=$1 order by occurred_at, id`, [deliveryId]));

    const trail = rows.map((r) => r.to_status);
    for (const s of ["RECEIVED", "READY_FOR_ASSIGNMENT", "ASSIGNED", "ACCEPTED",
                     "PICKUP_PENDING", "PICKED_UP", "OUT_FOR_DELIVERY", "ARRIVED"]) {
      assert.ok(trail.includes(s), `${s} missing from ${trail.join(" -> ")}`);
    }
  });

  test("an OTP proof row is written", async () => {
    const { deliveryId } = await acceptedBy(riderA, riderAC);
    await walkToDoor(deliveryId, riderAC);
    const code = await as(adminC, (db) =>
      db.query("select delivery.issue_otp($1) as c", [deliveryId]).then((r) => r.rows[0].c));
    await as(riderAC, (db) =>
      db.query("select delivery.complete_delivery($1,$2,null)", [deliveryId, code]));

    const { rows } = await raw((db) => db.query(
      "select type from delivery.delivery_proof where delivery_id=$1", [deliveryId]));
    assert.ok(rows.some((r) => r.type === "OTP"));
  });

  test("a photo reference is stored when one is supplied", async () => {
    const { deliveryId } = await acceptedBy(riderA, riderAC);
    await walkToDoor(deliveryId, riderAC);
    const code = await as(adminC, (db) =>
      db.query("select delivery.issue_otp($1) as c", [deliveryId]).then((r) => r.rows[0].c));
    await as(riderAC, (db) =>
      db.query("select delivery.complete_delivery($1,$2,$3)",
        [deliveryId, code, "pod/2026/09/x.jpg"]));

    const { rows } = await raw((db) => db.query(
      "select storage_ref from delivery.delivery_proof where delivery_id=$1 and type='PHOTO'",
      [deliveryId]));
    assert.equal(rows[0].storage_ref, "pod/2026/09/x.jpg");
  });
});

// ───────────────────── ownership ─────────────────────

describe("ownership", () => {
  beforeEach(clearLoad);

  test("ANOTHER RIDER cannot step my delivery", async () => {
    const { deliveryId } = await acceptedBy(riderA, riderAC);
    await refuses(() => as(riderBC, (db) =>
      db.query("select delivery.rider_step($1,'PICKUP_PENDING','x',null)", [deliveryId])),
      /NOT_YOUR_ASSIGNMENT/);
  });

  test("ANOTHER RIDER cannot complete my delivery", async () => {
    const { deliveryId } = await acceptedBy(riderA, riderAC);
    await walkToDoor(deliveryId, riderAC);
    const code = await as(adminC, (db) =>
      db.query("select delivery.issue_otp($1) as c", [deliveryId]).then((r) => r.rows[0].c));

    // Even holding the correct code.
    await refuses(() => as(riderBC, (db) =>
      db.query("select delivery.complete_delivery($1,$2,null)", [deliveryId, code])),
      /NOT_YOUR_ASSIGNMENT/);
  });

  test("ANOTHER RIDER cannot fail my delivery", async () => {
    const { deliveryId } = await acceptedBy(riderA, riderAC);
    await refuses(() => as(riderBC, (db) =>
      db.query("select delivery.fail_delivery($1,'OTHER','x')", [deliveryId])),
      /NOT_YOUR_ASSIGNMENT/);
  });

  test("ANOTHER RIDER cannot post a location for my delivery", async () => {
    const { deliveryId } = await acceptedBy(riderA, riderAC);
    await as(riderAC, (db) =>
      db.query("select delivery.rider_step($1,'PICKUP_PENDING','x',null)", [deliveryId]));
    await as(riderAC, (db) =>
      db.query("select delivery.rider_step($1,'PICKED_UP','x',null)", [deliveryId]));

    await refuses(() => as(riderBC, (db) =>
      db.query("select fleet.record_location($1,19.1,72.8,5)", [deliveryId])),
      /NOT_YOUR_ASSIGNMENT/);
  });

  test("staff with deliveries:assign CAN act for a rider", async () => {
    // Somebody has to be able to unstick a delivery when a phone dies.
    const { deliveryId } = await acceptedBy(riderA, riderAC);
    await as(dispatcherC, (db) =>
      db.query("select delivery.rider_step($1,'PICKUP_PENDING','x',null)", [deliveryId]));

    const { rows } = await raw((db) => db.query(
      "select status from delivery.delivery where id=$1", [deliveryId]));
    assert.equal(rows[0].status, "PICKUP_PENDING");
  });
});

// ───────────────────── the OTP ─────────────────────

describe("the OTP", () => {
  beforeEach(clearLoad);

  test("A RIDER CANNOT ISSUE ONE", async () => {
    // The single most important restriction in this phase. A code the
    // rider can read is a code they can use without meeting anybody.
    const { deliveryId } = await acceptedBy(riderA, riderAC);
    await refuses(() => as(riderAC, (db) =>
      db.query("select delivery.issue_otp($1)", [deliveryId])), /FORBIDDEN/);
  });

  test("a rider cannot call mint_otp either", async () => {
    // issue_otp checks the role; mint_otp is protected by a REVOKE.
    // Postgres grants EXECUTE to PUBLIC by default, so revoking from
    // `authenticated` alone would have left this open.
    const { deliveryId } = await acceptedBy(riderA, riderAC);
    await refuses(() => as(riderAC, (db) =>
      db.query("select delivery.mint_otp($1)", [deliveryId])), /permission denied/i);
  });

  test("arriving mints one without returning it", async () => {
    const { deliveryId } = await acceptedBy(riderA, riderAC);
    await walkToDoor(deliveryId, riderAC);

    const { rows } = await raw((db) => db.query(
      "select code_hash, consumed_at from delivery.delivery_otp where delivery_id=$1",
      [deliveryId]));
    assert.ok(rows[0].code_hash, "a code exists");
    assert.equal(rows[0].consumed_at, null);
  });

  test("the wrong code is refused and counts an attempt", async () => {
    const { deliveryId } = await acceptedBy(riderA, riderAC);
    await walkToDoor(deliveryId, riderAC);

    const { rows: [r] } = await as(riderAC, (db) =>
      db.query("select delivery.complete_delivery($1,'000000',null) as r", [deliveryId]));

    assert.equal(r.r.ok, false);
    assert.equal(r.r.code, "OTP_WRONG");
    assert.equal(r.r.attempts_left, 4);

    const { rows } = await raw((db) => db.query(
      "select status from delivery.delivery where id=$1", [deliveryId]));
    assert.equal(rows[0].status, "ARRIVED", "a wrong code must not deliver it");
  });

  test("five wrong codes lock it", async () => {
    const { deliveryId } = await acceptedBy(riderA, riderAC);
    await walkToDoor(deliveryId, riderAC);

    for (let i = 0; i < 5; i += 1) {
      await as(riderAC, (db) =>
        db.query("select delivery.complete_delivery($1,'000000',null)", [deliveryId]));
    }

    const { rows: [r] } = await as(riderAC, (db) =>
      db.query("select delivery.complete_delivery($1,'000000',null) as r", [deliveryId]));
    assert.equal(r.r.code, "OTP_LOCKED");
  });

  test("an expired code is refused", async () => {
    const { deliveryId } = await acceptedBy(riderA, riderAC);
    await walkToDoor(deliveryId, riderAC);
    const code = await as(adminC, (db) =>
      db.query("select delivery.issue_otp($1) as c", [deliveryId]).then((r) => r.rows[0].c));

    await raw((db) => db.query(
      "update delivery.delivery_otp set expires_at = now() - interval '1 second' where delivery_id=$1",
      [deliveryId]));

    const { rows: [r] } = await as(riderAC, (db) =>
      db.query("select delivery.complete_delivery($1,$2,null) as r", [deliveryId, code]));
    assert.equal(r.r.code, "OTP_EXPIRED");
  });

  test("a code is single use", async () => {
    const { deliveryId } = await acceptedBy(riderA, riderAC);
    await walkToDoor(deliveryId, riderAC);
    const code = await as(adminC, (db) =>
      db.query("select delivery.issue_otp($1) as c", [deliveryId]).then((r) => r.rows[0].c));

    await as(riderAC, (db) =>
      db.query("select delivery.complete_delivery($1,$2,null)", [deliveryId, code]));

    const { rows: [r] } = await as(adminC, (db) =>
      db.query("select delivery.verify_otp($1,$2) as r", [deliveryId, code]));
    assert.equal(r.r.code, "OTP_USED");
  });

  test("re-issuing rotates the code", async () => {
    const { deliveryId } = await acceptedBy(riderA, riderAC);
    await walkToDoor(deliveryId, riderAC);

    const first = await as(adminC, (db) =>
      db.query("select delivery.issue_otp($1) as c", [deliveryId]).then((r) => r.rows[0].c));
    const second = await as(adminC, (db) =>
      db.query("select delivery.issue_otp($1) as c", [deliveryId]).then((r) => r.rows[0].c));

    const { rows: [old] } = await as(adminC, (db) =>
      db.query("select delivery.verify_otp($1,$2) as r", [deliveryId, first]));
    assert.equal(old.r.ok, false, "the old code must stop working");

    const { rows: [now] } = await as(adminC, (db) =>
      db.query("select delivery.verify_otp($1,$2) as r", [deliveryId, second]));
    assert.equal(now.r.ok, true);
  });

  test("a code from another delivery is refused", async () => {
    const one = await acceptedBy(riderA, riderAC);
    const two = await acceptedBy(riderB, riderBC);
    await walkToDoor(one.deliveryId, riderAC);
    await walkToDoor(two.deliveryId, riderBC);

    const codeTwo = await as(adminC, (db) =>
      db.query("select delivery.issue_otp($1) as c", [two.deliveryId]).then((r) => r.rows[0].c));

    const { rows: [r] } = await as(riderAC, (db) =>
      db.query("select delivery.complete_delivery($1,$2,null) as r",
        [one.deliveryId, codeTwo]));
    assert.equal(r.r.ok, false);
  });
});

// ───────────────────── the commit ─────────────────────

describe("the commit to Inventory", () => {
  beforeEach(clearLoad);

  async function deliver(riderId, riderClaims) {
    const { deliveryId, orderId } = await acceptedBy(riderId, riderClaims);
    await walkToDoor(deliveryId, riderClaims);
    const code = await as(adminC, (db) =>
      db.query("select delivery.issue_otp($1) as c", [deliveryId]).then((r) => r.rows[0].c));
    await as(riderClaims, (db) =>
      db.query("select delivery.complete_delivery($1,$2,null)", [deliveryId, code]));
    return { deliveryId, orderId };
  }

  test("delivering enqueues exactly one commit", async () => {
    const { deliveryId, orderId } = await deliver(riderA, riderAC);

    const { rows } = await raw((db) => db.query(
      `select target, event, event_key, status, payload
         from integration.outbound_event where delivery_id=$1`, [deliveryId]));

    assert.equal(rows.length, 1);
    assert.equal(rows[0].target, "INVENTORY");
    assert.equal(rows[0].event, "inventory.commit");
    assert.equal(rows[0].event_key, `commit:${orderId}`);
    assert.equal(rows[0].payload.order_id, orderId);
  });

  test("the queue deduplicates by event key", async () => {
    const { orderId } = await deliver(riderA, riderAC);

    // A second enqueue of the same business event must collapse.
    await as(SYSTEM, (db) => db.query(
      `select integration.enqueue_outbound('INVENTORY','inventory.commit',
         $1::jsonb, $2, null)`,
      [JSON.stringify({ order_id: orderId }), `commit:${orderId}`]));

    const { rows } = await raw((db) => db.query(
      "select count(*)::int n from integration.outbound_event where event_key=$1",
      [`commit:${orderId}`]));
    assert.equal(rows[0].n, 1);
  });

  test("claiming marks it SENDING so a crash is distinguishable", async () => {
    await deliver(riderA, riderAC);

    const { rows } = await as(SYSTEM, (db) =>
      db.query("select * from integration.claim_outbound_batch(10,'t')"));
    assert.ok(rows.length >= 1);

    const { rows: after } = await raw((db) => db.query(
      "select status, claimed_by from integration.outbound_event where id=$1", [rows[0].id]));
    assert.equal(after[0].status, "SENDING");
    assert.equal(after[0].claimed_by, "t");
  });

  test("a fatal failure goes straight to DEAD, skipping retries", async () => {
    await deliver(riderA, riderAC);
    const { rows } = await as(SYSTEM, (db) =>
      db.query("select * from integration.claim_outbound_batch(10,'t')"));

    const { rows: [s] } = await as(SYSTEM, (db) => db.query(
      "select integration.record_outbound_result($1,false,$2,null,true) as s",
      [rows[0].id, "INVENTORY_HOLD_LOST: the stock was never reduced"]));

    assert.equal(s.s, "DEAD", "retrying a released hold could never help");
  });

  test("a retryable failure backs off rather than dying", async () => {
    await deliver(riderA, riderAC);
    const { rows } = await as(SYSTEM, (db) =>
      db.query("select * from integration.claim_outbound_batch(10,'t')"));

    const { rows: [s] } = await as(SYSTEM, (db) => db.query(
      "select integration.record_outbound_result($1,false,$2,null,false) as s",
      [rows[0].id, "timeout"]));

    assert.equal(s.s, "PENDING");

    const { rows: e } = await raw((db) => db.query(
      "select attempts, next_attempt_at > now() as backed_off from integration.outbound_event where id=$1",
      [rows[0].id]));
    assert.equal(e[0].attempts, 1);
    assert.equal(e[0].backed_off, true);
  });

  test("a stuck SENDING row is reclaimed by age", async () => {
    await deliver(riderA, riderAC);
    const { rows } = await as(SYSTEM, (db) =>
      db.query("select * from integration.claim_outbound_batch(10,'dead-worker')"));

    await raw((db) => db.query(
      "update integration.outbound_event set claimed_at = now() - interval '10 minutes' where id=$1",
      [rows[0].id]));

    const { rows: [n] } = await as(SYSTEM, (db) =>
      db.query("select integration.requeue_stuck_outbound() as n"));
    assert.ok(Number(n.n) >= 1);
  });

  test("writing the commit result directly does NOT work", async () => {
    // The first version of the worker did both of these directly and
    // they failed in two different ways:
    //
    //   UPDATE delivery.delivery       -> no UPDATE policy, so zero
    //                                     rows matched and it reported
    //                                     success. Silent.
    //   INSERT delivery_exception      -> no INSERT policy, so a WITH
    //                                     CHECK violation. Loud.
    //
    // The silent one is the dangerous half: commit_status would have
    // stayed 'pending' forever with nothing to indicate why. Both go
    // through record_commit_result now.
    const { deliveryId } = await deliver(riderA, riderAC);

    const res = await as(SYSTEM, (db) =>
      db.query("update delivery.delivery set commit_status='verified' where id=$1",
        [deliveryId]));
    assert.equal(res.rowCount, 0, "the direct UPDATE matches nothing, silently");

    const { rows } = await raw((db) => db.query(
      "select commit_status from delivery.delivery where id=$1", [deliveryId]));
    assert.equal(rows[0].commit_status, "pending", "so nothing changed");

    await refuses(() => as(SYSTEM, (db) =>
      db.query(`insert into delivery.delivery_exception (delivery_id, code)
                values ($1,'X')`, [deliveryId])), /row-level security|violates/i);
  });

  test("record_commit_result is the way, and is system-only", async () => {
    const { deliveryId } = await deliver(riderA, riderAC);

    await as(SYSTEM, (db) => db.query(
      "select delivery.record_commit_result($1,'verified',$2::jsonb,null,null)",
      [deliveryId, JSON.stringify([99001])]));

    const { rows } = await raw((db) => db.query(
      "select commit_status, commit_ledger_ids from delivery.delivery where id=$1",
      [deliveryId]));
    assert.equal(rows[0].commit_status, "verified");
    assert.deepEqual(rows[0].commit_ledger_ids, [99001]);

    await refuses(() => as(riderAC, (db) =>
      db.query("select delivery.record_commit_result($1,'verified',null,null,null)",
        [deliveryId])), /FORBIDDEN_ROLE/);
  });

  test("a failed commit raises a CRITICAL exception", async () => {
    const { deliveryId } = await deliver(riderA, riderAC);

    await as(SYSTEM, (db) => db.query(
      "select delivery.record_commit_result($1,'failed',null,$2,$3)",
      [deliveryId, "INVENTORY_HOLD_LOST", "the stock was never reduced"]));

    const { rows } = await raw((db) => db.query(
      `select code, severity from delivery.delivery_exception
        where delivery_id=$1 and code='INVENTORY_HOLD_LOST'`, [deliveryId]));
    assert.equal(rows[0].severity, "CRITICAL",
      "a stock discrepancy is not a queue statistic");
  });

  test("the operator view agrees with the worker", async () => {
    // Same bug class as the Phase 3 dry run: reading the queue table
    // directly under RLS showed an empty queue while rows were stuck.
    await deliver(riderA, riderAC);

    const listed = await as(SYSTEM, (db) =>
      db.query("select * from integration.pending_outbound()"));
    assert.ok(listed.rows.length >= 1, "what is queued must be visible to the operator view");

    const claimed = await as(SYSTEM, (db) =>
      db.query("select * from integration.claim_outbound_batch(50,'t')"));
    assert.ok(claimed.rows.length >= 1, "and the worker must see the same thing");
  });

  test("a rider cannot drain the queue", async () => {
    await refuses(() => as(riderAC, (db) =>
      db.query("select * from integration.claim_outbound_batch(10,'sneaky')")),
      /FORBIDDEN_ROLE|permission denied/i);
  });

  test("a FAILED delivery does not enqueue a commit", async () => {
    const { deliveryId } = await acceptedBy(riderA, riderAC);
    await walkToDoor(deliveryId, riderAC);
    await as(riderAC, (db) =>
      db.query("select delivery.fail_delivery($1,'CUSTOMER_UNREACHABLE','nobody home')",
        [deliveryId]));

    const { rows } = await raw((db) => db.query(
      "select count(*)::int n from integration.outbound_event where delivery_id=$1",
      [deliveryId]));
    assert.equal(rows[0].n, 0, "nothing was handed over, so nothing was sold");
  });
});

// ───────────────────── failure paths ─────────────────────

describe("failed delivery", () => {
  beforeEach(clearLoad);

  test("a reason is required", async () => {
    const { deliveryId } = await acceptedBy(riderA, riderAC);
    await walkToDoor(deliveryId, riderAC);
    await refuses(() => as(riderAC, (db) =>
      db.query("select delivery.fail_delivery($1,'',null)", [deliveryId])),
      /REASON_REQUIRED/);
  });

  test("failing raises an exception record", async () => {
    const { deliveryId } = await acceptedBy(riderA, riderAC);
    await walkToDoor(deliveryId, riderAC);
    await as(riderAC, (db) =>
      db.query("select delivery.fail_delivery($1,'ADDRESS_WRONG','flat does not exist')",
        [deliveryId]));

    const { rows } = await raw((db) => db.query(
      "select code, note from delivery.delivery_exception where delivery_id=$1", [deliveryId]));
    assert.equal(rows[0].code, "ADDRESS_WRONG");
    assert.equal(rows[0].note, "flat does not exist");
  });

  test("THE ASSIGNMENT STAYS LIVE — the rider still has the parcel", async () => {
    const { deliveryId } = await acceptedBy(riderA, riderAC);
    await walkToDoor(deliveryId, riderAC);
    await as(riderAC, (db) =>
      db.query("select delivery.fail_delivery($1,'CUSTOMER_UNREACHABLE',null)", [deliveryId]));

    const { rows } = await raw((db) => db.query(
      "select status from fleet.assignment where delivery_id=$1", [deliveryId]));
    assert.equal(rows[0].status, "ACCEPTED",
      "a failure is not a terminal state; somebody still has to bring it back");
  });

  test("a failure can become a reschedule or a return", async () => {
    const { deliveryId } = await acceptedBy(riderA, riderAC);
    await walkToDoor(deliveryId, riderAC);
    await as(riderAC, (db) =>
      db.query("select delivery.fail_delivery($1,'CUSTOMER_UNREACHABLE',null)", [deliveryId]));

    assert.deepEqual(allowedNext("DELIVERY_FAILED").sort(),
      ["RESCHEDULE_REQUIRED", "RETURN_REQUIRED"]);

    await as(dispatcherC, (db) =>
      db.query("select delivery.transition($1,'RESCHEDULE_REQUIRED','retry_tomorrow',null)",
        [deliveryId]));

    const { rows } = await raw((db) => db.query(
      "select status from delivery.delivery where id=$1", [deliveryId]));
    assert.equal(rows[0].status, "RESCHEDULE_REQUIRED");
  });
});

// ───────────────────── location ─────────────────────

describe("rider location", () => {
  beforeEach(clearLoad);

  test("REFUSED before pickup", async () => {
    const { deliveryId } = await acceptedBy(riderA, riderAC);
    await refuses(() => as(riderAC, (db) =>
      db.query("select fleet.record_location($1,19.1,72.8,5)", [deliveryId])),
      /LOCATION_NOT_ACCEPTED/);
  });

  test("accepted while carrying", async () => {
    const { deliveryId } = await acceptedBy(riderA, riderAC);
    await as(riderAC, (db) =>
      db.query("select delivery.rider_step($1,'PICKUP_PENDING','x',null)", [deliveryId]));
    await as(riderAC, (db) =>
      db.query("select delivery.rider_step($1,'PICKED_UP','x',null)", [deliveryId]));

    await as(riderAC, (db) =>
      db.query("select fleet.record_location($1,19.12,72.85,8.5)", [deliveryId]));

    const { rows } = await raw((db) => db.query(
      "select lat, lng, accuracy_m from fleet.rider_location where delivery_id=$1", [deliveryId]));
    assert.equal(Number(rows[0].lat), 19.12);
    assert.equal(Number(rows[0].accuracy_m), 8.5);
  });

  test("REFUSED once delivered", async () => {
    const { deliveryId } = await acceptedBy(riderA, riderAC);
    await walkToDoor(deliveryId, riderAC);
    const code = await as(adminC, (db) =>
      db.query("select delivery.issue_otp($1) as c", [deliveryId]).then((r) => r.rows[0].c));
    await as(riderAC, (db) =>
      db.query("select delivery.complete_delivery($1,$2,null)", [deliveryId, code]));

    await refuses(() => as(riderAC, (db) =>
      db.query("select fleet.record_location($1,19.1,72.8,5)", [deliveryId])),
      /LOCATION_NOT_ACCEPTED|NOT_YOUR_ASSIGNMENT/);
  });
});

// ───────────────────── Q25: closing the assignment ─────────────────────

describe("assignment closure", () => {
  beforeEach(clearLoad);

  test("DELIVERED closes it and frees the rider", async () => {
    const { deliveryId } = await acceptedBy(riderA, riderAC);
    await walkToDoor(deliveryId, riderAC);

    const before = await raw((db) => db.query(
      "select active_count from fleet.rider_current where id=$1", [riderA]));
    assert.ok(before.rows[0].active_count >= 1);

    const code = await as(adminC, (db) =>
      db.query("select delivery.issue_otp($1) as c", [deliveryId]).then((r) => r.rows[0].c));
    await as(riderAC, (db) =>
      db.query("select delivery.complete_delivery($1,$2,null)", [deliveryId, code]));

    const { rows } = await raw((db) => db.query(
      "select status from fleet.assignment where delivery_id=$1", [deliveryId]));
    assert.equal(rows[0].status, "COMPLETED");

    const after = await raw((db) => db.query(
      "select active_count from fleet.rider_current where id=$1", [riderA]));
    assert.equal(after.rows[0].active_count, before.rows[0].active_count - 1);
  });

  test("CANCELLED closes it too", async () => {
    const { deliveryId } = await acceptedBy(riderA, riderAC);
    await as(adminC, (db) =>
      db.query("select delivery.transition($1,'CANCELLED','cancelled','test')", [deliveryId]));

    const { rows } = await raw((db) => db.query(
      "select status from fleet.assignment where delivery_id=$1", [deliveryId]));
    assert.equal(rows[0].status, "COMPLETED");
  });

  test("it is a TRIGGER, so a direct transition closes it too", async () => {
    // The whole point of Q25 option B: no future phase can forget to
    // call a cleanup function, because nothing calls it.
    const { deliveryId } = await acceptedBy(riderB, riderBC);
    await raw((db) => db.query(
      "update delivery.delivery set status='RETURNED' where id=$1", [deliveryId]));

    const { rows } = await raw((db) => db.query(
      "select status from fleet.assignment where delivery_id=$1", [deliveryId]));
    assert.equal(rows[0].status, "COMPLETED");
  });
});

// ───────────────────── visibility ─────────────────────

describe("proof visibility", () => {
  beforeEach(clearLoad);

  test("nobody can read the OTP table, not even an admin", async () => {
    // Refused at the privilege level, before row-level security is
    // even consulted: the policy returns no rows AND the grant is
    // revoked. Two independent reasons, so a policy mistake in a later
    // migration still cannot expose a code hash.
    await refuses(() => as(adminC, (db) =>
      db.query("select * from delivery.delivery_otp")), /permission denied/i);
  });

  test("proof needs the permission", async () => {
    const { deliveryId } = await acceptedBy(riderA, riderAC);
    await walkToDoor(deliveryId, riderAC);
    const code = await as(adminC, (db) =>
      db.query("select delivery.issue_otp($1) as c", [deliveryId]).then((r) => r.rows[0].c));
    await as(riderAC, (db) =>
      db.query("select delivery.complete_delivery($1,$2,null)", [deliveryId, code]));

    const { rows: asAdmin } = await as(adminC, (db) =>
      db.query("select id from delivery.delivery_proof where delivery_id=$1", [deliveryId]));
    assert.ok(asAdmin.length >= 1);

    const { rows: asRider } = await as(riderBC, (db) =>
      db.query("select id from delivery.delivery_proof where delivery_id=$1", [deliveryId]));
    assert.equal(asRider.length, 0);
  });

  test("a rider cannot read the outbound queue", async () => {
    const { rows } = await as(riderAC, (db) =>
      db.query("select id from integration.outbound_event"));
    assert.equal(rows.length, 0);
  });
});
