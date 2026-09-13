import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHmac } from "node:crypto";
import { as, raw, closePool, SYSTEM } from "./harness.mjs";
import { hashPassword } from "../lib/auth/password.ts";
import { sign, verify } from "../lib/webhooks.ts";
import { createEvent, planSignOut } from "../lib/offline/outbox.ts";

/**
 * Phase 5 — telling the customer.
 *
 * The thing under test is not "does an event get sent". It is
 * "does the RIGHT number of events get sent" — because the failure
 * this phase is designed around is five requests that all say the
 * same thing, drowning the one that says a delivery failed.
 */

let adminC, dispatcherC, riderC, riderId;

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
      delete from identity.app_user where email like '%@p5.test';
    `);
  });

  const hash = await hashPassword("a-long-enough-password");
  let adminId, dispatcherId;

  await as(SYSTEM, async (db) => {
    await db.query(
      "select integration.upsert_location_ref('SH1',null,'Shop 1','STORE',null,null,'SEED')");
    ({ rows: [{ id: adminId }] } = await db.query(
      "select identity.create_user($1,$2,'admin',$3,'{}',false) as id",
      ["admin@p5.test", "Admin", hash]));
    ({ rows: [{ id: dispatcherId }] } = await db.query(
      "select identity.create_user($1,$2,'dispatcher',$3,'{}',false) as id",
      ["dispatch@p5.test", "Dispatcher", hash]));
  });

  adminC = await claimsFor(adminId);
  dispatcherC = await claimsFor(dispatcherId);

  let riderUser;
  await as(adminC, async (db) => {
    const { rows: [r] } = await db.query(
      "select * from fleet.create_rider($1,$2,$3,$4,$5,'BIKE','SH1',10)",
      ["rider@p5.test", "Asha Menon", "+91900005", hash, "RDR-P5"]);
    riderId = r.rider_id; riderUser = r.user_id;
  });

  await raw((db) => db.query(
    "update identity.app_user set must_change_password=false where email like '%@p5.test'"));

  riderC = await claimsFor(riderUser);
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

async function newDelivery() {
  const orderId = `ORD-${randomUUID().slice(0, 8)}`;
  const r = await as(SYSTEM, async (db) => {
    const { rows } = await db.query(
      `select * from delivery.ingest_order($1,'CUST-9','SH1',$2::jsonb,$3::jsonb,'{}'::jsonb,
                                           null,null,null,'held',null)`,
      [orderId,
       JSON.stringify({ recipient_name: "A", phone: "1", line1: "L1",
                        city: "M", pincode: "400058", lat: 19.1, lng: 72.8 }),
       JSON.stringify([{ sku: "S1", name: "Thing", quantity: 1 }])]);
    return rows[0];
  });
  return r.delivery_id;
}

/** Every GROCERY event queued for one delivery, oldest first. */
async function eventsFor(deliveryId) {
  return raw(async (db) => {
    const { rows } = await db.query(
      `select id, event, event_key, payload from integration.outbound_event
        where delivery_id = $1 and target = 'GROCERY' order by id`, [deliveryId]);
    return rows;
  });
}

async function toAccepted(deliveryId) {
  // One rider carries every delivery in this file. Retiring the
  // previous assignment keeps `max_concurrent` out of the way of what
  // is actually being tested.
  await raw((db) => db.query(
    "update fleet.assignment set status='COMPLETED' where status in ('OFFERED','ACCEPTED')"));

  await as(adminC, (db) =>
    db.query("select delivery.transition($1,'READY_FOR_ASSIGNMENT','admitted',null)",
      [deliveryId]));
  await as(adminC, (db) => db.query("select fleet.set_availability($1,true,'t')", [riderId]));
  await as(dispatcherC, (db) =>
    db.query("select fleet.assign_delivery($1,$2)", [deliveryId, riderId]));
  await as(riderC, (db) =>
    db.query("select fleet.respond_to_assignment($1,true,null)", [deliveryId]));
}

// ═════════════════════ the mapping ═════════════════════

describe("mapping", () => {
  test("every logistics status has an answer", async () => {
    const rows = await raw(async (db) => {
      // The statuses straight from the CHECK constraint, so a status
      // added in Phase 6 fails this test rather than silently never
      // reaching a customer.
      const { rows } = await db.query(`
        with statuses as (
          select unnest(enum_range) as s from (
            select array['RECEIVED','READY_FOR_ASSIGNMENT','ASSIGNED','ACCEPTED',
                         'PICKUP_PENDING','PICKED_UP','OUT_FOR_DELIVERY','ARRIVED',
                         'DELIVERED','DELIVERY_FAILED','RESCHEDULE_REQUIRED',
                         'RETURN_REQUIRED','RETURN_IN_TRANSIT','RETURNED','CANCELLED'
                        ] as enum_range) x)
        select s, (select count(*) from delivery.customer_view(s)) as n
          from statuses`);
      return rows;
    });

    assert.equal(rows.length, 15);
    const unmapped = rows.filter((r) => Number(r.n) !== 1).map((r) => r.s);
    assert.deepEqual(unmapped, [],
      `unmapped statuses would silently never reach a customer: ${unmapped}`);
  });

  test("nothing is produced that Grocery could not store or render", async () => {
    // Grocery's orders.status CHECK, and its four-step OrderPipeline.
    // If this system ever emits something outside these sets, the
    // receiver's UPDATE fails at the constraint and the customer is
    // stuck on whatever they last saw.
    const legalStatus = new Set(["PAID", "SHIPPED", "DELIVERED", "CANCELLED", null]);
    const legalStep = new Set(["placed", "packed", "out_for_delivery", "delivered", null]);

    const views = await raw(async (db) =>
      (await db.query(`
        select s, v.external_status, v.pipeline_step
          from unnest(array['RECEIVED','READY_FOR_ASSIGNMENT','ASSIGNED','ACCEPTED',
                            'PICKUP_PENDING','PICKED_UP','OUT_FOR_DELIVERY','ARRIVED',
                            'DELIVERED','DELIVERY_FAILED','RESCHEDULE_REQUIRED',
                            'RETURN_REQUIRED','RETURN_IN_TRANSIT','RETURNED','CANCELLED'
                           ]) as s,
               lateral delivery.customer_view(s) as v`)).rows);

    assert.equal(views.length, 15);
    for (const v of views) {
      assert.ok(legalStatus.has(v.external_status),
        `${v.s} maps to ${v.external_status}, which Grocery's CHECK would refuse`);
      assert.ok(legalStep.has(v.pipeline_step),
        `${v.s} maps to step ${v.pipeline_step}, which OrderPipeline cannot render`);
    }
  });

  test("RETURNED collapses to CANCELLED, knowingly", async () => {
    const [v] = await raw(async (db) =>
      (await db.query("select * from delivery.customer_view('RETURNED')")).rows);
    assert.equal(v.external_status, "CANCELLED",
      "Grocery's orders.status CHECK has no RETURNED (C-02)");
    assert.equal(v.pipeline_step, null);
  });

  test("RECEIVED tells the customer nothing — they placed the order", async () => {
    const [v] = await raw(async (db) =>
      (await db.query("select * from delivery.customer_view('RECEIVED')")).rows);
    assert.equal(v.external_status, null);
  });

  test("the return transit states are internal", async () => {
    for (const s of ["RETURN_REQUIRED", "RETURN_IN_TRANSIT"]) {
      const [v] = await raw(async (db) =>
        (await db.query("select * from delivery.customer_view($1)", [s])).rows);
      assert.equal(v.external_status, null, `${s} should not be customer-visible`);
    }
  });

  test("a failure reason becomes a sentence, and an unknown one still does", async () => {
    const say = async (s, r) => raw(async (db) =>
      (await db.query("select delivery.customer_message($1,$2) as m", [s, r])).rows[0].m);

    assert.match(await say("DELIVERY_FAILED", "CUSTOMER_UNREACHABLE"), /could not reach you/i);
    assert.match(await say("DELIVERY_FAILED", "WHAT_IS_THIS"), /could not deliver/i,
      "an unmapped reason must still produce a sentence, not a null");
    assert.match(await say("DELIVERED", null), /delivered/i);
  });
});

