import { test, before, beforeEach, after, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { as, raw, refuses, closePool, SYSTEM } from "./harness.mjs";
import { hashPassword } from "../lib/auth/password.ts";
import {
  createEvent, orderForSync, dedupe, nextBackoffMs, isStale,
  planSync, applyResults, isAwaitingSync,
} from "../lib/offline/outbox.ts";

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
      delete from identity.app_user where email like '%@p4b.test';
    `);
  });

  const hash = await hashPassword("a-long-enough-password");
  let adminId, dispatcherId;

  await as(SYSTEM, async (db) => {
    for (const [c, n] of [["SH1", "Shop 1"]]) {
      await db.query(
        "select integration.upsert_location_ref($1,null,$2,'STORE',null,null,'SEED')", [c, n]);
    }
    ({ rows: [{ id: adminId }] } = await db.query(
      "select identity.create_user($1,$2,'admin',$3,'{}',false) as id",
      ["admin@p4b.test", "Admin", hash]));
    ({ rows: [{ id: dispatcherId }] } = await db.query(
      "select identity.create_user($1,$2,'dispatcher',$3,'{}',false) as id",
      ["dispatch@p4b.test", "Dispatcher", hash]));
  });

  adminC = await claimsFor(adminId);
  dispatcherC = await claimsFor(dispatcherId);

  let aUser, bUser;
  await as(adminC, async (db) => {
    const { rows: [a] } = await db.query(
      "select * from fleet.create_rider($1,$2,$3,$4,$5,'BIKE','SH1',10)",
      ["a@p4b.test", "Rider A", "+91900001", hash, "RDR-BA"]);
    riderA = a.rider_id; aUser = a.user_id;
    const { rows: [b] } = await db.query(
      "select * from fleet.create_rider($1,$2,$3,$4,$5,'BIKE','SH1',10)",
      ["b@p4b.test", "Rider B", "+91900002", hash, "RDR-BB"]);
    riderB = b.rider_id; bUser = b.user_id;
  });

  await raw((db) => db.query(
    "update identity.app_user set must_change_password=false where email like '%@p4b.test'"));

  riderAC = await claimsFor(aUser);
  riderBC = await claimsFor(bUser);
});

after(async () => { await closePool(); });

async function claimsFor(id) {
  return raw(async (db) => {
    const { rows } = await db.query(
      `select u.id, u.role, u.location_codes, identity.permissions_for(u.role) as perms
         from identity.app_user u where u.id=$1`, [id]);
    const r = rows[0];
    return { sub: r.id, role: r.role, actor_kind: "USER",
             location_codes: r.location_codes, permissions: r.perms };
  });
}

async function clearLoad() {
  await raw((db) => db.query(
    `update fleet.assignment set status='COMPLETED' where status in ('OFFERED','ACCEPTED')`));
}

async function acceptedBy(riderId, riderClaims) {
  const orderId = `ORD-${randomUUID().slice(0, 8)}`;
  const r = await as(SYSTEM, async (db) => {
    const { rows } = await db.query(
      `select * from delivery.ingest_order($1,null,'SH1',$2::jsonb,$3::jsonb,'{}'::jsonb,
                                           null,null,null,'held',null)`,
      [orderId,
       JSON.stringify({ recipient_name: "A", phone: "1", line1: "L1",
                        city: "M", pincode: "400058", lat: 19.1, lng: 72.8 }),
       JSON.stringify([{ sku: "S1", name: "Thing", quantity: 1 }])]);
    return rows[0];
  });

  await as(adminC, (db) =>
    db.query("select delivery.transition($1,'READY_FOR_ASSIGNMENT','admitted',null)",
      [r.delivery_id]));
  await as(adminC, (db) =>
    db.query("select fleet.set_availability($1,true,'t')", [riderId]));
  await as(dispatcherC, (db) =>
    db.query("select fleet.assign_delivery($1,$2)", [r.delivery_id, riderId]));
  await as(riderClaims, (db) =>
    db.query("select fleet.respond_to_assignment($1,true,null)", [r.delivery_id]));

  return r.delivery_id;
}

/** Sync one captured event, the way the endpoint does. */
async function sync(claims, deliveryId, action, payload, capturedAt, eventId = randomUUID()) {
  const { rows: [r] } = await as(claims, (db) =>
    db.query("select integration.apply_rider_event($1,$2,$3,$4::jsonb,$5) as r",
      [eventId, deliveryId, action, JSON.stringify(payload),
       capturedAt ?? new Date().toISOString()]));
  return r.r;
}

// ═════════════════════ the pure outbox ═════════════════════

describe("outbox — ordering", () => {
  test("events replay in CAPTURE order, not the order they were queued", () => {
    const later = createEvent("complete", "d1", {}, 2, new Date("2026-09-12T14:30:00Z"));
    const earlier = createEvent("step", "d1", { to: "PICKED_UP" }, 1,
      new Date("2026-09-12T14:02:00Z"));

    const ordered = orderForSync([later, earlier]);
    assert.equal(ordered[0].action, "step");
    assert.equal(ordered[1].action, "complete");
  });

  test("the device sequence breaks a timestamp tie", () => {
    const when = new Date("2026-09-12T14:00:00Z");
    const second = createEvent("step", "d1", {}, 2, when);
    const first = createEvent("step", "d1", {}, 1, when);
    assert.deepEqual(orderForSync([second, first]).map((e) => e.seq), [1, 2]);
  });

  test("duplicates collapse, keeping the first", () => {
    const e = createEvent("step", "d1", {}, 1);
    assert.equal(dedupe([e, { ...e }, e]).length, 1);
  });
});

describe("outbox — retry and staleness", () => {
  test("backoff grows and is capped", () => {
    assert.ok(nextBackoffMs(1) < nextBackoffMs(3));
    assert.equal(nextBackoffMs(99), 5 * 60_000,
      "an hour-long backoff would strand a delivery finished in a tunnel");
  });

  test("older than the window is stale", () => {
    const old = createEvent("complete", "d1", {}, 1, new Date("2026-09-11T10:00:00Z"));
    const now = new Date("2026-09-12T15:00:00Z");
    assert.equal(isStale(old, now, 24), true);
    assert.equal(isStale(old, now, 48), false);
  });

  test("offline plans nothing", () => {
    const e = createEvent("step", "d1", {}, 1);
    assert.deepEqual(planSync([e], { online: false }), []);
  });

  test("a plan is capped so a backlog does not arrive as one huge request", () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      createEvent("location", "d1", {}, i, new Date(Date.now() - i * 1000)));
    assert.equal(planSync(many, { online: true, limit: 25 }).length, 25);
  });
});

describe("outbox — folding results back", () => {
  test("an APPLIED event leaves the outbox", () => {
    const e = createEvent("step", "d1", {}, 1);
    const { remaining, applied } = applyResults([e],
      [{ client_event_id: e.client_event_id, status: "APPLIED" }]);
    assert.equal(remaining.length, 0);
    assert.equal(applied, 1);
  });

  test("a NOOP leaves too — it already happened", () => {
    const e = createEvent("step", "d1", {}, 1);
    const { remaining } = applyResults([e],
      [{ client_event_id: e.client_event_id, status: "NOOP" }]);
    assert.equal(remaining.length, 0);
  });

  test("AN UNANSWERED EVENT STAYS", () => {
    // The rule that matters. A dropped event is a delivery nobody can
    // account for; a duplicate is a wasted request the server ignores.
    const e = createEvent("complete", "d1", { otp: "123456" }, 1);
    const { remaining } = applyResults([e], []);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].attempts, 1);
  });

  test("a CONFLICT leaves the outbox but is handed back to be told about", () => {
    const e = createEvent("complete", "d1", { otp: "123456" }, 1);
    const { remaining, conflicts } = applyResults([e], [{
      client_event_id: e.client_event_id,
      status: "CONFLICT", conflict_code: "ASSIGNMENT_SUPERSEDED",
    }]);

    assert.equal(remaining.length, 0, "retrying would not change the answer");
    assert.equal(conflicts.length, 1, "and the rider must still be told");
    assert.equal(conflicts[0].conflict_code, "ASSIGNMENT_SUPERSEDED");
  });

  test("a partial response keeps only what was not answered", () => {
    const a = createEvent("step", "d1", {}, 1);
    const b = createEvent("complete", "d1", {}, 2);
    const { remaining, applied } = applyResults([a, b],
      [{ client_event_id: a.client_event_id, status: "APPLIED" }]);
    assert.equal(applied, 1);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].client_event_id, b.client_event_id);
  });

  test("the screen knows a delivery is waiting to sync", () => {
    const e = createEvent("complete", "d1", {}, 1);
    assert.equal(isAwaitingSync([e], "d1"), true);
    assert.equal(isAwaitingSync([e], "d2"), false);
  });
});

// ═════════════════════ applying on the server ═════════════════════

describe("sync — idempotency", () => {
  beforeEach(clearLoad);

  test("the same event twice applies once", async () => {
    const d = await acceptedBy(riderA, riderAC);
    const id = randomUUID();

    const first = await sync(riderAC, d, "step", { to: "PICKUP_PENDING" }, null, id);
    const second = await sync(riderAC, d, "step", { to: "PICKUP_PENDING" }, null, id);

    assert.equal(first.status, "APPLIED");
    assert.equal(second.status, "APPLIED");
    assert.equal(second.replayed, true, "the second is recognised as a replay");

    const { rows } = await raw((db) => db.query(
      "select count(*)::int n from integration.rider_event where client_event_id=$1", [id]));
    assert.equal(rows[0].n, 1);
  });

  test("a replay returns the ORIGINAL outcome", async () => {
    const d = await acceptedBy(riderA, riderAC);
    const id = randomUUID();
    await sync(riderAC, d, "step", { to: "PICKUP_PENDING" }, null, id);
    const again = await sync(riderAC, d, "step", { to: "PICKUP_PENDING" }, null, id);
    assert.equal(again.status, "APPLIED");
  });
});

describe("sync — ordering", () => {
  beforeEach(clearLoad);

  test("an already-passed step is a NO-OP, not an error", async () => {
    const d = await acceptedBy(riderA, riderAC);
    await sync(riderAC, d, "step", { to: "PICKUP_PENDING" });
    await sync(riderAC, d, "step", { to: "PICKED_UP" });

    // A late-arriving earlier step.
    const late = await sync(riderAC, d, "step", { to: "PICKUP_PENDING" });
    assert.equal(late.status, "NOOP");
    assert.equal(late.delivery_status, "PICKED_UP", "and nothing moved backwards");
  });

  test("a full offline journey replays in capture order", async () => {
    const d = await acceptedBy(riderA, riderAC);
    const base = Date.now() - 60 * 60_000;

    const events = [
      { action: "step", payload: { to: "PICKUP_PENDING" }, at: base },
      { action: "step", payload: { to: "PICKED_UP" }, at: base + 60_000 },
      { action: "step", payload: { to: "OUT_FOR_DELIVERY" }, at: base + 120_000 },
      { action: "step", payload: { to: "ARRIVED" }, at: base + 600_000 },
    ].map((e, i) => createEvent(e.action, d, e.payload, i, new Date(e.at)));

    // Deliberately shuffled, as a badly drained queue would arrive.
    for (const e of orderForSync([events[3], events[0], events[2], events[1]])) {
      const r = await sync(riderAC, d, e.action, e.payload, e.captured_at, e.client_event_id);
      assert.notEqual(r.status, "CONFLICT", `${e.payload.to} should not conflict`);
    }

    const { rows } = await raw((db) => db.query(
      "select status from delivery.delivery where id=$1", [d]));
    assert.equal(rows[0].status, "ARRIVED");
  });
});

describe("sync — offline completion", () => {
  beforeEach(clearLoad);

  async function atTheDoor(riderId, claims) {
    const d = await acceptedBy(riderId, claims);
    for (const to of ["PICKUP_PENDING", "PICKED_UP", "OUT_FOR_DELIVERY", "ARRIVED"]) {
      await as(claims, (db) =>
        db.query("select delivery.rider_step($1,$2,'x',null)", [d, to]));
    }
    return d;
  }

  test("a good code applies, and delivered_at is the CAPTURE time", async () => {
    const d = await atTheDoor(riderA, riderAC);
    const code = await as(adminC, (db) =>
      db.query("select delivery.issue_otp($1) as c", [d]).then((r) => r.rows[0].c));

    // The assignment has to predate the capture, or the clamp will
    // (correctly) push the capture time forward to it. A real
    // 45-minute-old delivery was assigned more than 45 minutes ago.
    await raw((db) => db.query(
      "update fleet.assignment set assigned_at = now() - interval '2 hours' where delivery_id=$1",
      [d]));

    const captured = new Date(Date.now() - 45 * 60_000).toISOString();
    const r = await sync(riderAC, d, "complete", { otp: code }, captured);

    assert.equal(r.status, "APPLIED");

    const { rows } = await raw((db) => db.query(
      "select status, delivered_at from delivery.delivery where id=$1", [d]));
    assert.equal(rows[0].status, "DELIVERED");

    const drift = Math.abs(rows[0].delivered_at.getTime() - Date.parse(captured));
    assert.ok(drift < 2000,
      "recorded when the rider delivered it, not when the phone found signal");
  });

  test("a BAD code raises PROOF_DISPUTED and leaves it ARRIVED", async () => {
    const d = await atTheDoor(riderA, riderAC);
    await as(adminC, (db) => db.query("select delivery.issue_otp($1)", [d]));

    const r = await sync(riderAC, d, "complete", { otp: "000000" });

    assert.equal(r.status, "CONFLICT");
    assert.equal(r.conflict_code, "PROOF_DISPUTED");

    const { rows } = await raw((db) => db.query(
      "select status from delivery.delivery where id=$1", [d]));
    assert.equal(rows[0].status, "ARRIVED", "an unproven handover is not a delivery");

    const { rows: ex } = await raw((db) => db.query(
      `select severity from delivery.delivery_exception
        where delivery_id=$1 and code='PROOF_DISPUTED'`, [d]));
    assert.equal(ex[0].severity, "CRITICAL");
  });

  test("a completion enqueues the commit exactly as an online one does", async () => {
    const d = await atTheDoor(riderA, riderAC);
    const code = await as(adminC, (db) =>
      db.query("select delivery.issue_otp($1) as c", [d]).then((r) => r.rows[0].c));
    await sync(riderAC, d, "complete", { otp: code });

    const { rows } = await raw((db) => db.query(
      "select event from integration.outbound_event where delivery_id=$1", [d]));
    assert.equal(rows[0].event, "inventory.commit");
  });

  test("a backdated capture time is CLAMPED", async () => {
    // A device clock is a claim, not evidence. Unclamped, this would
    // let somebody backdate a delivery into an SLA window.
    const d = await atTheDoor(riderA, riderAC);
    const code = await as(adminC, (db) =>
      db.query("select delivery.issue_otp($1) as c", [d]).then((r) => r.rows[0].c));

    await sync(riderAC, d, "complete", { otp: code }, "2020-01-01T00:00:00Z");

    const { rows } = await raw((db) => db.query(
      "select delivered_at from delivery.delivery where id=$1", [d]));
    assert.ok(rows[0].delivered_at > new Date("2026-01-01"),
      "clamped to no earlier than the assignment");
  });

  test("a future capture time is clamped to now", async () => {
    const d = await atTheDoor(riderA, riderAC);
    const code = await as(adminC, (db) =>
      db.query("select delivery.issue_otp($1) as c", [d]).then((r) => r.rows[0].c));

    const future = new Date(Date.now() + 86_400_000).toISOString();
    await sync(riderAC, d, "complete", { otp: code }, future);

    const { rows } = await raw((db) => db.query(
      "select delivered_at from delivery.delivery where id=$1", [d]));
    assert.ok(rows[0].delivered_at <= new Date(Date.now() + 5000));
  });
});

// ═════════════════════ the conflicts ═════════════════════

describe("sync — conflicts", () => {
  beforeEach(clearLoad);

  async function atTheDoor(riderId, claims) {
    const d = await acceptedBy(riderId, claims);
    for (const to of ["PICKUP_PENDING", "PICKED_UP", "OUT_FOR_DELIVERY", "ARRIVED"]) {
      await as(claims, (db) =>
        db.query("select delivery.rider_step($1,$2,'x',null)", [d, to]));
    }
    return d;
  }

  test("C1 — reassigned while the rider was offline", async () => {
    const d = await acceptedBy(riderA, riderAC);
    await as(adminC, (db) => db.query("select fleet.set_availability($1,true,'t')", [riderB]));
    await as(dispatcherC, (db) =>
      db.query("select fleet.reassign_delivery($1,$2,$3)", [d, riderB, "no answer"]));

    const r = await sync(riderAC, d, "step", { to: "PICKED_UP" });

    assert.equal(r.status, "CONFLICT");
    assert.equal(r.conflict_code, "ASSIGNMENT_SUPERSEDED");
    assert.match(r.message, /do not hand it over again/);

    const { rows } = await raw((db) => db.query(
      `select severity from delivery.delivery_exception
        where delivery_id=$1 and code='ASSIGNMENT_SUPERSEDED'`, [d]));
    assert.equal(rows[0].severity, "CRITICAL");
  });

  test("C2 — already marked failed", async () => {
    const d = await atTheDoor(riderA, riderAC);
    const code = await as(adminC, (db) =>
      db.query("select delivery.issue_otp($1) as c", [d]).then((r) => r.rows[0].c));

    await as(dispatcherC, (db) =>
      db.query("select delivery.fail_delivery($1,'CUSTOMER_UNREACHABLE','no answer')", [d]));

    const r = await sync(riderAC, d, "complete", { otp: code });

    assert.equal(r.status, "CONFLICT");
    assert.equal(r.conflict_code, "CONFLICTING_OUTCOME");

    const { rows } = await raw((db) => db.query(
      "select status from delivery.delivery where id=$1", [d]));
    assert.equal(rows[0].status, "DELIVERY_FAILED",
      "two accounts of one doorstep — a person decides, not whoever synced last");
  });

  test("C3 — cancelled while the rider was offline", async () => {
    // Cancelled from ACCEPTED, which is the only place it can happen:
    // once a rider has PICKED_UP, the parcel is in their bag and the
    // way out is a return, not a cancellation. So the realistic
    // sequence is — rider accepts, goes offline, does the whole job;
    // meanwhile the customer rings and dispatch cancels.
    const d = await acceptedBy(riderA, riderAC);

    await as(adminC, (db) =>
      db.query("select delivery.transition($1,'CANCELLED','cancelled','customer rang')", [d]));

    const r = await sync(riderAC, d, "complete", { otp: "123456" });

    assert.equal(r.status, "CONFLICT");
    assert.equal(r.conflict_code, "DELIVERED_AFTER_CANCEL");

    const { rows } = await raw((db) => db.query(
      `select severity from delivery.delivery_exception
        where delivery_id=$1 and code='DELIVERED_AFTER_CANCEL'`, [d]));
    assert.equal(rows[0].severity, "CRITICAL",
      "something was handed to somebody; that cannot be silent");
  });

  test("C7 — a second device's stale outbox is harmless", async () => {
    const d = await acceptedBy(riderA, riderAC);
    const id = randomUUID();
    await sync(riderAC, d, "step", { to: "PICKUP_PENDING" }, null, id);

    const fromOtherPhone = await sync(riderAC, d, "step", { to: "PICKUP_PENDING" }, null, id);
    assert.equal(fromOtherPhone.replayed, true);
  });

  test("C8 — a very old event applies but is flagged STALE_SYNC", async () => {
    const d = await acceptedBy(riderA, riderAC);
    await raw((db) => db.query(
      "update fleet.assignment set assigned_at = now() - interval '3 days' where delivery_id=$1",
      [d]));

    const old = new Date(Date.now() - 48 * 3_600_000).toISOString();
    const r = await sync(riderAC, d, "step", { to: "PICKUP_PENDING" }, old);

    assert.equal(r.status, "APPLIED");
    assert.equal(r.stale, true);

    const { rows } = await raw((db) => db.query(
      `select code from delivery.delivery_exception
        where delivery_id=$1 and code='STALE_SYNC'`, [d]));
    assert.equal(rows.length, 1, "somebody should know this was reported two days late");
  });

  test("an illegal transition is a conflict, not a crash", async () => {
    const d = await acceptedBy(riderA, riderAC);
    const r = await sync(riderAC, d, "step", { to: "DELIVERED" });
    assert.equal(r.status, "CONFLICT");
    assert.equal(r.conflict_code, "ILLEGAL_TRANSITION");
  });

  test("a location outside the carrying window is a NO-OP, not a failure", async () => {
    // History, not an error. Refusing the whole sync over it would be
    // worse than recording nothing.
    const d = await acceptedBy(riderA, riderAC);
    const r = await sync(riderAC, d, "location", { lat: 19.1, lng: 72.8 });
    assert.equal(r.status, "NOOP");
  });
});

// ═════════════════════ ownership ═════════════════════

describe("sync — ownership", () => {
  beforeEach(clearLoad);

  test("another rider's event is REJECTED, not conflicted", async () => {
    // "Never yours" and "was yours until it moved" are different
    // facts, and conflating them would either hide a real handover or
    // accept a stranger's.
    const d = await acceptedBy(riderA, riderAC);
    const r = await sync(riderBC, d, "step", { to: "PICKUP_PENDING" });

    assert.equal(r.status, "REJECTED");
    assert.match(r.message, /never assigned to you/);
  });

  test("a non-rider cannot sync at all", async () => {
    const d = await acceptedBy(riderA, riderAC);
    const r = await sync(dispatcherC, d, "step", { to: "PICKUP_PENDING" });
    assert.equal(r.status, "REJECTED");
  });

  test("an unknown delivery is rejected", async () => {
    const r = await sync(riderAC, randomUUID(), "step", { to: "PICKED_UP" });
    assert.equal(r.status, "REJECTED");
  });
});

// ═════════════════════ what a person sees ═════════════════════

describe("conflicts are visible", () => {
  beforeEach(clearLoad);

  test("open_conflicts lists them for an operator", async () => {
    const d = await acceptedBy(riderA, riderAC);
    await as(adminC, (db) => db.query("select fleet.set_availability($1,true,'t')", [riderB]));
    await as(dispatcherC, (db) =>
      db.query("select fleet.reassign_delivery($1,$2,$3)", [d, riderB, "x"]));
    await sync(riderAC, d, "step", { to: "PICKED_UP" });

    // Through the definer function — reading the table under RLS as a
    // background role would show nothing, which has caught this
    // codebase three times already.
    const { rows } = await as(SYSTEM, (db) =>
      db.query("select * from integration.open_conflicts()"));

    assert.ok(rows.length >= 1);
    assert.equal(rows[0].conflict_code, "ASSIGNMENT_SUPERSEDED");
    assert.ok(rows[0].tracking_id);
    assert.ok(rows[0].rider_code);
  });

  test("a rider sees their own synced events and not another's", async () => {
    const d = await acceptedBy(riderA, riderAC);
    await sync(riderAC, d, "step", { to: "PICKUP_PENDING" });

    const { rows: mine } = await as(riderAC, (db) =>
      db.query("select id from integration.rider_event"));
    assert.ok(mine.length >= 1);

    const { rows: theirs } = await as(riderBC, (db) =>
      db.query("select id from integration.rider_event"));
    assert.equal(theirs.length, 0);
  });
});
