import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { as, raw, refuses, closePool, SYSTEM } from "./harness.mjs";
import { hashPassword } from "../lib/auth/password.ts";
import { validate } from "../lib/delivery/ingest.ts";
import { allowedNext, ALLOWED_NEXT, STATUSES } from "../lib/delivery/states.ts";
import { sign, verify } from "../lib/webhooks.ts";

let adminId, dispatcherId, riderId;
let adminClaims, dispatcherClaims, riderClaims;

const SECRET = "test-secret-not-a-real-one";

before(async () => {
  // Phase 2 builds on Phase 1's fixtures without disturbing them.
  await raw(async (db) => {
    await db.query(`
      truncate delivery.delivery, delivery.delivery_address,
               delivery.delivery_item, integration.inbound_event
        restart identity cascade;
      alter table delivery.delivery_status_history disable trigger delivery_history_no_delete;
      delete from delivery.delivery_status_history;
      alter table delivery.delivery_status_history enable trigger delivery_history_no_delete;
      delete from identity.app_user where email like '%@p2.test';
    `);
  });

  const hash = await hashPassword("a-long-enough-password");

  await as(SYSTEM, async (db) => {
    ({ rows: [{ id: adminId }] } = await db.query(
      "select identity.create_user($1,$2,'admin',$3,'{}',false) as id",
      ["admin@p2.test", "P2 Admin", hash]));
    ({ rows: [{ id: dispatcherId }] } = await db.query(
      "select identity.create_user($1,$2,'dispatcher',$3,$4,false) as id",
      ["dispatch@p2.test", "P2 Dispatcher", hash, ["SH1"]]));
    ({ rows: [{ id: riderId }] } = await db.query(
      "select identity.create_user($1,$2,'rider',$3,'{}',false) as id",
      ["rider@p2.test", "P2 Rider", hash]));

    // Two locations, so location scoping has something to hide.
    for (const [c, n] of [["SH1", "Shop 1"], ["SH2", "Shop 2"]]) {
      await db.query(
        "select integration.upsert_location_ref($1,null,$2,'STORE',null,null,'SEED')", [c, n]);
    }
  });

  adminClaims = await claimsFor(adminId);
  dispatcherClaims = await claimsFor(dispatcherId);
  riderClaims = await claimsFor(riderId);
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

/** A well-formed payload. Overrides are shallow-merged. */
function payload(over = {}) {
  return {
    external_order_id: `ORD-${randomUUID().slice(0, 8)}`,
    external_customer_id: randomUUID(),
    pickup: { location_code: "SH1" },
    delivery_address: {
      recipient_name: "A. Sharma", phone: "+919876543210",
      line1: "402 Sunview", city: "Mumbai", pincode: "400058",
      lat: 19.1204, lng: 72.8501,
    },
    items: [{ sku: "PRD-2026-000001", name: "Basmati Rice 5kg", quantity: 1 }],
    payment: { method: "RAZORPAY", is_prepaid: true, order_total_paise: 74900 },
    ...over,
  };
}

/** Ingest straight through the DB function, as the route does. */
async function ingest(claims, p, hold = "held", expires = null) {
  return as(claims, async (db) => {
    const { rows } = await db.query(
      `select * from delivery.ingest_order($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,
                                           null,null,null,$7,$8)`,
      [p.external_order_id, p.external_customer_id,
       p.pickup.location_code, JSON.stringify(p.delivery_address),
       JSON.stringify(p.items), JSON.stringify(p.payment ?? {}), hold, expires]);
    return rows[0];
  });
}

// ───────────────────── payload validation ─────────────────────

describe("payload validation", () => {
  test("a complete payload passes", () => {
    assert.equal(validate(payload()), null);
  });

  test("a missing order id is refused", () => {
    const r = validate(payload({ external_order_id: undefined }));
    assert.equal(r.code, "schema_invalid");
    assert.ok(r.fields.includes("external_order_id"));
  });

  test("a missing pickup location is refused", () => {
    const r = validate(payload({ pickup: {} }));
    assert.ok(r.fields.includes("pickup.location_code"));
  });

  test("NO ADDRESS gets its own code - the case that will actually happen", () => {
    // Every real order in this estate today looks like this (Q1).
    const r = validate(payload({ delivery_address: undefined }));
    assert.equal(r.code, "address_not_deliverable");
  });

  test("an address without a geocode is refused", () => {
    const a = { ...payload().delivery_address };
    delete a.lat;
    const r = validate(payload({ delivery_address: a }));
    assert.equal(r.code, "address_not_deliverable");
    assert.ok(r.fields.includes("delivery_address.lat"));
  });

  test("an address missing a required line is refused", () => {
    const a = { ...payload().delivery_address, line1: "" };
    assert.equal(validate(payload({ delivery_address: a })).code, "address_not_deliverable");
  });

  test("out-of-range coordinates are refused", () => {
    const a = { ...payload().delivery_address, lat: 120 };
    assert.equal(validate(payload({ delivery_address: a })).code, "address_not_deliverable");
  });

  test("empty items are refused", () => {
    assert.equal(validate(payload({ items: [] })).code, "schema_invalid");
  });

  test("a zero or negative quantity is refused", () => {
    for (const q of [0, -1, 1.5]) {
      const r = validate(payload({ items: [{ sku: "X", quantity: q }] }));
      assert.equal(r.code, "schema_invalid", `quantity ${q} should be refused`);
    }
  });

  test("an unknown field is IGNORED, not rejected", () => {
    // Forward compatibility: a sender adding a field in a minor
    // version must not break an older receiver.
    assert.equal(validate(payload({ some_future_field: "hello" })), null);
  });
});

// ───────────────────── signing ─────────────────────

describe("webhook signatures", () => {
  test("a signature we made verifies", () => {
    const body = JSON.stringify({ a: 1 });
    const { header } = sign(SECRET, body);
    assert.equal(verify(SECRET, body, header).ok, true);
  });

  test("a different secret does not", () => {
    const body = JSON.stringify({ a: 1 });
    const { header } = sign(SECRET, body);
    const r = verify("wrong-secret", body, header);
    assert.equal(r.ok, false);
    assert.match(r.reason, /does not match/);
  });

  test("a tampered body does not", () => {
    const { header } = sign(SECRET, JSON.stringify({ amount: 100 }));
    const r = verify(SECRET, JSON.stringify({ amount: 999999 }), header);
    assert.equal(r.ok, false);
  });

  test("an old signature is refused, and says so", () => {
    const body = JSON.stringify({ a: 1 });
    const { header } = sign(SECRET, body, Date.now() - 400_000);
    const r = verify(SECRET, body, header);
    assert.equal(r.ok, false);
    assert.match(r.reason, /timestamp/);
  });

  test("a missing or malformed header is refused, not crashed", () => {
    const body = "{}";
    assert.equal(verify(SECRET, body, null).ok, false);
    assert.equal(verify(SECRET, body, "garbage").ok, false);
    assert.equal(verify(SECRET, body, "t=123").ok, false);
  });
});

// ───────────────────── ingest ─────────────────────

describe("ingest", () => {
  test("creates a delivery, snapshot, items and the first timeline row", async () => {
    const p = payload();
    const r = await ingest(SYSTEM, p);

    assert.equal(r.created, true);
    assert.equal(r.status, "RECEIVED");
    assert.match(r.tracking_id, /^DLV-\d{4}-\d{6}$/);

    const { rows } = await raw((db) => db.query(
      `select (select count(*)::int from delivery.delivery_address where delivery_id=$1) addr,
              (select count(*)::int from delivery.delivery_item where delivery_id=$1) items,
              (select count(*)::int from delivery.delivery_status_history where delivery_id=$1) hist`,
      [r.delivery_id]));

    assert.equal(rows[0].addr, 1);
    assert.equal(rows[0].items, 1);
    assert.equal(rows[0].hist, 1);
  });

  test("tracking ids are unique and sequential", async () => {
    const a = await ingest(SYSTEM, payload());
    const b = await ingest(SYSTEM, payload());
    assert.notEqual(a.tracking_id, b.tracking_id);
    assert.ok(b.tracking_id > a.tracking_id);
  });

  test("the same order twice yields ONE delivery", async () => {
    const p = payload();
    const first = await ingest(SYSTEM, p);
    const second = await ingest(SYSTEM, p);

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(first.delivery_id, second.delivery_id);
  });

  test("FIVE CONCURRENT ingests of one order yield exactly one delivery", async () => {
    // The unique index does this, not application luck.
    const p = payload();
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => ingest(SYSTEM, p)));

    const ok = results.filter((r) => r.status === "fulfilled");
    assert.ok(ok.length >= 1, "at least one must succeed");

    const { rows } = await raw((db) => db.query(
      "select count(*)::int n from delivery.delivery where external_order_id = $1",
      [p.external_order_id]));
    assert.equal(rows[0].n, 1, "exactly one delivery may exist for one order");
  });

  test("an unknown pickup location is refused", async () => {
    await refuses(
      () => ingest(SYSTEM, payload({ pickup: { location_code: "NOPE" } })),
      /UNKNOWN_PICKUP_LOCATION/);
  });

  test("an inactive location is refused", async () => {
    // Deactivated through raw(), not as(), and the difference matters.
    //
    // integration.location_ref has a SELECT policy and no write policy,
    // so an UPDATE through the `authenticated` role matches zero rows
    // and reports success. That is intended -- the cache is written
    // only by locations:sync, which runs as the pool's own superuser
    // and bypasses RLS -- but it is exactly the silent no-op that a
    // grant without a policy produces, and the first version of this
    // test was fooled by it.
    await raw((db) => db.query(
      "update integration.location_ref set is_active=false where code='SH2'"));

    await refuses(
      () => ingest(SYSTEM, payload({ pickup: { location_code: "SH2" } })),
      /UNKNOWN_PICKUP_LOCATION/);

    await raw((db) => db.query(
      "update integration.location_ref set is_active=true where code='SH2'"));
  });

  test("a write to the location cache through RLS is a silent no-op", async () => {
    // Pinning the behaviour above, so that if a write policy is ever
    // added the change is deliberate rather than discovered.
    await as(adminClaims, (db) => db.query(
      "update integration.location_ref set name='Tampered' where code='SH1'"));

    const { rows } = await raw((db) => db.query(
      "select name from integration.location_ref where code='SH1'"));
    assert.notEqual(rows[0].name, "Tampered",
      "only locations:sync may write the cache");
  });

  test("hold status and expiry are recorded", async () => {
    const when = new Date(Date.now() + 20 * 60_000).toISOString();
    const r = await ingest(SYSTEM, payload(), "held", when);

    const { rows } = await raw((db) => db.query(
      "select hold_status, hold_expires_at, hold_confirmed from delivery.delivery where id=$1",
      [r.delivery_id]));

    assert.equal(rows[0].hold_status, "held");
    assert.ok(rows[0].hold_expires_at);
    // False until Q4 is resolved. Not aspirational.
    assert.equal(rows[0].hold_confirmed, false);
  });

  test("an unverified hold still ingests, flagged", async () => {
    // An Inventory outage must not become a Grocery outage.
    const r = await ingest(SYSTEM, payload(), "unknown", null);
    const { rows } = await raw((db) => db.query(
      "select hold_status from delivery.delivery where id=$1", [r.delivery_id]));
    assert.equal(rows[0].hold_status, "unknown");
  });

  test("a reservation id is carried when the sender supplies one", async () => {
    const rid = randomUUID();
    const p = payload({
      items: [{ sku: "X-1", name: "Thing", quantity: 2, reservation_id: rid }],
    });
    const r = await ingest(SYSTEM, p);

    const { rows } = await raw((db) => db.query(
      "select reservation_id from delivery.delivery_item where delivery_id=$1", [r.delivery_id]));
    assert.equal(rows[0].reservation_id, rid);
  });
});

