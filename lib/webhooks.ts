import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Webhook signing.
 *
 * Ported verbatim from Inventory Core's lib/webhooks.ts, deliberately.
 * One scheme across the estate means one thing for an integrator to
 * learn, one verify() to trust, and no chance of two subtly different
 * implementations disagreeing about what a valid signature is.
 *
 * ── The timestamp is INSIDE the MAC ──
 *
 * Signing only the body lets anyone who captures one delivery replay
 * it forever. Signing `t.body` means the receiver can reject anything
 * older than a few minutes AND the signature covers the age claim, so
 * the age cannot be edited either.
 */

const VERSION = "v1";

export function sign(secret: string, body: string, at = Date.now()) {
  const t = Math.floor(at / 1000);
  const mac = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return { header: `t=${t},${VERSION}=${mac}`, t, mac };
}

/**
 * Verify a signature header.
 *
 * Returns a reason rather than a bare false, because "your clock is
 * wrong" and "your secret is wrong" are very different afternoons for
 * whoever is integrating.
 */
export function verify(
  secret: string,
  body: string,
  header: string | null,
  toleranceSeconds = 300,
): { ok: true } | { ok: false; reason: string } {
  if (!header) return { ok: false, reason: "signature header missing" };

  let parts: Record<string, string>;
  try {
    parts = Object.fromEntries(
      header.split(",").map((p) => p.split("=").map((x) => x.trim()) as [string, string]));
  } catch {
    return { ok: false, reason: "signature header malformed" };
  }

  const t = Number(parts.t);
  const got = parts[VERSION];
  if (!t || !got) return { ok: false, reason: "signature header malformed" };

  // A replay of a genuine, correctly-signed delivery is still a
  // replay. Age is part of validity.
  const drift = Math.abs(Date.now() / 1000 - t);
  if (drift > toleranceSeconds) {
    return {
      ok: false,
      reason: `timestamp is ${Math.round(drift)}s away from ours (tolerance ${toleranceSeconds}s)`,
    };
  }

  const want = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  const a = Buffer.from(want, "hex");
  const b = Buffer.from(got, "hex");

  // Length check first: timingSafeEqual throws on a mismatch, and a
  // throw here would read as "invalid" anyway but noisily.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "signature does not match" };
  }
  return { ok: true };
}
