import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { as, raw, refuses, truncateAll, closePool, SYSTEM } from "./harness.mjs";
import { hashPassword, verifyPassword } from "../lib/auth/password.ts";
import { redact } from "../lib/logging.ts";

let adminId, dispatcherId, riderId;
const PASSWORD = "correct-horse-battery";

before(async () => {
  await truncateAll();

  const hash = await hashPassword(PASSWORD);

  await as(SYSTEM, async (db) => {
    ({ rows: [{ id: adminId }] } = await db.query(
      "select identity.create_user($1,$2,'admin',$3,'{}',false) as id",
      ["admin@logistics.test", "Ada Admin", hash]));

    ({ rows: [{ id: dispatcherId }] } = await db.query(
      "select identity.create_user($1,$2,'dispatcher',$3,$4,false) as id",
      ["dispatch@logistics.test", "Dev Dispatcher", hash, ["SH1"]]));

    ({ rows: [{ id: riderId }] } = await db.query(
      "select identity.create_user($1,$2,'rider',$3,'{}',false) as id",
      ["rider@logistics.test", "Rhea Rider", hash]));
  });
});

after(async () => { await closePool(); });

// Claims as the sign-in path would produce them.
async function claimsFor(id) {
  return raw(async (db) => {
    const { rows } = await db.query(
      `select u.id, u.role, u.location_codes, identity.permissions_for(u.role) as perms
         from identity.app_user u where u.id = $1`, [id]);
    const r = rows[0];
    return {
      sub: r.id, role: r.role, actor_kind: "USER",
      location_codes: r.location_codes, permissions: r.perms,
    };
  });
}

// ───────────────────────── passwords ─────────────────────────

describe("passwords", () => {
  test("a correct password verifies", async () => {
    const h = await hashPassword("a-long-enough-password");
    assert.equal(await verifyPassword("a-long-enough-password", h), true);
  });

  test("a wrong password does not", async () => {
    const h = await hashPassword("a-long-enough-password");
    assert.equal(await verifyPassword("not-it-at-all", h), false);
  });

  test("short passwords are refused at hash time", async () => {
    await assert.rejects(() => hashPassword("short"), /PASSWORD_TOO_SHORT/);
  });

  test("the same password hashes differently each time", async () => {
    const a = await hashPassword("a-long-enough-password");
    const b = await hashPassword("a-long-enough-password");
    assert.notEqual(a, b, "salts must differ");
  });

  test("a corrupt stored hash reads as wrong, not as an error", async () => {
    assert.equal(await verifyPassword("anything", "garbage"), false);
    assert.equal(await verifyPassword("anything", ""), false);
  });
});

// ───────────────────────── sign in ─────────────────────────

/**
 * Attempt a sign-in exactly as the route does: on a connection with
 * NO claims set, because sign-in is the request that creates them.
 */
async function attempt(email, passwordOk, token = `tok-${Math.random()}`, cid = null) {
  return raw(async (db) => {
    try {
      await db.query("begin");
      const { rows } = await db.query(
        "select identity.open_session($1,$2,$3,3600,null,null,$4) as r",
        [email, passwordOk, token, cid]);
      await db.query("commit");
      return rows[0].r;
    } catch (e) {
      await db.query("rollback").catch(() => {});
      throw e;
    }
  });
}

