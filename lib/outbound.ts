import type { PoolClient } from "pg";
import { logger } from "./logging";
import { InventoryError, getOrderHold } from "./inventory";
import { pushStatus } from "./grocery";

/**
 * The outbound queue worker.
 *
 * The database owns the queue — claiming, backoff, dead-lettering,
 * reclaiming after a crash. This file is only the part Postgres
 * cannot do: making an HTTP request.
 *
 * Same split as Inventory's own webhook worker, and for the same
 * reason: everything that decides *whether* and *when* a delivery
 * happens is testable in SQL and survives this process being killed
 * halfway through.
 */

export type Job = {
  id: string;
  target: "INVENTORY" | "GROCERY";
  event: string;
  payload: Record<string, unknown>;
  attempts: number;
  delivery_id: string | null;
};

export type Outcome = {
  ok: boolean;
  error?: string;
  response?: unknown;
  /** True when retrying could never help. Goes straight to DEAD. */
  fatal?: boolean;
};

export type DrainResult = {
  claimed: number; delivered: number; retrying: number; dead: number;
};

async function post(path: string, body: unknown, timeoutMs = 10_000) {
  const base = process.env.INVENTORY_API_URL;
  const key = process.env.INVENTORY_API_KEY;
  if (!base || !key) throw new InventoryError("Inventory is not configured", null, "not_configured");

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetch(base.replace(/\/$/, "") + path, {
      method: "POST",
      signal: abort.signal,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const parsed = await res.json().catch(() => null);
    return { status: res.status, ok: res.ok, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Commit a delivered order to Inventory — and then CHECK.
 *
 * ── Why the second call is not optional ──
 *
 * POST /api/inventory/commit answers
 *
 *   { ok: true, already_committed: true }
 *
 * when the reservations were CONSUMED **and** when they were
 * RELEASED. Those are opposite facts. The first means the sale is on
 * the ledger; the second means the stock was never reduced and
 * somebody is now short.
 *
 * Trusting that response would mean recording a sale that did not
 * happen, silently, forever. So every commit is followed by a read,
 * and only `status === "delivered"` counts as done.
 *
 * A released hold is FATAL: retrying cannot bring it back. It needs a
 * person, so it stops being a queue item and becomes an exception.
 */
async function commitToInventory(job: Job): Promise<Outcome> {
  const orderId = String(job.payload.order_id ?? "");
  if (!orderId) return { ok: false, error: "no order_id in payload", fatal: true };

  try {
    const commit = await post("/api/inventory/commit", { order_id: orderId });

    if (!commit.ok) {
      // 4xx from Inventory will not fix itself; 5xx might.
      const fatal = commit.status >= 400 && commit.status < 500 && commit.status !== 429;
      return {
        ok: false,
        error: `commit returned ${commit.status}: ${JSON.stringify(commit.body)}`,
        response: commit.body,
        fatal,
      };
    }

    // ── the verification ──
    const hold = await getOrderHold(orderId);

    if (hold.status === "delivered") {
      const ledgerIds = (commit.body?.items ?? [])
        .map((i: { ledger_entry_id?: number }) => i.ledger_entry_id)
        .filter(Boolean);

      return { ok: true, response: { commit: commit.body, ledger_ids: ledgerIds } };
    }

    if (hold.status === "released") {
      // The one that must be loud. Inventory said "already committed"
      // and its own status says the stock went back on the shelf.
      return {
        ok: false,
        fatal: true,
        error:
          `INVENTORY_HOLD_LOST: commit reported success but the hold for ${orderId} ` +
          "is released — the stock was never reduced. A person must reconcile this.",
        response: { commit: commit.body, verified_status: hold.status },
      };
    }

    // Still 'held', or Inventory could not be reached for the check.
    return {
      ok: false,
      error: `commit not verified: inventory reports "${hold.status}"`,
      response: { commit: commit.body, verified_status: hold.status },
    };
  } catch (e) {
    const err = e as { message?: string };
    return { ok: false, error: err?.message ?? String(e) };
  }
}

/**
 * Tell Grocery where a customer's order has got to.
 *
 * ── Why a failure here is quiet, and a commit failure is not ──
 *
 * A failed commit means Inventory's ledger disagrees with the world:
 * stock that left a building was never recorded as sold. That needs a
 * person.
 *
 * A failed status push means an order page is stale. It is worth
 * retrying, worth showing on the health screen, and worth nobody's
 * pager. The parcel still arrived. So this returns an outcome and
 * lets the queue's own schedule handle it, and never raises an
 * exception against the delivery.
 */
async function pushStatusToGrocery(job: Job): Promise<Outcome> {
  try {
    const res = await pushStatus(job.payload);

    if (res.ok) return { ok: true, response: res.body };

    return {
      ok: false,
      error: `grocery returned ${res.status}: ${JSON.stringify(res.body)}`,
      response: res.body,
      fatal: res.fatal,
    };
  } catch (e) {
    const err = e as { message?: string; code?: string };
    return {
      ok: false,
      error: err?.message ?? String(e),
      // Unconfigured is not a transient fault, but it is one a person
      // fixes in an env file — so it retries rather than dying, and
      // the queue drains itself once the variable is set.
      fatal: false,
    };
  }
}

async function deliverOne(job: Job): Promise<Outcome> {
  if (job.target === "INVENTORY" && job.event === "inventory.commit") {
    return commitToInventory(job);
  }
  if (job.target === "GROCERY" && job.event === "delivery.status_changed") {
    return pushStatusToGrocery(job);
  }
  return { ok: false, error: `no handler for ${job.target}/${job.event}`, fatal: true };
}

/**
 * One pass over the queue.
 *
 * Jobs go out concurrently: one slow upstream must not delay
 * everybody else's events.
 */
export async function drainOnce(
  db: PoolClient,
  { batch = 20, worker = "worker" } = {},
): Promise<DrainResult> {
  // Rows abandoned by a worker that died mid-flight. Cheap, and
  // without it one crash strands those events forever.
  await db.query("select integration.requeue_stuck_outbound()");

  const { rows } = await db.query(
    "select * from integration.claim_outbound_batch($1,$2)", [batch, worker]);

  const out: DrainResult = { claimed: rows.length, delivered: 0, retrying: 0, dead: 0 };
  if (!rows.length) return out;

  const results = await Promise.all(
    (rows as Job[]).map(async (job) => ({ job, outcome: await deliverOne(job) })));

  for (const { job, outcome } of results) {
    const { rows: [state] } = await db.query(
      "select integration.record_outbound_result($1,$2,$3,$4::jsonb,$5) as s",
      [job.id, outcome.ok, outcome.error ?? null,
       outcome.response ? JSON.stringify(outcome.response) : null,
       outcome.fatal ?? false]);

    // The notification log follows the queue row's fate. Through a
    // definer function, because ops.notification has a SELECT policy
    // and no UPDATE policy: a direct write from here would match zero
    // rows and report success, and a log that silently stops being
    // written is worse than no log, because it is believed.
    if (job.target === "GROCERY" && (outcome.ok || state.s === "DEAD")) {
      await db.query("select ops.record_notification_result($1,$2,$3)",
        [job.id, outcome.ok, outcome.error ?? null]);
    }

    if (outcome.ok) {
      out.delivered += 1;

      if (job.delivery_id && job.event === "inventory.commit") {
        const ledgerIds = (outcome.response as { ledger_ids?: unknown })?.ledger_ids ?? null;

        // Through a definer function, not a direct UPDATE.
        // delivery.delivery has no UPDATE policy on purpose — status
        // moves through delivery.transition and nowhere else — so a
        // direct write from here is refused, as it should be.
        await db.query(
          "select delivery.record_commit_result($1,'verified',$2::jsonb,null,null)",
          [job.delivery_id, ledgerIds ? JSON.stringify(ledgerIds) : null]);

        logger.info("commit verified", {
          delivery_id: job.delivery_id, order: job.payload.order_id,
        });
      }
    } else if (state.s === "DEAD") {
      out.dead += 1;

      // A dead commit is a stock discrepancy, not a queue statistic.
      if (job.delivery_id) {
        await db.query(
          "select delivery.record_commit_result($1,'failed',null,$2,$3)",
          [job.delivery_id,
           outcome.error?.startsWith("INVENTORY_HOLD_LOST")
             ? "INVENTORY_HOLD_LOST" : "COMMIT_FAILED",
           outcome.error ?? null]);
      }

      logger.error("outbound job dead", {
        id: job.id, target: job.target, event: job.event, err: outcome.error,
      });
    } else {
      out.retrying += 1;
    }
  }

  return out;
}
