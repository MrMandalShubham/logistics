import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Load .env without a dependency.
 *
 * Deliberately does NOT overwrite a variable already in the
 * environment: CI sets DATABASE_URL directly, and a stale .env file
 * silently winning over it is a very confusing afternoon.
 */
export function loadEnv(file = ".env") {
  const path = join(ROOT, file);
  if (!existsSync(path)) return;

  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadEnv();

export const CONNECTION =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:55433/logistics_core";

/**
 * TLS for anything that is not on this machine.
 *
 * Managed Postgres presents a certificate signed by its own
 * authority, which Node's trust store does not carry — so
 * `?sslmode=require` connects and then dies with "self-signed
 * certificate in certificate chain". Encrypted but unauthenticated
 * is the standard posture for these providers; see lib/db.ts for
 * what that costs and how to do it properly with a CA bundle.
 *
 * Every script spreads PG rather than passing CONNECTION directly,
 * so there is one place this rule lives.
 */
export const SSL =
  /@(localhost|127\.0\.0\.1|\[::1\]|host\.docker\.internal)[:/]/.test(CONNECTION)
    ? undefined
    : { rejectUnauthorized: false };

export const PG = { connectionString: CONNECTION, ssl: SSL };

export const MIGRATIONS_DIR = join(ROOT, "db", "migrations");

/** Refuse to touch anything that looks like production. */
export function assertNotProduction(action) {
  if (process.env.ALLOW_DESTRUCTIVE === "true") return;
  const url = CONNECTION;
  const local = /(127\.0\.0\.1|localhost|host\.docker\.internal)/.test(url);
  if (!local) {
    throw new Error(
      `Refusing to ${action}: DATABASE_URL does not look local.\n` +
      `  ${url.replace(/:\/\/[^@]*@/, "://***@")}\n` +
      "Set ALLOW_DESTRUCTIVE=true if you genuinely mean it.",
    );
  }
}