describe("sign-in", () => {
  test("opens a session and audits it", async () => {
    const r = await attempt("admin@logistics.test", true, "hash-ok-1");

    assert.equal(r.ok, true);
    assert.equal(r.claims.role, "admin");
    assert.ok(r.claims.permissions.includes("users:write"));

    const { rows } = await raw((db) =>
      db.query("select count(*)::int n from ops.audit_log where action='auth.signed_in'"));
    assert.ok(rows[0].n >= 1);
  });

  test("the audit row NAMES the user who signed in", async () => {
    // Sign-in has no claims yet -- it is the request that creates
    // them -- so the first version wrote every auth row as
    // actor_kind SYSTEM, role anon, with no correlation id. The audit
    // log could not answer the one question it exists to answer.
    const cid = "test-correlation-0001";
    await attempt("admin@logistics.test", true, "tok-attributed", cid);

    const { rows } = await raw((db) => db.query(
      `select actor_id, actor_role, actor_kind, correlation_id
         from ops.audit_log
        where action = 'auth.signed_in' order by id desc limit 1`));

    assert.equal(rows[0].actor_id, adminId);
    assert.equal(rows[0].actor_role, "admin");
    assert.equal(rows[0].actor_kind, "USER");
    assert.equal(rows[0].correlation_id, cid);
  });

  test("a failed attempt is still attributed to the account", async () => {
    await attempt("rider@logistics.test", false, "tok-f", "cid-fail-1");

    const { rows } = await raw((db) => db.query(
      `select actor_id, actor_kind, correlation_id from ops.audit_log
        where action = 'auth.sign_in_failed' order by id desc limit 1`));

    assert.equal(rows[0].actor_id, riderId);
    assert.equal(rows[0].actor_kind, "USER");
    assert.equal(rows[0].correlation_id, "cid-fail-1");
  });

  test("an unknown email is refused like a wrong password", async () => {
    const unknown = await attempt("nobody@logistics.test", true);
    const wrong = await attempt("admin@logistics.test", false);

    assert.equal(unknown.ok, false);
    assert.equal(wrong.ok, false);
    assert.equal(unknown.code, wrong.code);
    assert.equal(unknown.message, wrong.message);
  });

  test("a failed attempt PERSISTS its counter and its audit row", async () => {
    // The regression that matters. The first implementation raised on
    // refusal, which rolled back the very bookkeeping the refusal
    // exists to record: the counter stayed at zero and the
    // auth.sign_in_failed row vanished with it.
    const before = await raw((db) => db.query(
      "select count(*)::int n from ops.audit_log where action='auth.sign_in_failed'"));

    await attempt("admin@logistics.test", false);

    const { rows } = await raw((db) => db.query(
      "select failed_count from identity.credential where user_id=$1", [adminId]));
    assert.ok(rows[0].failed_count > 0, "the counter must survive the refusal");

    const after = await raw((db) => db.query(
      "select count(*)::int n from ops.audit_log where action='auth.sign_in_failed'"));
    assert.ok(after.rows[0].n > before.rows[0].n, "the audit row must survive too");
  });

  test("five failures actually lock, and a CORRECT password is still refused", async () => {
    for (let i = 0; i < 5; i += 1) {
      const r = await attempt("rider@logistics.test", false);
      assert.equal(r.ok, false);
    }

    // This is the bug Inventory shipped and named a migration after:
    // a counter that increments while the right password sails through.
    const r = await attempt("rider@logistics.test", true);
    assert.equal(r.ok, false);
    assert.equal(r.code, "LOCKED_OUT");
    assert.ok(r.retry_after > 0, "a lockout must say when to come back");
  });

  test("a success resets the failure counter", async () => {
    await attempt("dispatch@logistics.test", false);
    const r = await attempt("dispatch@logistics.test", true, "hash-ok-2");
    assert.equal(r.ok, true);

    const { rows } = await raw((db) => db.query(
      "select failed_count from identity.credential where user_id=$1", [dispatcherId]));
    assert.equal(rows[0].failed_count, 0);
  });

  test("a suspended account cannot sign in", async () => {
    await raw((db) => db.query(
      "update identity.app_user set status='SUSPENDED' where id=$1", [dispatcherId]));

    const r = await attempt("dispatch@logistics.test", true, "hash-ok-3");
    assert.equal(r.ok, false);
    assert.equal(r.code, "ACCOUNT_SUSPENDED");

    await raw((db) => db.query(
      "update identity.app_user set status='ACTIVE' where id=$1", [dispatcherId]));
  });
});

// ───────────────────────── sessions ─────────────────────────

