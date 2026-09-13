/**
 * Reading configuration without being lied to.
 *
 * ── The bug this exists to stop ──
 *
 * A variable that exists in a hosting dashboard with nothing typed
 * into it is an EMPTY STRING, not undefined. And:
 *
 *     process.env.X ?? 42     →  ""     (?? only catches null/undefined)
 *     Number("")              →  0
 *
 * So a blank field silently becomes zero. That is not theoretical; it
 * shipped three times in one afternoon, each time as a different
 * symptom that looked like something else entirely:
 *
 *   SCRYPT_N=""                  a build failure claiming the password
 *                                cost was below the safe floor
 *
 *   SESSION_TTL_STAFF_SECONDS="" sign-in succeeded and then every page
 *                                said "you are not signed in", because
 *                                the cookie went out with Max-Age=0
 *
 *   PG_CONNECT_TIMEOUT_MS=""     no connect timeout at all, so a
 *                                network problem hangs instead of
 *                                failing
 *
 * The third one is the character of the whole class: the wrong value
 * is plausible, nothing errors, and the symptom appears somewhere far
 * away from the cause.
 */

/** Blank, whitespace and unparseable all mean "not set". */
export function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Blank and whitespace mean "not set". */
export function envString(name: string, fallback?: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw.trim();
}