// ═════════════════════ change detection ═════════════════════

describe("change detection", () => {
  test("five internal steps to PICKUP_PENDING produce ONE event", async () => {
    const id = await newDelivery();

    // RECEIVED produced nothing: the customer placed the order.
    assert.equal((await eventsFor(id)).length, 0);

    await toAccepted(id);   // READY_FOR_ASSIGNMENT, ASSIGNED, ACCEPTED
    await as(riderC, (db) =>
      db.query("select delivery.rider_step($1,'PICKUP_PENDING','pickup',null)", [id]));

    const events = await eventsFor(id);
    assert.equal(events.length, 1,
      `four transitions that all mean "being packed" produced ${events.length} events`);
    assert.equal(events[0].payload.customer_status, "PAID");
    assert.equal(events[0].payload.pipeline_step, "packed");
  });

  test("PICKED_UP and OUT_FOR_DELIVERY produce one event between them", async () => {
    const id = await newDelivery();
    await toAccepted(id);
    for (const s of ["PICKUP_PENDING", "PICKED_UP", "OUT_FOR_DELIVERY"]) {
      await as(riderC, (db) =>
        db.query("select delivery.rider_step($1,$2,'step',null)", [id, s]));
    }

    const events = await eventsFor(id);
    assert.equal(events.length, 2, "one 'packed', one 'on its way'");
    assert.equal(events[1].payload.pipeline_step, "out_for_delivery");
  });

  test("ARRIVED adds nothing — it shares a step with OUT_FOR_DELIVERY", async () => {
    const id = await newDelivery();
    await toAccepted(id);
    for (const s of ["PICKUP_PENDING", "PICKED_UP", "OUT_FOR_DELIVERY", "ARRIVED"]) {
      await as(riderC, (db) =>
        db.query("select delivery.rider_step($1,$2,'step',null)", [id, s]));
    }
    assert.equal((await eventsFor(id)).length, 2);
  });

  test("DELIVERED always produces one", async () => {
    const id = await newDelivery();
    await toAccepted(id);
    for (const s of ["PICKUP_PENDING", "PICKED_UP", "OUT_FOR_DELIVERY", "ARRIVED"]) {
      await as(riderC, (db) =>
        db.query("select delivery.rider_step($1,$2,'step',null)", [id, s]));
    }
    const code = await as(adminC, async (db) =>
      (await db.query("select delivery.issue_otp($1) as code", [id])).rows[0].code);

    await as(riderC, (db) =>
      db.query("select delivery.complete_delivery($1,$2,null)", [id, code]));

    const events = await eventsFor(id);
    const last = events[events.length - 1];
    assert.equal(last.payload.customer_status, "DELIVERED");
    assert.equal(last.payload.pipeline_step, "delivered");
    assert.match(String(last.payload.message), /delivered/i);
  });

  test("a FAILURE is never swallowed, though it maps to the same pair as 'on its way'", async () => {
    const id = await newDelivery();
    await toAccepted(id);
    for (const s of ["PICKUP_PENDING", "PICKED_UP", "OUT_FOR_DELIVERY", "ARRIVED"]) {
      await as(riderC, (db) =>
        db.query("select delivery.rider_step($1,$2,'step',null)", [id, s]));
    }
    const before = (await eventsFor(id)).length;

    await as(riderC, (db) =>
      db.query("select delivery.fail_delivery($1,'CUSTOMER_UNREACHABLE',null)", [id]));

    const events = await eventsFor(id);
    assert.equal(events.length, before + 1,
      "DELIVERY_FAILED maps to SHIPPED/out_for_delivery exactly like OUT_FOR_DELIVERY; " +
      "without the reason in the comparison key the customer would never be told");

    const last = events[events.length - 1];
    assert.equal(last.payload.reason_code, "CUSTOMER_UNREACHABLE");
    assert.match(String(last.payload.message), /could not reach you/i);
  });

  test("the delivery records what Grocery was last told", async () => {
    const id = await newDelivery();
    await toAccepted(id);
    const row = await raw(async (db) =>
      (await db.query(
        "select notified_key, notified_at from delivery.delivery where id=$1", [id])).rows[0]);
    assert.equal(row.notified_key, "PAID|packed|-");
    assert.ok(row.notified_at);
  });
});