// ───────────────────── the state machine ─────────────────────

describe("state machine", () => {
  test("the TypeScript mirror agrees with the database", async () => {
    // A mirror is only safe to keep if something notices it drifting.
    for (const status of STATUSES) {
      const { rows } = await raw((db) => db.query(
        "select delivery.allowed_next($1) as next", [status]));
      assert.deepEqual(
        [...rows[0].next].sort(),
        [...allowedNext(status)].sort(),
        `allowed_next('${status}') differs between SQL and lib/delivery/states.ts`);
    }
  });

  test("RECEIVED -> READY_FOR_ASSIGNMENT works and is recorded", async () => {
    const r = await ingest(SYSTEM, payload());

    await as(adminClaims, (db) =>
      db.query("select delivery.transition($1,'READY_FOR_ASSIGNMENT','admitted',null)",
        [r.delivery_id]));

    const { rows } = await raw((db) => db.query(
      `select d.status, h.from_status, h.to_status, h.actor_role, h.reason_code
         from delivery.delivery d
         join delivery.delivery_status_history h on h.delivery_id = d.id
        where d.id = $1 and h.to_status = 'READY_FOR_ASSIGNMENT'`, [r.delivery_id]));

    assert.equal(rows[0].status, "READY_FOR_ASSIGNMENT");
    assert.equal(rows[0].from_status, "RECEIVED");
    assert.equal(rows[0].actor_role, "admin");
    assert.equal(rows[0].reason_code, "admitted");
  });

  test("an illegal transition is refused, naming what IS allowed", async () => {
    const r = await ingest(SYSTEM, payload());
    const e = await refuses(
      () => as(adminClaims, (db) =>
        db.query("select delivery.transition($1,'DELIVERED',null,null)", [r.delivery_id])),
      /ILLEGAL_TRANSITION/);
    assert.match(e.message, /READY_FOR_ASSIGNMENT/);
  });

  test("a terminal state accepts nothing", async () => {
    const r = await ingest(SYSTEM, payload());
    await as(adminClaims, (db) =>
      db.query("select delivery.transition($1,'CANCELLED','cancelled','test')", [r.delivery_id]));

    const e = await refuses(
      () => as(adminClaims, (db) =>
        db.query("select delivery.transition($1,'READY_FOR_ASSIGNMENT',null,null)",
          [r.delivery_id])),
      /ILLEGAL_TRANSITION/);
    assert.match(e.message, /terminal/);
  });

  test("admitting twice is refused, not silently repeated", async () => {
    const r = await ingest(SYSTEM, payload());
    await as(adminClaims, (db) =>
      db.query("select delivery.transition($1,'READY_FOR_ASSIGNMENT',null,null)",
        [r.delivery_id]));
    await refuses(
      () => as(adminClaims, (db) =>
        db.query("select delivery.transition($1,'READY_FOR_ASSIGNMENT',null,null)",
          [r.delivery_id])),
      /ILLEGAL_TRANSITION/);
  });

  test("every transition writes exactly one history row and one audit row", async () => {
    const r = await ingest(SYSTEM, payload());
    const before = await raw((db) => db.query(
      "select count(*)::int n from ops.audit_log where entity_id=$1", [r.delivery_id]));

    await as(adminClaims, (db) =>
      db.query("select delivery.transition($1,'READY_FOR_ASSIGNMENT',null,null)",
        [r.delivery_id]));

    const hist = await raw((db) => db.query(
      "select count(*)::int n from delivery.delivery_status_history where delivery_id=$1",
      [r.delivery_id]));
    const after = await raw((db) => db.query(
      "select count(*)::int n from ops.audit_log where entity_id=$1", [r.delivery_id]));

    assert.equal(hist.rows[0].n, 2, "ingest + admit");
    assert.equal(after.rows[0].n, before.rows[0].n + 1);
  });

  test("the timeline reads oldest first", async () => {
    const r = await ingest(SYSTEM, payload());
    await as(adminClaims, (db) =>
      db.query("select delivery.transition($1,'READY_FOR_ASSIGNMENT',null,null)",
        [r.delivery_id]));

    const { rows } = await raw((db) => db.query(
      `select to_status from delivery.delivery_status_history
        where delivery_id=$1 order by occurred_at, id`, [r.delivery_id]));

    assert.deepEqual(rows.map((x) => x.to_status), ["RECEIVED", "READY_FOR_ASSIGNMENT"]);
  });

  test("a transition at another shop is refused", async () => {
    const r = await ingest(SYSTEM, payload({ pickup: { location_code: "SH2" } }));
    // The dispatcher is bound to SH1.
    await refuses(
      () => as(dispatcherClaims, (db) =>
        db.query("select delivery.transition($1,'READY_FOR_ASSIGNMENT',null,null)",
          [r.delivery_id])),
      /FORBIDDEN_LOCATION|NO_SUCH_DELIVERY/);
  });
});