describe("sessions", () => {
  test("a live session resolves; a revoked one does not", async () => {
    await attempt("admin@logistics.test", true, "tok-live");

    let { rows } = await raw((db) =>
      db.query("select identity.resolve_session($1) as c", ["tok-live"]));
    assert.equal(rows[0].c.role, "admin");

    await raw((db) => db.query("select identity.close_session($1)", ["tok-live"]));

    ({ rows } = await raw((db) =>
      db.query("select identity.resolve_session($1) as c", ["tok-live"])));
    assert.equal(rows[0].c, null);
  });

  test("an expired session does not resolve", async () => {
    await attempt("admin@logistics.test", true, "tok-brief");

    await raw((db) => db.query(
      "update identity.session set expires_at = now() - interval '1 second' " +
      "where token_hash='tok-brief'"));

    const { rows } = await raw((db) =>
      db.query("select identity.resolve_session($1) as c", ["tok-brief"]));
    assert.equal(rows[0].c, null);
  });

  test("an unknown token resolves to null", async () => {
    const { rows } = await raw((db) =>
      db.query("select identity.resolve_session($1) as c", ["never-issued"]));
    assert.equal(rows[0].c, null);
  });
});

// ───────────────────────── permissions & RLS ─────────────────────────

describe("permissions and row-level security", () => {
  test("roles hold the permissions they should", async () => {
    const admin = await claimsFor(adminId);
    const rider = await claimsFor(riderId);

    assert.ok(admin.permissions.includes("keys:write"));
    assert.ok(admin.permissions.includes("audit:read"));
    assert.ok(!rider.permissions.includes("keys:write"));
    assert.ok(!rider.permissions.includes("audit:read"));
    assert.ok(rider.permissions.includes("locations:read"));
  });

  test("a rider cannot read the audit log", async () => {
    const rider = await claimsFor(riderId);
    const { rows } = await as(rider, (db) =>
      db.query("select * from ops.audit_log limit 5"));
    assert.equal(rows.length, 0, "RLS should hide every row");
  });

  test("an admin can read the audit log", async () => {
    const admin = await claimsFor(adminId);
    const { rows } = await as(admin, (db) =>
      db.query("select * from ops.audit_log limit 5"));
    assert.ok(rows.length > 0);
  });

  test("a rider sees only their own user row", async () => {
    const rider = await claimsFor(riderId);
    const { rows } = await as(rider, (db) =>
      db.query("select id from identity.app_user"));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, riderId);
  });

  test("a dispatcher cannot mint an API key", async () => {
    const d = await claimsFor(dispatcherId);
    await refuses(() => as(d, (db) =>
      db.query("select * from integration.create_api_client($1,$2)",
        ["sneaky", ["deliveries:read"]])), /FORBIDDEN_ROLE/);
  });

  test("a dispatcher cannot create a user", async () => {
    const d = await claimsFor(dispatcherId);
    await refuses(() => as(d, (db) =>
      db.query("select identity.create_user($1,$2,'admin',$3)",
        ["evil@logistics.test", "Evil", "x"])), /FORBIDDEN_ROLE/);
  });

  test("nobody can read password hashes through SQL", async () => {
    // Refused at the privilege level, before RLS is even consulted:
    // 0004 revokes the grant as well as denying it by policy, so a
    // policy mistake in a later migration still cannot expose them.
    const admin = await claimsFor(adminId);
    await refuses(() => as(admin, (db) =>
      db.query("select * from identity.credential")), /permission denied/);
  });

  test("location scoping hides other shops", async () => {
    await as(SYSTEM, async (db) => {
      for (const [c, n, t] of [["SH1", "Andheri", "STORE"], ["SH2", "Bandra", "STORE"]]) {
        await db.query("select integration.upsert_location_ref($1,null,$2,$3,null,null,'SEED')",
          [c, n, t]);
      }
    });

    const d = await claimsFor(dispatcherId);  // bound to SH1
    const { rows } = await as(d, (db) =>
      db.query("select code from integration.location_ref order by code"));
    assert.deepEqual(rows.map((r) => r.code), ["SH1"]);

    const admin = await claimsFor(adminId);   // bound to nothing = all
    const { rows: all } = await as(admin, (db) =>
      db.query("select code from integration.location_ref order by code"));
    assert.ok(all.length >= 2);
  });
});

// ───────────────────────── audit ─────────────────────────