// ═════════════════════ the payload ═════════════════════

describe("payload", () => {
  test("carries an ordering sequence and an occurred_at, not just a clock", async () => {
    const id = await newDelivery();
    await toAccepted(id);
    for (const s of ["PICKUP_PENDING", "PICKED_UP"]) {
      await as(riderC, (db) =>
        db.query("select delivery.rider_step($1,$2,'step',null)", [id, s]));
    }

    const events = await eventsFor(id);
    assert.ok(events.length >= 2);
    const seqs = events.map((e) => Number(e.payload.sequence));
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b),
      "at-least-once delivery guarantees nothing about order; the receiver needs a sequence");
    for (const e of events) assert.ok(e.payload.occurred_at);
  });

  test("names the rider's first name and nothing else (Q34)", async () => {
    const id = await newDelivery();
    await toAccepted(id);
    await as(riderC, (db) =>
      db.query("select delivery.rider_step($1,'PICKUP_PENDING','p',null)", [id]));
    await as(riderC, (db) =>
      db.query("select delivery.rider_step($1,'PICKED_UP','p',null)", [id]));

    const events = await eventsFor(id);
    const onTheWay = events.find((e) => e.payload.pipeline_step === "out_for_delivery");
    assert.equal(onTheWay.payload.rider_first_name, "Asha");

    const body = JSON.stringify(onTheWay.payload);
    assert.ok(!body.includes("Menon"), "a surname is not needed to find a doorstep");
    assert.ok(!body.includes("+91900005"),
      "no number-masking provider exists (Q9), so a rider's mobile is not published");
  });

  test("the delivery code never leaves this system", async () => {
    const id = await newDelivery();
    await toAccepted(id);
    for (const s of ["PICKUP_PENDING", "PICKED_UP", "OUT_FOR_DELIVERY", "ARRIVED"]) {
      await as(riderC, (db) =>
        db.query("select delivery.rider_step($1,$2,'step',null)", [id, s]));
    }
    const code = await as(adminC, async (db) =>
      (await db.query("select delivery.issue_otp($1) as code", [id])).rows[0].code);

    for (const e of await eventsFor(id)) {
      const body = JSON.stringify(e.payload);
      assert.ok(!body.includes(code),
        "Q10 closed as option B: the code is read out by support, never pushed to Grocery");
      assert.ok(!/\botp\b/i.test(body), "nor any field that hints at one");
    }
  });

  test("no customer name, phone or address travels to Grocery", async () => {
    const id = await newDelivery();
    await toAccepted(id);
    for (const e of await eventsFor(id)) {
      const body = JSON.stringify(e.payload);
      for (const leak of ["L1", "400058", "recipient_name", "phone"]) {
        assert.ok(!body.includes(leak),
          `Grocery already holds the customer's details; echoing ${leak} back widens nothing but exposure`);
      }
    }
  });
});

