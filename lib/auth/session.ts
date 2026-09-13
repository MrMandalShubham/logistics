import { randomBytes, createHash } from "node:crypto";
import { envNumber } from "../env";

/**
 * Session cookies.
 *
 * The cookie value is 32 random bytes. Only its SHA-256 is stored, so
 * a database backup is a list of hashes rather than a set of live
 * logins.
 */

export const COOKIE_NAME = "lg_session";

/**
 * Staff sign in for a working day; riders for a working week.
 *
 * Through envNumber, because a blank SESSION_TTL_STAFF_SECONDS in a
 * hosting dashboard used to become 0 — and a cookie with Max-Age=0
 * expires the instant it is set. Sign-in returned 200 with a valid
 * session, and then every page said "you are not signed in", which is
 * about as far from the cause as a symptom can get.
 */
export function ttlSeconds(role: string): number {
  return role === "rider"
    ? envNumber("SESSION_TTL_RIDER_SECONDS", 60 * 60 * 24 * 7)
    : envNumber("SESSION_TTL_STAFF_SECONDS", 60 * 60 * 12);
}

export function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function cookieOptions(maxAgeSeconds: number) {
  return {
    name: COOKIE_NAME,
    httpOnly: true,
    sameSite: "lax" as const,
    // Secure everywhere except plain-HTTP local development, where it
    // would simply prevent signing in.
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: maxAgeSeconds,
  };
}