describe("audit log", () => {
  test("UPDATE is refused", async () => {
    await refuses(() => raw((db) =>
      db.query("update ops.audit_log set action='tampered'")), /AUDIT_IMMUTABLE/);
  });

  test("DELETE is refused", async () => {
    await refuses(() => raw((db) =>
      db.query("delete from ops.audit_log")), /AUDIT_IMMUTABLE/);
  });

  test("no role holds an insert policy", async () => {
    const { rows } = await raw((db) => db.query(
      `select count(*)::int n from pg_policy p
         join pg_class c on c.oid = p.polrelid
        where c.relname = 'audit_log' and p.polcmd in ('a','*')`));
    assert.equal(rows[0].n, 0);
  });

  test("the actor cannot be forged - it comes from the claims", async () => {
    const admin = await claimsFor(adminId);
    await as(admin, (db) => db.query("select ops.audit('test.probe')"));

    const { rows } = await raw((db) => db.query(
      `select actor_id, actor_role, actor_kind from ops.audit_log
        where action='test.probe' order by id desc limit 1`));

    assert.equal(rows[0].actor_id, adminId);
    assert.equal(rows[0].actor_role, "admin");
    assert.equal(rows[0].actor_kind, "USER");
  });
});

// ───────────────────────── API keys ─────────────────────────

describe("API keys", () => {
  let key, clientId;

  test("an admin can mint one, and it is returned once", async () => {
    const admin = await claimsFor(adminId);
    const { rows } = await as(admin, (db) =>
      db.query("select * from integration.create_api_client($1,$2,'{}','LIVE')",
        ["Grocery storefront", ["orders:ingest", "deliveries:read"]]));

    key = rows[0].api_key;
    clientId = rows[0].client_id;

    assert.match(key, /^lg_live_[0-9a-f]{48}$/);
  });

  test("the key itself is never stored", async () => {
    const { rows } = await raw((db) => db.query(
      "select key_hash, key_prefix from integration.api_client where id=$1", [clientId]));
    assert.notEqual(rows[0].key_hash, key);
    assert.equal(rows[0].key_prefix, key.slice(0, 12));

    const { rows: hunt } = await raw((db) => db.query(
      "select count(*)::int n from integration.api_client where key_hash = $1", [key]));
    assert.equal(hunt[0].n, 0, "the raw key must not match any stored value");
  });

  test("it authenticates and carries its scopes", async () => {
    const { rows } = await raw((db) =>
      db.query("select integration.authenticate_api_key($1) as c", [key]));
    assert.equal(rows[0].c.role, "api_client");
    assert.deepEqual(rows[0].c.scopes, ["orders:ingest", "deliveries:read"]);
  });

  test("unknown and revoked keys are indistinguishable", async () => {
    const { rows: unknown } = await raw((db) =>
      db.query("select integration.authenticate_api_key($1) as c", ["lg_live_nope"]));

    await as(SYSTEM, (db) =>
      db.query("select integration.revoke_api_client($1)", [clientId]));

    const { rows: revoked } = await raw((db) =>
      db.query("select integration.authenticate_api_key($1) as c", [key]));

    assert.equal(unknown[0].c, null);
    assert.equal(revoked[0].c, null);
  });

  test("an expired key does not authenticate", async () => {
    const admin = await claimsFor(adminId);
    const { rows } = await as(admin, (db) =>
      db.query("select * from integration.create_api_client($1,$2)",
        ["Expiring", ["deliveries:read"]]));

    await raw((db) => db.query(
      "update integration.api_client set expires_at = now() - interval '1 day' where id=$1",
      [rows[0].client_id]));

    const { rows: check } = await raw((db) =>
      db.query("select integration.authenticate_api_key($1) as c", [rows[0].api_key]));
    assert.equal(check[0].c, null);
  });
});

// ───────────────────────── rate limit ─────────────────────────