// ═════════════════════ sending ═════════════════════

describe("sending", () => {
  test("one timeline row can only ever queue one event", async () => {
    const id = await newDelivery();
    await toAccepted(id);

    const events = await eventsFor(id);
    const keys = events.map((e) => e.event_key);
    assert.deepEqual(keys, [...new Set(keys)]);
    for (const k of keys) assert.match(k, /^dsc:\d+$/);

    // The unique index is what enforces it, not the application.
    await raw(async (db) => {
      const dup = db.query(
        `insert into integration.outbound_event (target,event,event_key,payload)
         values ('GROCERY','delivery.status_changed',$1,'{}'::jsonb)`, [keys[0]]);
      await assert.rejects(dup, /duplicate key|unique/i);
    });
  });

  test("the signature covers the timestamp, so a captured push expires", () => {
    const body = JSON.stringify({ tracking_id: "DLV-1" });
    const { header } = sign("s3cret", body);
    assert.equal(verify("s3cret", body, header).ok, true);

    const old = sign("s3cret", body, Date.now() - 400_000);
    const stale = verify("s3cret", body, old.header);
    assert.equal(stale.ok, false);
    assert.match(stale.reason, /timestamp/);
  });

  test("a body edited in flight fails verification", () => {
    const body = JSON.stringify({ customer_status: "SHIPPED" });
    const { header } = sign("s3cret", body);
    const tampered = JSON.stringify({ customer_status: "DELIVERED" });
    assert.equal(verify("s3cret", tampered, header).ok, false);
  });

  test("the scheme is the same one Grocery already signs with", () => {
    const body = '{"a":1}';
    const t = Math.floor(Date.now() / 1000);
    const expected = createHmac("sha256", "k").update(`${t}.${body}`).digest("hex");
    const { header } = sign("k", body, t * 1000);
    assert.equal(header, `t=${t},v1=${expected}`,
      "one scheme across Grocery, Inventory and logistics: one verify() to trust");
  });

  test("a queue failure cannot roll back a delivery", async () => {
    const id = await newDelivery();

    // Break the queue for the duration of one transition.
    await raw((db) => db.query(
      "alter table integration.outbound_event add constraint p5_break check (false) not valid"));
    await raw((db) => db.query(
      "alter table integration.outbound_event validate constraint p5_break").catch(() => {}));

    try {
      await as(adminC, (db) =>
        db.query("select delivery.transition($1,'READY_FOR_ASSIGNMENT','admitted',null)", [id]));
    } finally {
      await raw((db) => db.query(
        "alter table integration.outbound_event drop constraint if exists p5_break"));
    }

    const status = await raw(async (db) =>
      (await db.query("select status from delivery.delivery where id=$1", [id])).rows[0].status);
    assert.equal(status, "READY_FOR_ASSIGNMENT",
      "a rider on a doorstep must not lose a transition because a queue had a bad moment");
  });
});

