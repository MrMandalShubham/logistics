// Create the first administrator. One time, from a machine that
// already has database access.
//
//   node scripts/admin-create.mjs "admin@example.com" "Full Name"
//
// ── Why this is not an environment variable ──
//
// Inventory has ADMIN_EMAIL / ADMIN_PASSWORD, and its own
// .env.example says the account has "no second factor, no bcrypt work
// factor, and no lockout counter", and that anyone who can read the
// file can sign in as admin. That is a standing backdoor that
// rotation requires a redeploy to close.
//
// This creates a real user row with a real hash, prints a temporary
// password ONCE, and forces a change at first sign-in. Nothing
// remains in the environment afterwards.

import { randomBytes } from "node:crypto";
import pg from "pg";
import { CONNECTION } from "./db-config.mjs";
import { hashPassword } from "../lib/auth/password.ts";

const email = (process.argv[2] ?? "").trim().toLowerCase();
const name = process.argv[3] ?? "System Administrator";

if (!email || !email.includes("@")) {
  console.error('Usage: node scripts/admin-create.mjs "admin@example.com" "Full Name"');
  process.exit(1);
}

// 24 bytes of base64url: long enough that nobody is tempted to keep it.
const temporary = randomBytes(24).toString("base64url");
const hash = await hashPassword(temporary);

const client = new pg.Client({ connectionString: CONNECTION });
await client.connect();

try {
  await client.query("begin");
  await client.query("select set_config('request.jwt.claims', $1, true)",
    [JSON.stringify({ sub: null, role: "system", actor_kind: "SYSTEM" })]);

  const { rows } = await client.query(
    "select identity.create_user($1,$2,'admin',$3,'{}',true) as id",
    [email, name, hash]);

  await client.query("commit");

  console.log(`
  Administrator created.

    email     ${email}
    password  ${temporary}

  This password is shown once and must be changed at first sign-in.
  It is not stored anywhere else and cannot be recovered.
`);
} catch (e) {
  await client.query("rollback").catch(() => {});
  if (e.code === "23505") {
    console.error(`A user with email ${email} already exists.`);
  } else {
    console.error(e.message);
  }
  process.exit(1);
} finally {
  await client.end();
}
