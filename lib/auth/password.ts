import { scrypt, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Password hashing with scrypt from node:crypto.
 *
 * Not bcrypt. scrypt is in the standard library, so there is no
 * native module to compile on a developer's Windows laptop and no
 * extra package in the supply chain of a system that will hold
 * customer addresses. It is memory-hard, which is the property that
 * matters against a GPU.
 *
 * Stored as: scrypt$N$r$p$<salt hex>$<hash hex>
 * The parameters travel with the hash, so raising them later does not
 * lock out everybody hashed under the old ones.
 */

const KEYLEN = 64;
const MAXMEM = 256 * 1024 * 1024;

/**
 * Read a numeric setting, treating an empty value as absent.
 *
 * `process.env.X ?? default` does NOT fall back for an empty string,
 * and `Number("")` is 0 — so a variable that exists in a dashboard
 * with nothing typed into it silently becomes zero. That is how the
 * cost floor below came to reject a perfectly normal deployment.
 */
function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * The cost parameters, resolved on FIRST USE.
 *
 * ── Why not at module scope ──
 *
 * This check used to run when the module loaded, and it threw. That
 * meant importing this file — which `next build` does for every route
 * that touches authentication — required the environment to be fully
 * configured. The build failed on a host that supplies variables at
 * runtime:
 *
 *     Failed to collect page data for /api/v1/auth/password
 *     SCRYPT_N is 0, below the floor of 16384.
 *
 * The refusal itself is right and stays: hashing passwords weakly and
 * discovering it after a breach is the outcome it exists to prevent.
 * It just belongs at the moment a password is actually hashed, not at
 * the moment a file is read.
 */
let resolved: { N: number; R: number; P: number } | undefined;

function params(): { N: number; R: number; P: number } {
  if (resolved) return resolved;

  const N = envNumber("SCRYPT_N", 16384);   // CPU/memory cost
  const R = envNumber("SCRYPT_R", 8);
  const P = envNumber("SCRYPT_P", 1);

  if (N < 16384) {
    throw new Error(
      `SCRYPT_N is ${N}, below the floor of 16384. Refusing to hash a password ` +
        "weakly and discover it after a breach. Leave it unset for the default.",
    );
  }

  resolved = { N, R, P };
  return resolved;
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12) {
    throw new Error("PASSWORD_TOO_SHORT: use at least 12 characters");
  }
  const { N, R, P } = params();
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

/**
 * Verify. Returns a boolean and never throws on a malformed stored
 * value -- a corrupt row must read as "wrong password", not as a 500
 * that tells the caller this account is special.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [scheme, n, r, p, saltHex, hashHex] = stored.split("$");
    if (scheme !== "scrypt") return false;

    const salt = Buffer.from(saltHex, "hex");
    const want = Buffer.from(hashHex, "hex");
    const got = await scryptAsync(password, salt, want.length, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: MAXMEM,
    });
    return got.length === want.length && timingSafeEqual(got, want);
  } catch {
    return false;
  }
}