describe("rate limit", () => {
  let clientId;

  before(async () => {
    const admin = await claimsFor(adminId);
    const { rows } = await as(admin, (db) =>
      db.query("select * from integration.create_api_client($1,$2,'{}','LIVE',$3)",
        ["Throttled", ["deliveries:read"], 5]));
    clientId = rows[0].client_id;
  });

  test("a NEW key is not rate-limited on its first request", async () => {
    // It was. `tokens` defaulted to 0 and refills from elapsed time
    // since mint, so the first call of a freshly minted key was
    // refused with a 429. The original version of the test below
    // hid it by setting the bucket by hand first.
    const admin = await claimsFor(adminId);
    const { rows: [k] } = await as(admin, (db) =>
      db.query("select * from integration.create_api_client($1,$2)",
        ["Fresh", ["deliveries:read"]]));

    const { rows } = await raw((db) =>
      db.query("select * from integration.consume_rate_token($1,1)", [k.client_id]));
    assert.equal(rows[0].allowed, true, "a new key must work immediately");
  });

  test("the bucket starts full and drains", async () => {
    for (let i = 0; i < 5; i += 1) {
      const { rows } = await raw((db) =>
        db.query("select * from integration.consume_rate_token($1,1)", [clientId]));
      assert.equal(rows[0].allowed, true, `request ${i + 1} should pass`);
    }

    const { rows } = await raw((db) =>
      db.query("select * from integration.consume_rate_token($1,1)", [clientId]));
    assert.equal(rows[0].allowed, false);
    assert.ok(rows[0].retry_after >= 1, "a refusal must say when to come back");
  });

  test("an unknown client is refused, not crashed", async () => {
    const { rows } = await raw((db) => db.query(
      "select * from integration.consume_rate_token($1,1)",
      ["00000000-0000-0000-0000-000000000000"]));
    assert.equal(rows[0].allowed, false);
  });
});

// ───────────────────────── logging ─────────────────────────

describe("logging", () => {
  test("secrets are redacted", () => {
    const out = redact({
      authorization: "Bearer lg_live_secret",
      password: "hunter2",
      nested: { api_key: "ic_live_abc", token_hash: "deadbeef" },
      harmless: "keep me",
    });

    const text = JSON.stringify(out);
    assert.ok(!text.includes("lg_live_secret"));
    assert.ok(!text.includes("hunter2"));
    assert.ok(!text.includes("ic_live_abc"));
    assert.ok(!text.includes("deadbeef"));
    assert.ok(text.includes("keep me"));
  });

  test("personal fields are masked, not dropped", () => {
    const out = redact({ phone: "+919876543210", email: "someone@example.com" });
    const text = JSON.stringify(out);
    assert.ok(!text.includes("9876543210"));
    assert.ok(text.includes("***"));
  });

  test("deeply nested secrets are still caught", () => {
    const out = redact({ a: { b: { c: { d: { password: "hunter2" } } } } });
    assert.ok(!JSON.stringify(out).includes("hunter2"));
  });
});

// ───────────────────────── external references ─────────────────────────

describe("external references", () => {
  test("both systems we talk to are registered", async () => {
    const admin = await claimsFor(adminId);
    const { rows } = await as(admin, (db) =>
      db.query("select code from integration.external_system order by code"));
    assert.deepEqual(rows.map((r) => r.code), ["GROCERY", "INVENTORY"]);
  });

  test("the location cache is upsert-idempotent", async () => {
    await as(SYSTEM, (db) =>
      db.query("select integration.upsert_location_ref($1,null,$2,'HUB',$3,$4,'SEED')",
        ["HUB", "Central Hub", 19.1, 72.9]));

    const first = await raw((db) => db.query(
      "select synced_at from integration.location_ref where code='HUB'"));

    await as(SYSTEM, (db) =>
      db.query("select integration.upsert_location_ref($1,null,$2,'HUB',$3,$4,'SEED')",
        ["HUB", "Central Hub", 19.1, 72.9]));

    const { rows } = await raw((db) => db.query(
      "select count(*)::int n from integration.location_ref where code='HUB'"));
    assert.equal(rows[0].n, 1, "a second sync must not duplicate the row");

    const second = await raw((db) => db.query(
      "select synced_at from integration.location_ref where code='HUB'"));
    assert.ok(second.rows[0].synced_at >= first.rows[0].synced_at);
  });

  test("a seeded row is marked as a guess", async () => {
    const { rows } = await raw((db) => db.query(
      "select source from integration.location_ref where code='HUB'"));
    assert.equal(rows[0].source, "SEED");
  });
});
