import { logger } from "./logging";

/**
 * The Inventory Core client.
 *
 * ── What this file may and may not do ──
 *
 * Phase 1 reads locations and nothing else. The key it uses holds
 * `stock:read` and nothing else, so even a leak of this process's
 * environment gives somebody a list of shop names.
 *
 * The write calls -- confirm a hold, commit on delivery, release on
 * return -- arrive in Phase 2, together with the code that calls
 * them. They are deliberately NOT stubbed here: Grocery defines
 * commitInventory, releaseInventory and orderStatus and calls none of
 * them, and that is precisely why stock is never consumed anywhere in
 * this estate today. A method with no caller is a promise nobody
 * keeps.
 */

export type InventoryLocation = {
  id: string;
  uuid?: string;
  name: string;
  type?: string;
  code?: string;
  products_in_stock?: number;
};

export class InventoryError extends Error {
  constructor(message: string, readonly status: number | null, readonly code?: string) {
    super(message);
    this.name = "InventoryError";
  }
}

export function isConfigured(): boolean {
  return Boolean(process.env.INVENTORY_API_URL && process.env.INVENTORY_API_KEY);
}

async function call<T>(path: string, timeoutMs = 8000): Promise<T> {
  const base = process.env.INVENTORY_API_URL;
  const key = process.env.INVENTORY_API_KEY;

  if (!base || !key) {
    throw new InventoryError(
      "Inventory is not configured: set INVENTORY_API_URL and INVENTORY_API_KEY.",
      null, "not_configured");
  }

  // A slow upstream must not hold a connection open indefinitely.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);

  try {
    const res = await fetch(base.replace(/\/$/, "") + path, {
      signal: abort.signal,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      cache: "no-store",
    });

    const body = await res.json().catch(() => null);

    if (!res.ok) {
      throw new InventoryError(
        body?.message ?? `Inventory responded ${res.status}`,
        res.status,
        body?.error);
    }
    return body as T;
  } catch (e: any) {
    if (e instanceof InventoryError) throw e;
    throw new InventoryError(
      e?.name === "AbortError" ? `Inventory timed out after ${timeoutMs}ms` : String(e?.message ?? e),
      null, "unreachable");
  } finally {
    clearTimeout(timer);
  }
}

/** The shops and hubs we may collect parcels from. */
export async function getLocations(): Promise<InventoryLocation[]> {
  return call<InventoryLocation[]>("/api/locations");
}

export type HoldStatus = "held" | "delivered" | "released" | "unknown";

export type OrderHold = {
  status: HoldStatus;
  /** The soonest line expiry, or null when nothing is holding. */
  expiresAt: string | null;
  items: { sku: string; quantity: number; status: string; expires_at: string | null }[];
  /** Set when Inventory could not be consulted at all. */
  unreachable?: string;
};

/**
 * What Inventory says about an order's hold.
 *
 * Used at ingest to check the goods are really allocated before a
 * delivery is created. `held` is the only answer that means yes.
 *
 * ── Three outcomes, deliberately distinguished ──
 *
 *   held/delivered/released  Inventory answered. Trust it.
 *   404                      nothing was ever reserved -> released
 *   unreachable              we do not know, and must not guess
 *
 * The third is why this returns rather than throws. Refusing every
 * order because Inventory is having a bad minute would turn an
 * Inventory blip into a Grocery outage; the delivery is created,
 * flagged `unknown`, and surfaced to a dispatcher instead.
 *
 * ── Why expiresAt matters ──
 *
 * A hold lapses after 30 minutes by default, and logistics cannot
 * call confirm (open question Q4: reserve returns reservation ids and
 * nothing else ever does). Recording the expiry is what lets the
 * expiry report warn an operator before a rider is standing in a shop
 * holding nothing.
 */
export async function getOrderHold(externalOrderId: string): Promise<OrderHold> {
  try {
    const body = await call<{
      order_id: string;
      status: HoldStatus;
      items: { sku: string; quantity: number; status: string; expires_at: string | null }[];
    }>(`/api/inventory/order/${encodeURIComponent(externalOrderId)}`);

    const expiries = (body.items ?? [])
      .map((i) => i.expires_at)
      .filter((e): e is string => Boolean(e))
      .sort();

    return {
      status: body.status,
      expiresAt: expiries[0] ?? null,
      items: body.items ?? [],
    };
  } catch (e: any) {
    // 404 is a real answer: nothing was ever reserved for this order.
    if (e instanceof InventoryError && e.status === 404) {
      return { status: "released", expiresAt: null, items: [] };
    }

    logger.warn("inventory hold check failed", {
      external_order_id: externalOrderId, err: e?.message, code: e?.code,
    });

    return {
      status: "unknown",
      expiresAt: null,
      items: [],
      unreachable: e?.code ?? "unreachable",
    };
  }
}

/** For the deep health check. Never throws; reports. */
export async function ping(): Promise<{ ok: boolean; detail: string; ms: number }> {
  if (!isConfigured()) return { ok: false, detail: "not_configured", ms: 0 };

  const t = Date.now();
  try {
    await call<unknown>("/api/health", 4000);
    return { ok: true, detail: "reachable", ms: Date.now() - t };
  } catch (e: any) {
    logger.warn("inventory unreachable", { err: e?.message });
    return { ok: false, detail: e?.code ?? "unreachable", ms: Date.now() - t };
  }
}
