import { logger } from "./logging";

/**
 * The Grocery client.
 *
 * Phase 1 only checks that Grocery is reachable, so an operator can
 * see both halves of the estate on one health screen.
 *
 * ── Why there is nothing else here yet ──
 *
 * Grocery exposes no HTTP API at all: there is no app/api directory
 * in that repository. Until it gains a status receiver (open question
 * Q3), logistics cannot push a delivery status to it, and until an
 * order carries a delivery address (Q1) there is nothing to ingest.
 *
 * Those are not gaps we can close from this side, and writing
 * speculative client code against an endpoint nobody has agreed to
 * would be guessing in a file that looks like fact.
 */

export function isConfigured(): boolean {
  return Boolean(process.env.GROCERY_BASE_URL);
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
