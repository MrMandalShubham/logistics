import { logger } from "./logging";
import { sign } from "./webhooks";

/**
 * The Grocery client.
 *
 * Phase 1 could only ping it: Grocery exposed no HTTP API at all.
 * Phase 5 adds the one endpoint it now has — a signed receiver for
 * delivery status — so a customer can finally watch their order
 * move instead of seeing "Delivered" from the moment they paid.
 *
 * Ingest still travels the other way: Grocery pushes a placed order
 * to us. This file never pulls from Grocery's database, because a
 * second reader of somebody else's tables is a second source of
 * truth wearing a disguise.
 */

export function isConfigured(): boolean {
  return Boolean(process.env.GROCERY_BASE_URL);
}

export class GroceryError extends Error {
  constructor(message: string, readonly status: number | null, readonly code: string) {
    super(message);
    this.name = "GroceryError";
  }
}

export type PushResult = {
  ok: boolean;
  status: number;
  body: unknown;
  /** True when retrying could never help: a bad secret, a rejected shape. */
  fatal: boolean;
};

/**
 * Push one delivery status to Grocery.
 *
 * ── Signed the same way, in the same direction ──
 *
 * `t=<unix>,v1=<hmac over t.body>`, exactly as Grocery signs its
 * inbound order handoff to us and exactly as Inventory signs its
 * webhooks. One scheme across three systems: one thing to learn, one
 * verify() to trust, and no chance of two implementations disagreeing
 * about what a valid signature is.
 *
 * ── What counts as fatal ──
 *
 * 4xx means Grocery understood and refused: a wrong secret, an order
 * it does not have, a payload it will not accept. Retrying that for
 * six attempts burns the queue and changes nothing, so it dies at
 * once and shows up on the health screen where a person sees it.
 *
 * 401/403 is the interesting one — it is almost always a secret
 * mismatch between the two deployments, so it says so.
 */
export async function pushStatus(
  payload: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<PushResult> {
  const base = process.env.GROCERY_BASE_URL;
  const secret = process.env.GROCERY_WEBHOOK_SECRET;

  if (!base || !secret) {
    throw new GroceryError(
      "Grocery is not configured: set GROCERY_BASE_URL and GROCERY_WEBHOOK_SECRET",
      null, "not_configured");
  }

  // Sign the EXACT bytes that are sent. Serialising twice would let a
  // key order change between the signature and the body, which fails
  // in a way that looks like a wrong secret.
  const body = JSON.stringify(payload);
  const { header } = sign(secret, body);

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);

  try {
    const res = await fetch(base.replace(/\/$/, "") + "/api/logistics/status", {
      method: "POST",
      signal: abort.signal,
      headers: {
        "content-type": "application/json",
        "x-logistics-signature": header,
      },
      body,
      cache: "no-store",
    });

    const parsed = await res.json().catch(() => null);

    // 429 is a 4xx that retrying DOES fix.
    const fatal = res.status >= 400 && res.status < 500 && res.status !== 429;

    if (res.status === 401 || res.status === 403) {
      logger.error("grocery rejected our signature", {
        status: res.status,
        hint: "GROCERY_WEBHOOK_SECRET here must equal LOGISTICS_WEBHOOK_SECRET there",
      });
    }

    return { ok: res.ok, status: res.status, body: parsed, fatal };
  } catch (e) {
    const err = e as { name?: string; message?: string };
    // A timeout or a refused connection is Grocery being down, which
    // is exactly what the retry schedule is for.
    throw new GroceryError(
      err?.name === "AbortError" ? "grocery timed out" : (err?.message ?? "grocery unreachable"),
      null, err?.name === "AbortError" ? "timeout" : "unreachable");
  } finally {
    clearTimeout(timer);
  }
}

/** For the deep health check. Never throws; reports. */
export async function ping(): Promise<{ ok: boolean; detail: string; ms: number }> {
  const base = process.env.GROCERY_BASE_URL;
  if (!base) return { ok: false, detail: "not_configured", ms: 0 };

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 4000);
  const t = Date.now();

  try {
    // Grocery has no health endpoint, so this is a liveness probe of
    // the site itself. Any response at all means the deployment is up.
    const res = await fetch(base.replace(/\/$/, "") + "/", {
      signal: abort.signal,
      method: "HEAD",
      cache: "no-store",
    });
    return {
      ok: res.status < 500,
      detail: `HTTP ${res.status}`,
      ms: Date.now() - t,
    };
  } catch (e: any) {
    logger.warn("grocery unreachable", { err: e?.message });
    return {
      ok: false,
      detail: e?.name === "AbortError" ? "timeout" : "unreachable",
      ms: Date.now() - t,
    };
  } finally {
    clearTimeout(timer);
  }
}