// ───────────────────── visibility ─────────────────────

describe("visibility", () => {
  let sh1, sh2;

  before(async () => {
    sh1 = await ingest(SYSTEM, payload({ pickup: { location_code: "SH1" } }));
    sh2 = await ingest(SYSTEM, payload({ pickup: { location_code: "SH2" } }));
  });

  test("a dispatcher sees only their own shop", async () => {
    const { rows } = await as(dispatcherClaims, (db) =>
      db.query("select pickup_location_code from delivery.delivery"));
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r.pickup_location_code === "SH1"),
      "a dispatcher bound to SH1 must not see SH2");
  });

  test("an admin sees every shop", async () => {
    const { rows } = await as(adminClaims, (db) =>
      db.query("select distinct pickup_location_code from delivery.delivery"));
    assert.ok(rows.length >= 2);
  });

  test("a rider sees no deliveries at all", async () => {
    const { rows } = await as(riderClaims, (db) =>
      db.query("select id from delivery.delivery"));
    assert.equal(rows.length, 0, "riders get deliveries in Phase 4, via their assignment");
  });

  test("the address is hidden with its delivery", async () => {
    const { rows } = await as(dispatcherClaims, (db) =>
      db.query("select delivery_id from delivery.delivery_address where delivery_id = $1",
        [sh2.delivery_id]));
    assert.equal(rows.length, 0, "no delivery, no address");
  });

  test("items are hidden with their delivery", async () => {
    const { rows } = await as(dispatcherClaims, (db) =>
      db.query("select id from delivery.delivery_item where delivery_id = $1",
        [sh2.delivery_id]));
    assert.equal(rows.length, 0);
  });

  test("the timeline is hidden with its delivery", async () => {
    const { rows } = await as(dispatcherClaims, (db) =>
      db.query("select id from delivery.delivery_status_history where delivery_id = $1",
        [sh2.delivery_id]));
    assert.equal(rows.length, 0);
  });

  test("a dispatcher cannot read inbound events", async () => {
    await as(SYSTEM, (db) => db.query(
      `select integration.record_inbound('GROCERY','order.delivery_ready',null,'X',
                                         '{}'::jsonb,'REJECTED','test','t')`));
    const { rows } = await as(dispatcherClaims, (db) =>
      db.query("select id from integration.inbound_event"));
    assert.equal(rows.length, 0, "payloads contain customer PII; admin only");
  });

  test("an admin can read inbound events", async () => {
    const { rows } = await as(adminClaims, (db) =>
      db.query("select id from integration.inbound_event"));
    assert.ok(rows.length > 0);
  });
});

