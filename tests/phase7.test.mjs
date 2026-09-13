import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { as, raw, closePool, SYSTEM } from "./harness.mjs";
import { hashPassword } from "../lib/auth/password.ts";
import { EXPECTED_MIGRATIONS } from "../lib/migrations.ts";

/**
 * Phase 7 — running by itself, forgetting on time, saying how it went.
 *
 * Two things are load-bearing here and neither is the scheduler:
 * that an overdue job is DETECTABLE, and that the retention rules
 * remove what they claim to and nothing else.
 */

let adminC, dispatcherC, riderC, riderId;

before(async () => {
  await raw(async (db) => {
    await db.query(`
      truncate ops.job_run restart identity cascade;
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
      delete from identity.app_user where email like '%@p7.test';
    `);
  });

  const hash = await hashPassword("a-long-enough-password");
  let adminId, dispatcherId;

  await as(SYSTEM, async (db) => {
    await db.query(
      "select integration.upsert_location_ref('SH1',null,'Shop 1','STORE',null,null,'SEED')");
    ({ rows: [{ id: adminId }] } = await db.query(
      "select identity.create_user($1,$2,'admin',$3,'{}',false) as id",
      ["admin@p7.test", "Admin", hash]));
    ({ rows: [{ id: dispatcherId }] } = await db.query(
      "select identity.create_user($1,$2,'dispatcher',$3,'{}',false) as id",
      ["dispatch@p7.test", "Dispatcher", hash]));
  });

  adminC = await claimsFor(adminId);
  dispatcherC = await claimsFor(dispatcherId);

  let riderUser;
  await as(adminC, async (db) => {
    const { rows: [r] } = await db.query(
      "select * from fleet.create_rider($1,$2,$3,$4,$5,'BIKE','SH1',10)",
      ["asha@p7.test", "Asha Menon", "+91900007", hash, "RDR-P7"]);
    riderId = r.rider_id; riderUser = r.user_id;
  });
  await raw((db) => db.query(
    "update identity.app_user set must_change_password=false where email like '%@p7.test'"));
  riderC = await claimsFor(riderUser);
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

async function delivered() {
  const orderId = `ORD-${randomUUID().slice(0, 8)}`;
  const id = await as(SYSTEM, async (db) =>
    (await db.query(
      `select * from delivery.ingest_order($1,'CUST-7','SH1',$2::jsonb,$3::jsonb,'{}'::jsonb,
                                           null,null,null,'held',null)`,
      [orderId,
       JSON.stringify({ recipient_name: "R Iyer", phone: "+91900111", line1: "12 Hill Rd",
                        line2: "Flat 4", city: "Mumbai", pincode: "400050",
                        lat: 19.061234, lng: 72.831234,
                        instructions: "key under the blue pot" }),
       JSON.stringify([{ sku: "S1", name: "Something personal", quantity: 1 }])])).rows[0].delivery_id);

  await raw((db) => db.query(
    "update fleet.assignment set status='COMPLETED' where status in ('OFFERED','ACCEPTED')"));
  await as(adminC, (db) =>
    db.query("select delivery.transition($1,'READY_FOR_ASSIGNMENT','admitted',null)", [id]));
  await as(adminC, (db) => db.query("select fleet.set_availability($1,true,'t')", [riderId]));
  await as(dispatcherC, (db) => db.query("select fleet.assign_delivery($1,$2)", [id, riderId]));
  await as(riderC, (db) => db.query("select fleet.respond_to_assignment($1,true,null)", [id]));
  for (const s of ["PICKUP_PENDING", "PICKED_UP", "OUT_FOR_DELIVERY", "ARRIVED"]) {
    await as(riderC, (db) => db.query("select delivery.rider_step($1,$2,'s',null)", [id, s]));
  }
  const code = await as(adminC, async (db) =>
    (await db.query("select delivery.issue_otp($1) as c", [id])).rows[0].c);
  await as(riderC, (db) =>
    db.query("select delivery.complete_delivery($1,$2,null)", [id, code]));
  return { id, orderId, code };
}

/** Make a delivery look old enough for retention to reach it. */
const backdate = (id, days) => raw((db) => db.query(
  `update delivery.delivery set updated_at = now() - make_interval(days => $2) where id=$1`,
  [id, days]));

// ═════════════════════ the OTP leaves the journal ═════════════════════

describe("the code is not in the journal", () => {
  test("a submitted code is masked on the way in", async () => {
    const { id, code } = await delivered();

    const r = await as(riderC, async (db) =>
      (await db.query("select integration.apply_rider_event($1,$2,'complete',$3::jsonb,$4) as r",
        [randomUUID(), id, JSON.stringify({ otp: code }),
         new Date().toISOString()])).rows[0].r);
    assert.ok(r.status);

    const rows = await raw(async (db) => (await db.query(
      "select payload from integration.rider_event where delivery_id=$1", [id])).rows);

    assert.ok(rows.length > 0, "setup: an event must exist");
    for (const row of rows) {
      if (row.payload.otp === undefined) continue;
      assert.equal(row.payload.otp, "******");
      assert.notEqual(row.payload.otp, code);
    }
  });

  test("the key survives, so we still know a code was submitted", async () => {
    const { id } = await delivered();
    await as(riderC, (db) =>
      db.query("select integration.apply_rider_event($1,$2,'complete',$3::jsonb,$4)",
        [randomUUID(), id, JSON.stringify({ otp: "123456" }), new Date().toISOString()]));

    const [row] = await raw(async (db) => (await db.query(
      `select payload from integration.rider_event
        where delivery_id=$1 and action='complete'`, [id])).rows);

    assert.ok("otp" in row.payload,
      "deleting the key would lose the fact that the rider even tried");
  });

  test("nothing else in the payload is touched", async () => {
    const { id } = await delivered();
    await as(riderC, (db) =>
      db.query("select integration.apply_rider_event($1,$2,'step',$3::jsonb,$4)",
        [randomUUID(), id, JSON.stringify({ to: "ARRIVED", note: "kept" }),
         new Date().toISOString()]));

    const [row] = await raw(async (db) => (await db.query(
      `select payload from integration.rider_event
        where delivery_id=$1 and action='step' order by id desc limit 1`, [id])).rows);
    assert.equal(row.payload.note, "kept");
  });

  test("a direct write cannot smuggle one in either", async () => {
    // The trigger is on the table, not in apply_rider_event, so a
    // writer added in a later phase cannot forget it.
    const { id } = await delivered();
    await raw((db) => db.query(
      `insert into integration.rider_event
         (client_event_id, rider_id, delivery_id, action, payload, captured_at, status)
       values ($1,$2,$3,'complete',$4::jsonb,now(),'APPLIED')`,
      [randomUUID(), riderId, id, JSON.stringify({ otp: "999999" })]));

    const found = await raw(async (db) => (await db.query(
      `select count(*)::int n from integration.rider_event
        where payload->>'otp' = '999999'`)).rows[0].n);
    assert.equal(found, 0);
  });

  test("no plaintext code exists anywhere after a delivery", async () => {
    const { id, code } = await delivered();
    await as(riderC, (db) =>
      db.query("select integration.apply_rider_event($1,$2,'complete',$3::jsonb,$4)",
        [randomUUID(), id, JSON.stringify({ otp: code }), new Date().toISOString()]));

    const hits = await raw(async (db) => (await db.query(
      `select
         (select count(*) from integration.rider_event where payload::text like '%'||$1||'%') as journal,
         (select count(*) from ops.notification    where payload::text like '%'||$1||'%') as notifications,
         (select count(*) from integration.outbound_event where payload::text like '%'||$1||'%') as outbound,
         (select count(*) from ops.audit_log where coalesce(before::text,'')||coalesce(after::text,'')
                                                   like '%'||$1||'%') as audit`,
      [code])).rows[0]);

    for (const [where, n] of Object.entries(hits)) {
      assert.equal(Number(n), 0, `the code appears in ${where}`);
    }
  });
});

// ═════════════════════ Q29: the job journal ═════════════════════

describe("the scheduler can be watched", () => {
  test("a run is recorded with its outcome", async () => {
    const runId = await raw(async (db) =>
      (await db.query("select ops.job_started('outbound.drain','t') as id")).rows[0].id);
    await raw((db) => db.query(
      "select ops.job_finished($1,true,null,$2::jsonb)", [runId, JSON.stringify({ delivered: 3 })]));

    const [row] = await as(adminC, async (db) =>
      (await db.query("select * from ops.job_run where id=$1", [runId])).rows);
    assert.equal(row.ok, true);
    assert.equal(row.stats.delivered, 3);
    assert.ok(row.finished_at);
  });

  test("a failure is recorded as a failure, not as silence", async () => {
    const runId = await raw(async (db) =>
      (await db.query("select ops.job_started('holds.expire','t') as id")).rows[0].id);
    await raw((db) => db.query(
      "select ops.job_finished($1,false,'inventory unreachable',null)", [runId]));

    const [h] = await as(adminC, async (db) =>
      (await db.query("select * from ops.job_health() where job='holds.expire'")).rows);
    assert.equal(h.last_outcome, false);
    assert.equal(h.last_detail, "inventory unreachable");
  });

  test("a job that has NEVER succeeded is overdue, not 'no data'", async () => {
    const [h] = await as(adminC, async (db) =>
      (await db.query("select * from ops.job_health() where job='retention.purge'")).rows);
    assert.equal(h.last_success, null);
    assert.equal(h.overdue, true,
      "'nothing has happened yet' and 'everything is fine' must not look the same");
  });

  test("a fresh success clears overdue, and staleness brings it back", async () => {
    const ok = async () => {
      const id = await raw(async (db) =>
        (await db.query("select ops.job_started('assignments.expire','t') as id")).rows[0].id);
      await raw((db) => db.query("select ops.job_finished($1,true,null,null)", [id]));
      return id;
    };
    const runId = await ok();

    let [h] = await as(adminC, async (db) =>
      (await db.query("select * from ops.job_health() where job='assignments.expire'")).rows);
    assert.equal(h.overdue, false);

    // Age the success past its window.
    await raw((db) => db.query(
      `update ops.job_run set finished_at = now() - interval '2 hours' where id=$1`, [runId]));

    [h] = await as(adminC, async (db) =>
      (await db.query("select * from ops.job_health() where job='assignments.expire'")).rows);
    assert.equal(h.overdue, true);
    assert.ok(h.seconds_since > 3600);
  });

  test("the health endpoint's expected-migration count is not stale", () => {
    // It said 9 while twelve existed, so the check had quietly
    // stopped checking. Forgetting to bump it now fails here.
    const files = readdirSync(new URL("../db/migrations", import.meta.url))
      .filter((f) => f.endsWith(".sql"));
    assert.equal(EXPECTED_MIGRATIONS, files.length,
      `app/api/health/route.ts expects ${EXPECTED_MIGRATIONS} migrations, ` +
      `db/migrations holds ${files.length}`);
  });

  test("every scheduled job has a handler the worker knows", async () => {
    const scheduled = await as(adminC, async (db) =>
      (await db.query("select job from ops.job_schedule where enabled")).rows.map((r) => r.job));
    const known = ["outbound.drain", "assignments.expire", "holds.expire", "retention.purge"];
    for (const j of scheduled) {
      assert.ok(known.includes(j), `${j} is scheduled but scripts/worker.mjs has no handler`);
    }
  });
});

// ═════════════════════ holds.expire — the job that never existed ═════════════════════

describe("lapsing holds", () => {
  test("a hold about to lapse is flagged once, not once per run", async () => {
    const orderId = `ORD-${randomUUID().slice(0, 8)}`;
    const id = await as(SYSTEM, async (db) =>
      (await db.query(
        `select * from delivery.ingest_order($1,null,'SH1',$2::jsonb,$3::jsonb,'{}'::jsonb,
                                             null,null,null,'held',$4)`,
        [orderId,
         JSON.stringify({ recipient_name: "A", phone: "1", line1: "L",
                          city: "M", pincode: "400058", lat: 19.1, lng: 72.8 }),
         JSON.stringify([{ sku: "S1", name: "Thing", quantity: 1 }]),
         new Date(Date.now() + 5 * 60_000).toISOString()])).rows[0].delivery_id);

    const first = await as(SYSTEM, async (db) =>
      (await db.query("select delivery.flag_expiring_holds(10) as n")).rows[0].n);
    assert.ok(first >= 1);

    const second = await as(SYSTEM, async (db) =>
      (await db.query("select delivery.flag_expiring_holds(10) as n")).rows[0].n);
    assert.equal(second, 0, "a job running every five minutes must not raise twelve an hour");

    const x = await as(adminC, async (db) =>
      (await db.query("select * from delivery.exceptions_for($1)", [id])).rows);
    assert.ok(x.some((e) => e.code === "HOLD_EXPIRING"));
  });

  test("a hold stops mattering once the parcel is in a bag", async () => {
    const { id } = await delivered();
    await raw((db) => db.query(
      `update delivery.delivery
          set hold_status='held', hold_confirmed=false,
              hold_expires_at = now() + interval '2 minutes'
        where id=$1`, [id]));

    const rows = await as(SYSTEM, async (db) =>
      (await db.query("select * from delivery.expiring_holds(10)")).rows
        .filter((r) => r.delivery_id === id));
    assert.equal(rows.length, 0,
      "the goods have physically left the shelf; the hold is no longer the question");
  });
});

// ═════════════════════ Q12: retention ═════════════════════

describe("retention", () => {
  test("a dry run changes nothing", async () => {
    const { id } = await delivered();
    await backdate(id, 200);

    const preview = await as(adminC, async (db) =>
      (await db.query("select * from ops.retention_preview()")).rows);
    assert.ok(preview.some((r) => Number(r.rows_affected) > 0), "setup: something must be due");

    const [a] = await raw(async (db) => (await db.query(
      "select recipient_name from delivery.delivery_address where delivery_id=$1", [id])).rows);
    assert.equal(a.recipient_name, "R Iyer", "preview must not have touched it");
  });

  test("the address is anonymised, not deleted", async () => {
    const { id } = await delivered();
    await backdate(id, 200);
    await raw((db) => db.query("select ops.retention_purge()"));

    const [a] = await raw(async (db) => (await db.query(
      "select * from delivery.delivery_address where delivery_id=$1", [id])).rows);

    assert.ok(a, "the row must survive, or every report joining to it breaks");
    // Overwritten, not nulled: 0005 made these NOT NULL because a
    // delivery with half an address is not a state this system may be
    // in. Blanking them would fail the constraint and take the whole
    // purge down with it.
    assert.equal(a.recipient_name, "[redacted]");
    assert.equal(a.phone, "[redacted]");
    assert.equal(a.line1, "[redacted]");
    // line2 and instructions ARE nullable, so they simply go.
    assert.equal(a.line2, null);
    assert.equal(a.instructions, null);

    // Kept on purpose: the operational history is not personal data.
    assert.equal(a.city, "Mumbai");
    assert.equal(a.pincode, "400050");

    // A neighbourhood, not a doorstep.
    assert.equal(Number(a.lat), 19.06);
    assert.equal(Number(a.lng), 72.83);
  });

  test("what somebody bought is forgotten; the sku is not", async () => {
    const { id } = await delivered();
    await backdate(id, 200);
    await raw((db) => db.query("select ops.retention_purge()"));

    const [i] = await raw(async (db) => (await db.query(
      "select * from delivery.delivery_item where delivery_id=$1", [id])).rows);
    assert.equal(i.name, "[redacted]");
    assert.equal(i.sku, "S1", "reports group by sku");
    assert.equal(i.quantity, 1);
  });

  test("a recent delivery is untouched", async () => {
    const { id } = await delivered();
    await backdate(id, 10);
    await raw((db) => db.query("select ops.retention_purge()"));

    const [a] = await raw(async (db) => (await db.query(
      "select recipient_name from delivery.delivery_address where delivery_id=$1", [id])).rows);
    assert.equal(a.recipient_name, "R Iyer");
  });

  test("an OPEN delivery is untouched however old it is", async () => {
    const orderId = `ORD-${randomUUID().slice(0, 8)}`;
    const id = await as(SYSTEM, async (db) =>
      (await db.query(
        `select * from delivery.ingest_order($1,null,'SH1',$2::jsonb,$3::jsonb,'{}'::jsonb,
                                             null,null,null,'held',null)`,
        [orderId,
         JSON.stringify({ recipient_name: "Still Waiting", phone: "1", line1: "L",
                          city: "M", pincode: "400058", lat: 19.1, lng: 72.8 }),
         JSON.stringify([{ sku: "S1", name: "Thing", quantity: 1 }])])).rows[0].delivery_id);
    await backdate(id, 900);
    await raw((db) => db.query("select ops.retention_purge()"));

    const [a] = await raw(async (db) => (await db.query(
      "select recipient_name from delivery.delivery_address where delivery_id=$1", [id])).rows);
    assert.equal(a.recipient_name, "Still Waiting",
      "the window runs from a TERMINAL state; an open delivery still needs its address");
  });

  test("rider traces are deleted outright", async () => {
    const { id } = await delivered();
    await raw((db) => db.query(
      `insert into fleet.rider_location (rider_id, delivery_id, lat, lng, recorded_at)
       values ($1,$2,19.1,72.8, now() - interval '40 days')`, [riderId, id]));

    await raw((db) => db.query("select ops.retention_purge()"));

    const n = await raw(async (db) => (await db.query(
      "select count(*)::int n from fleet.rider_location where delivery_id=$1", [id])).rows[0].n);
    assert.equal(n, 0, "a named worker's movement trace has no reason to outlive 30 days");
  });

  test("raw payloads are redacted, keeping the row", async () => {
    const { id } = await delivered();
    await raw((db) => db.query(
      `update integration.rider_event set received_at = now() - interval '200 days'
        where delivery_id=$1`, [id]));
    await raw((db) => db.query(
      `update ops.notification set created_at = now() - interval '200 days'
        where delivery_id=$1`, [id]));

    await raw((db) => db.query("select ops.retention_purge()"));

    const rows = await raw(async (db) => (await db.query(
      `select payload from ops.notification where delivery_id=$1`, [id])).rows);
    for (const r of rows) assert.deepEqual(r.payload, { redacted: true });
  });
});

// ═════════════════════ §3.2: the narrow hole ═════════════════════

describe("the audit log", () => {
  test("named PII keys are redacted and nothing else is", async () => {
    await as(SYSTEM, (db) => db.query(
      `select ops.audit('test.pii','delivery','p7',null,$1::jsonb,'seeded')`,
      [JSON.stringify({ phone: "+91900111", recipient_name: "R Iyer", status: "DELIVERED" })]));

    await raw((db) => db.query(
      `update ops.audit_log set occurred_at = now() - interval '200 days'
        where action='test.pii'`).catch(() => {}));

    // occurred_at is protected by the same trigger, so age it the
    // only way that works: through the function under test.
    const n = await raw(async (db) =>
      (await db.query("select ops.redact_audit_pii(0) as n")).rows[0].n);
    assert.ok(n > 0);

    const [row] = await as(adminC, async (db) => (await db.query(
      `select after from ops.audit_log where action='test.pii' order by id desc limit 1`)).rows);

    assert.equal(row.after.phone, "[redacted]");
    assert.equal(row.after.recipient_name, "[redacted]");
    assert.equal(row.after.status, "DELIVERED", "only the named keys, nothing else");
  });

  test("the log is still append-only afterwards", async () => {
    await as(SYSTEM, (db) => db.query(
      "select ops.audit('test.immutable','delivery','p7',null,null,'seeded')"));

    await raw((db) => db.query("select ops.redact_audit_pii(0)"));

    await raw(async (db) => {
      const id = (await db.query(
        "select id from ops.audit_log order by id desc limit 1")).rows[0].id;

      await assert.rejects(
        db.query("update ops.audit_log set reason='rewritten' where id=$1", [id]),
        /AUDIT_IMMUTABLE/,
        "the redaction must close the door behind it");
      await assert.rejects(
        db.query("delete from ops.audit_log where id=$1", [id]),
        /AUDIT_IMMUTABLE/);
    });
  });

  test("the redaction audits itself", async () => {
    await as(SYSTEM, (db) => db.query(
      `select ops.audit('test.selfaudit','delivery','p7',null,$1::jsonb,'seeded')`,
      [JSON.stringify({ phone: "+91900222" })]));
    await raw((db) => db.query("select ops.redact_audit_pii(0)"));

    const [row] = await as(adminC, async (db) => (await db.query(
      `select after from ops.audit_log where action='retention.audit_redacted'
        order by id desc limit 1`)).rows);
    assert.ok(row, "a deliberate exception to an invariant should leave its own trace");
    assert.ok(Number(row.after.rows) > 0);
  });

  test("a signed-in user cannot call it, whatever their role", async () => {
    for (const who of [adminC, dispatcherC, riderC]) {
      await assert.rejects(
        as(who, (db) => db.query("select ops.redact_audit_pii(0)")),
        /permission denied/i);
    }
  });

  test("nor can anybody reach the purge through a screen", async () => {
    await assert.rejects(
      as(adminC, (db) => db.query("select ops.retention_purge()")),
      /permission denied/i,
      "Postgres grants EXECUTE to PUBLIC by default; revoking from authenticated alone " +
      "does nothing, as mint_otp taught this codebase in Phase 4a");
  });
});

// ═════════════════════ reports ═════════════════════

describe("reports", () => {
  test("a stuck delivery appears after the threshold and not before", async () => {
    const orderId = `ORD-${randomUUID().slice(0, 8)}`;
    const id = await as(SYSTEM, async (db) =>
      (await db.query(
        `select * from delivery.ingest_order($1,null,'SH1',$2::jsonb,$3::jsonb,'{}'::jsonb,
                                             null,null,null,'held',null)`,
        [orderId,
         JSON.stringify({ recipient_name: "A", phone: "1", line1: "L",
                          city: "M", pincode: "400058", lat: 19.1, lng: 72.8 }),
         JSON.stringify([{ sku: "S1", name: "T", quantity: 1 }])])).rows[0].delivery_id);

    let stuck = await as(dispatcherC, async (db) =>
      (await db.query("select * from delivery.stuck_deliveries(60)")).rows
        .filter((r) => r.delivery_id === id));
    assert.equal(stuck.length, 0, "it only just arrived");

    await raw((db) => db.query(
      `alter table delivery.delivery_status_history disable trigger delivery_history_no_update;
       update delivery.delivery_status_history set occurred_at = now() - interval '3 hours'
        where delivery_id = '${id}';
       alter table delivery.delivery_status_history enable trigger delivery_history_no_update;`));

    stuck = await as(dispatcherC, async (db) =>
      (await db.query("select * from delivery.stuck_deliveries(60)")).rows
        .filter((r) => r.delivery_id === id));
    assert.equal(stuck.length, 1);
    assert.ok(stuck[0].stuck_minutes >= 60);
  });

  test("a terminal delivery is never stuck", async () => {
    const { id } = await delivered();
    await raw((db) => db.query(
      `alter table delivery.delivery_status_history disable trigger delivery_history_no_update;
       update delivery.delivery_status_history set occurred_at = now() - interval '5 days'
        where delivery_id = '${id}';
       alter table delivery.delivery_status_history enable trigger delivery_history_no_update;`));

    const stuck = await as(dispatcherC, async (db) =>
      (await db.query("select * from delivery.stuck_deliveries(60)")).rows
        .filter((r) => r.delivery_id === id));
    assert.equal(stuck.length, 0);
  });

  test("on-time rate says it is not available, and why", async () => {
    const rows = await as(dispatcherC, async (db) =>
      (await db.query("select * from delivery.outcome_rates(null)")).rows);

    const onTime = rows.find((r) => r.metric === "on-time rate");
    assert.equal(onTime.value, "not available",
      "a plausible-looking zero would be acted on");
    assert.match(onTime.detail, /Q8/);
    assert.match(onTime.detail, /Grocery sends none/);
  });

  test("latencies are computed from the timeline", async () => {
    await delivered();
    const rows = await as(dispatcherC, async (db) =>
      (await db.query("select * from delivery.latency_percentiles(null)")).rows);

    const names = rows.map((r) => r.metric);
    assert.ok(names.includes("assignment latency"));
    assert.ok(names.includes("delivery duration"));
    for (const r of rows) {
      assert.ok(Number(r.n) > 0);
      assert.ok(Number(r.p90_minutes) >= Number(r.p50_minutes));
      assert.ok(r.target, "a number without its target is not a KPI");
    }
  });

  test("commit health separates verified from everything else", async () => {
    await delivered();
    const rows = await as(dispatcherC, async (db) =>
      (await db.query("select * from delivery.commit_health()")).rows);
    assert.ok(rows.some((r) => r.kind === "commit"));
    for (const r of rows) assert.ok(Number(r.n) > 0);
  });

  test("the funnel counts what exists", async () => {
    const rows = await as(dispatcherC, async (db) =>
      (await db.query("select * from delivery.status_funnel(null)")).rows);
    const total = rows.reduce((n, r) => n + Number(r.n), 0);
    const actual = await raw(async (db) =>
      (await db.query("select count(*)::int n from delivery.delivery")).rows[0].n);
    assert.equal(total, actual);
  });

  test("a rider can read none of it", async () => {
    for (const fn of ["delivery.stuck_deliveries(60)",
                      "delivery.status_funnel(null)",
                      "delivery.latency_percentiles(null)"]) {
      const rows = await as(riderC, async (db) =>
        (await db.query(`select * from ${fn}`)).rows);
      assert.equal(rows.length, 0, `${fn} leaked to a rider`);
    }
  });

  test("the error rate is a rate, not a count", async () => {
    const [r] = await raw(async (db) =>
      (await db.query("select * from integration.error_rate()")).rows);
    assert.ok(r.rate === "no data" || /%$/.test(r.rate));
  });
});