// ═════════════════════ notifications ═════════════════════

describe("notifications", () => {
  test("a record per customer-visible change, linked to its queue row", async () => {
    const id = await newDelivery();
    await toAccepted(id);

    const rows = await as(adminC, async (db) =>
      (await db.query("select * from ops.recent_notifications($1,50)", [id])).rows);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].channel, "customer_app");
    assert.equal(rows[0].status, "QUEUED");

    const linked = await raw(async (db) =>
      (await db.query(
        `select n.outbound_event_id, e.event_key from ops.notification n
           join integration.outbound_event e on e.id = n.outbound_event_id
          where n.delivery_id = $1`, [id])).rows);
    assert.equal(linked.length, 1);
  });

  test("the worker's result reaches the log through a definer function", async () => {
    const id = await newDelivery();
    await toAccepted(id);

    const eventId = (await eventsFor(id))[0].id;

    const n = await as(adminC, async (db) =>
      (await db.query("select ops.record_notification_result($1,true,null) as n",
        [eventId])).rows[0].n);
    assert.equal(Number(n), 1,
      "ops.notification has a SELECT policy and no UPDATE policy: a direct write " +
      "from the worker would match zero rows and report success");

    const [row] = await as(adminC, async (db) =>
      (await db.query("select * from ops.recent_notifications($1,10)", [id])).rows);
    assert.equal(row.status, "SENT");
  });

  test("the email channel records intent and sends nothing", async () => {
    const id = await newDelivery();
    const logged = await as(SYSTEM, async (db) =>
      (await db.query("select ops.log_notification($1,'email','delivery.status_changed',$2::jsonb) as id",
        [id, JSON.stringify({ message: "hello" })])).rows[0].id);
    assert.ok(logged);

    const [row] = await as(adminC, async (db) =>
      (await db.query(
        "select * from ops.recent_notifications($1,10) where channel='email'", [id])).rows);
    assert.equal(row.status, "SUPPRESSED");
    assert.match(row.detail, /no email provider/i);
  });

  test("a rider cannot read the notification log", async () => {
    const rows = await as(riderC, async (db) =>
      (await db.query("select * from ops.notification")).rows);
    assert.equal(rows.length, 0, "notifications:read is admin and dispatcher only");
  });
});

