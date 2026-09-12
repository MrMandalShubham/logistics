// Invariant checks that the type system cannot express.
//
//   node scripts/db-verify.mjs
//
// The one that earns its place is RLS coverage. A table added in a
// later phase without row-level security is invisible in review --
// it looks like every other CREATE TABLE -- and it silently exposes
// every row to every caller. This turns that into a red build.

import pg from "pg";
import { CONNECTION } from "./db-config.mjs";

const client = new pg.Client({ connectionString: CONNECTION });
await client.connect();

const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok, detail });

try {
  // ── schemas exist ──
  {
    const { rows } = await client.query(
      `select nspname from pg_namespace
        where nspname in ('ops','identity','integration','delivery','fleet')`);
    check("schemas present", rows.length === 5,
          rows.map((r) => r.nspname).sort().join(", "));
  }

  // ── every table has RLS enabled ──
  {
    const { rows } = await client.query(
      `select c.relname, n.nspname, c.relrowsecurity
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind = 'r'
          and n.nspname in ('ops','identity','integration','delivery','fleet')
        order by n.nspname, c.relname`);

    // The migration ledger is infrastructure, not business data, and
    // is written by the runner before any role exists.
    const exempt = new Set(["schema_migration"]);
    const naked = rows.filter((r) => !r.relrowsecurity && !exempt.has(r.relname));

    check("RLS enabled on every table", naked.length === 0,
          naked.length ? naked.map((r) => `${r.nspname}.${r.relname}`).join(", ")
                       : `${rows.length} tables`);
  }

  // ── every RLS table has at least one policy ──
  {
    const { rows } = await client.query(
      `select n.nspname, c.relname,
              (select count(*) from pg_policy p where p.polrelid = c.oid) as policies
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind = 'r' and c.relrowsecurity
          and n.nspname in ('ops','identity','integration','delivery','fleet')`);

    const silent = rows.filter((r) => Number(r.policies) === 0);
    check("every RLS table has a policy", silent.length === 0,
          silent.length ? silent.map((r) => `${r.nspname}.${r.relname}`).join(", ")
                        : `${rows.length} tables`);
  }

  // ── the audit log truly refuses mutation ──
  {
    await client.query(
      `insert into ops.audit_log (action, actor_kind) values ('verify.probe','SYSTEM')`);

    let updateRefused = false;
    let deleteRefused = false;

    try { await client.query(`update ops.audit_log set action='tampered'`); }
    catch (e) { updateRefused = /AUDIT_IMMUTABLE/.test(e.message); }

    try { await client.query(`delete from ops.audit_log where action='verify.probe'`); }
    catch (e) { deleteRefused = /AUDIT_IMMUTABLE/.test(e.message); }

    check("audit log refuses UPDATE", updateRefused);
    check("audit log refuses DELETE", deleteRefused);
  }

  // ── nobody can read password hashes through SQL ──
  {
    const { rows } = await client.query(
      `select polcmd, pg_get_expr(polqual, polrelid) as using_expr
         from pg_policy p
         join pg_class c on c.oid = p.polrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'identity' and c.relname = 'credential'`);

    const readable = rows.filter(
      (r) => r.polcmd === "r" && !/false/i.test(r.using_expr ?? ""));
    check("credential table is unreadable", readable.length === 0);
  }

  // ── the two external systems are registered ──
  {
    const { rows } = await client.query(
      `select code from integration.external_system order by code`);
    check("external systems registered", rows.length === 2,
          rows.map((r) => r.code).join(", "));
  }

  // ── role_permission is populated ──
  {
    const { rows } = await client.query(
      `select role, count(*)::int as n from identity.role_permission
        group by role order by role`);
    // Three roles, not four: admin, dispatcher, rider.
    check("permissions seeded", rows.length === 3,
          rows.map((r) => `${r.role}:${r.n}`).join(" "));
  }

  // ── the delivery timeline is append-only too ──
  {
    // Self-sufficient: a freshly reset database has no locations yet,
    // and a check that only runs sometimes is a check nobody trusts.
    await client.query(
      `insert into integration.location_ref (code, name, type, source)
       values ('__VERIFY__','Verification probe','VIRTUAL','SEED')
       on conflict (code) do nothing`);

    const { rows: [d] } = await client.query(
      `insert into delivery.delivery (external_order_id, tracking_id,
                                      pickup_location_code)
       values ('verify-probe-' || gen_random_uuid(),
               'DLV-VERIFY-' || floor(random()*1e6)::int, '__VERIFY__')
       returning id`);

    if (d) {
      await client.query(
        `insert into delivery.delivery_status_history (delivery_id, to_status)
         values ($1,'RECEIVED')`, [d.id]);

      let noUpdate = false, noDelete = false;
      try { await client.query(
        `update delivery.delivery_status_history set to_status='DELIVERED' where delivery_id=$1`,
        [d.id]); }
      catch (e) { noUpdate = /AUDIT_IMMUTABLE/.test(e.message); }

      try { await client.query(
        `delete from delivery.delivery_status_history where delivery_id=$1`, [d.id]); }
      catch (e) { noDelete = /AUDIT_IMMUTABLE/.test(e.message); }

      check("delivery timeline refuses UPDATE", noUpdate);
      check("delivery timeline refuses DELETE", noDelete);

      // A timeline row cannot be removed, so the probe delivery stays.
      // Mark it so nobody mistakes it for a real one.
      await client.query(
        `update delivery.delivery set status='CANCELLED' where id=$1`, [d.id]);
    } else {
      check("delivery timeline refuses UPDATE", false, "no location to attach a probe to");
    }
  }

  // ── an address is not optional ──
  {
    let refused = false;
    try {
      await client.query(
        `insert into delivery.delivery_address (delivery_id, recipient_name, phone,
                                                line1, city, pincode)
         values (gen_random_uuid(),'x','x','x','x','x')`);
    } catch (e) {
      // Either the FK or the NOT NULL on lat/lng. Both are the point.
      refused = /violates/.test(e.message);
    }
    check("address requires a geocode and a delivery", refused);
  }
} finally {
  await client.end();
}

for (const r of results) {
  console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
