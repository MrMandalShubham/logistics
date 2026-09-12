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

const N = Number(process.env.SCRYPT_N ?? 16384); // CPU/memory cost
const R = Number(process.env.SCRYPT_R ?? 8);
const P = Number(process.env.SCRYPT_P ?? 1);
const KEYLEN = 64;
const MAXMEM = 256 * 1024 * 1024;

if (N < 16384) {
  throw new Error(
    `SCRYPT_N is ${N}, below the floor of 16384. Refusing to start rather than ` +
      "hashing passwords weakly and discovering it after a breach.",
  );
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12) {
    throw new Error("PASSWORD_TOO_SHORT: use at least 12 characters");
  }
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