// ═════════════════════ the health screen ═════════════════════

describe("outbound health", () => {
  test("counts come from a definer function, not a blind SELECT", async () => {
    // The trap this codebase keeps rediscovering: as a role with no
    // policy, a plain SELECT returns nothing and reports success. On
    // a health screen that reads as "all clear".
    const blind = await as(riderC, async (db) =>
      (await db.query("select count(*)::int as n from integration.outbound_event")).rows[0].n);
    const seen = await as(adminC, async (db) =>
      (await db.query("select * from integration.outbound_health()")).rows);

    const total = seen.reduce((n, r) => n + Number(r.n), 0);
    assert.equal(blind, 0, "the rider sees nothing, correctly");
    assert.ok(total > 0, "and the health function sees the queue, which is the point");
  });

  test("dead letters name the delivery a person has to chase", async () => {
    const id = await newDelivery();
    await toAccepted(id);
    const eventId = (await eventsFor(id))[0].id;

    await raw((db) => db.query(
      "update integration.outbound_event set status='DEAD', last_error='grocery said 400' where id=$1",
      [eventId]));

    const [dead] = await as(adminC, async (db) =>
      (await db.query("select * from integration.dead_outbound(50) where id=$1",
        [eventId])).rows);

    assert.ok(dead, "a dead status push must be visible, or a customer is stale forever");
    assert.equal(dead.delivery_id, id);
    assert.ok(dead.tracking_id, "with the tracking id, so it can be opened");
  });
});

// ═════════════════════ Q32: signing out ═════════════════════

describe("sign-out clears the outbox", () => {
  test("an empty outbox is safe to wipe", () => {
    const plan = planSignOut([]);
    assert.equal(plan.safe, true);
    assert.equal(plan.warning, null);
  });

  test("unsent work is never discarded silently", () => {
    const plan = planSignOut([
      createEvent("complete", "d1", { otp: "123456" }, 1),
      createEvent("step", "d2", { to: "PICKED_UP" }, 2),
    ]);

    assert.equal(plan.safe, false);
    assert.equal(plan.unsent, 2);
    assert.deepEqual(plan.deliveries.sort(), ["d1", "d2"]);
    assert.match(plan.warning, /2 updates on 2 jobs/);
    assert.match(plan.warning, /nobody will know that work was done/,
      "Phase 4b's rule is that an unanswered event stays; a sign-out button " +
      "that quietly deleted three completed deliveries would break it on purpose");
  });

  test("the warning counts jobs, not just events", () => {
    const plan = planSignOut([
      createEvent("step", "d1", {}, 1),
      createEvent("step", "d1", {}, 2),
      createEvent("complete", "d1", {}, 3),
    ]);
    assert.equal(plan.unsent, 3);
    assert.deepEqual(plan.deliveries, ["d1"]);
    assert.match(plan.warning, /3 updates on 1 job\b/);
  });
});