// ───────────────────── inbound journal ─────────────────────

describe("inbound journal", () => {
  test("a rejection is recorded with its payload and reason", async () => {
    const p = payload({ delivery_address: undefined });

    await as(SYSTEM, (db) => db.query(
      `select integration.record_inbound('GROCERY','order.delivery_ready',$1,$2,
                                         $3::jsonb,'REJECTED','address_not_deliverable',
                                         'no address')`,
      [randomUUID(), p.external_order_id, JSON.stringify(p)]));

    const { rows } = await as(adminClaims, (db) => db.query(
      `select status, error_code, payload from integration.inbound_event
        where external_order_id=$1`, [p.external_order_id]));

    assert.equal(rows[0].status, "REJECTED");
    assert.equal(rows[0].error_code, "address_not_deliverable");
    // The payload survives, which is the whole point: when Grocery
    // starts sending addresses, this backlog can be replayed.
    assert.equal(rows[0].payload.external_order_id, p.external_order_id);
  });

  test("marking replayed requires the permission", async () => {
    const { rows } = await as(adminClaims, (db) =>
      db.query("select id from integration.inbound_event where status='REJECTED' limit 1"));

    await refuses(
      () => as(dispatcherClaims, (db) =>
        db.query("select integration.mark_replayed($1)", [rows[0].id])),
      /FORBIDDEN/);
  });

  test("an admin can mark it replayed", async () => {
    const { rows } = await as(adminClaims, (db) =>
      db.query("select id from integration.inbound_event where status='REJECTED' limit 1"));

    await as(adminClaims, (db) =>
      db.query("select integration.mark_replayed($1)", [rows[0].id]));

    const { rows: after } = await as(adminClaims, (db) =>
      db.query("select status, attempts, resolved_at from integration.inbound_event where id=$1",
        [rows[0].id]));

    assert.equal(after[0].status, "REPLAYED");
    assert.ok(after[0].attempts >= 2);
    assert.ok(after[0].resolved_at);
  });

  test("recording never throws, even on rubbish", async () => {
    // A journal failure must not turn a good ingest into an error.
    const { rows } = await as(SYSTEM, (db) => db.query(
      `select integration.record_inbound('GROCERY','e',null,null,'{}'::jsonb,
                                         'NOT_A_VALID_STATUS') as id`));
    assert.equal(rows[0].id, null, "it swallows its own failure and returns null");
  });
});

