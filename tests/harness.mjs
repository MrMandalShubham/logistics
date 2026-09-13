import pg from "pg";
import { CONNECTION, PG } from "../scripts/db-config.mjs";

/**
 * Test harness.
 *
 * Every test runs through withClaims-equivalent plumbing, so the
 * suite exercises the SAME row-level security path a real request
 * takes. A test that bypasses RLS proves nothing about production.
 */

export const pool = new pg.Pool({ ...PG, max: 4 });
pool.on("error", () => {});

export const SYSTEM = { sub: null, role: "system", actor_kind: "SYSTEM", location_codes: [] };

/** Run as a given claim set, inside a transaction, with RLS applied. */
export async function as(claims, fn) {
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify(claims),
    ]);
    await db.query("set local role authenticated");
    const out = await fn(db);
    await db.query("commit");
    return out;
  } catch (e) {
    await db.query("rollback").catch(() => {});
    throw e;
  } finally {
    db.release();
  }
}

/** Run without the role switch, for setup that predates any identity. */
export async function raw(fn) {
  const db = await pool.connect();
  try {
    return await fn(db);
  } finally {
    db.release();
  }
}

/** Assert that a promise rejects with a message matching a pattern. */
export async function refuses(fn, pattern) {
  try {
    await fn();
  } catch (e) {
    if (pattern && !pattern.test(e.message)) {
      throw new Error(`Refused, but with the wrong error.\n  want ${pattern}\n  got  ${e.message}`);
    }
    return e;
  }
  throw new Error(`Expected a refusal${pattern ? ` matching ${pattern}` : ""}, but it succeeded.`);
}

/** Wipe business data between suites, leaving the schema in place. */
export async function truncateAll() {
  await raw(async (db) => {
    await db.query(`
      truncate identity.session, identity.credential, identity.app_user,
               integration.idempotency_record, integration.api_client
        restart identity cascade;
    `);
    // The audit log cannot be truncated by policy in normal operation;
    // here we are the owner, outside RLS, resetting a test database.
    await db.query("alter table ops.audit_log disable trigger audit_log_no_delete");
    await db.query("delete from ops.audit_log");
    await db.query("alter table ops.audit_log enable trigger audit_log_no_delete");
  });
}

export async function closePool() {
  await pool.end();
}