// ───────────────────── hold expiry ─────────────────────

describe("hold expiry report", () => {
  test("a lapsing hold is listed; a distant one is not", async () => {
    const soon = new Date(Date.now() + 5 * 60_000).toISOString();
    const later = new Date(Date.now() + 10 * 60 * 60_000).toISOString();

    const a = await ingest(SYSTEM, payload(), "held", soon);
    const b = await ingest(SYSTEM, payload(), "held", later);

    const { rows } = await as(adminClaims, (db) => db.query(
      `select id from delivery.delivery
        where status not in ('DELIVERED','RETURNED','CANCELLED')
          and not hold_confirmed
          and hold_status='held' and hold_expires_at < now() + interval '30 minutes'`));

    const ids = rows.map((r) => r.id);
    assert.ok(ids.includes(a.delivery_id), "the lapsing one must be listed");
    assert.ok(!ids.includes(b.delivery_id), "the distant one must not be");
  });

  test("an unverified hold is also at risk", async () => {
    const r = await ingest(SYSTEM, payload(), "unknown", null);
    const { rows } = await as(adminClaims, (db) => db.query(
      `select id from delivery.delivery
        where hold_status='unknown' and status not in ('DELIVERED','RETURNED','CANCELLED')`));
    assert.ok(rows.map((x) => x.id).includes(r.delivery_id));
  });

  test("a cancelled delivery drops off the report", async () => {
    const soon = new Date(Date.now() + 5 * 60_000).toISOString();
    const r = await ingest(SYSTEM, payload(), "held", soon);

    await as(adminClaims, (db) =>
      db.query("select delivery.transition($1,'CANCELLED','cancelled','test')",
        [r.delivery_id]));

    const { rows } = await as(adminClaims, (db) => db.query(
      `select id from delivery.delivery
        where status not in ('DELIVERED','RETURNED','CANCELLED')
          and hold_status='held' and hold_expires_at < now() + interval '30 minutes'`));

    assert.ok(!rows.map((x) => x.id).includes(r.delivery_id));
  });
});
