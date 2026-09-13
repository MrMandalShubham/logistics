import { randomUUID } from "node:crypto";

/**
 * The outbox — pure.
 *
 * ── Why this file has no IndexedDB and no fetch ──
 *
 * Offline sync is where the subtle bugs live, and it is normally the
 * part a test harness cannot reach. So everything that DECIDES
 * anything — ordering, deduplication, retry, staleness, what to drop —
 * lives here as plain functions over plain objects, and is tested in
 * `node --test` alongside the rest of the system.
 *
 * What is left untested is a thin IndexedDB adapter and a cache
 * policy. That is a deliberate shrinking of the untested surface, not
 * an accident of structure.
 */

export type RiderAction = "step" | "complete" | "fail" | "location";

export type OutboxEvent = {
  /** Generated HERE, at capture. It is the idempotency key. */
  client_event_id: string;
  delivery_id: string;
  action: RiderAction;
  payload: Record<string, unknown>;
  /** When the rider tapped, in ISO. */
  captured_at: string;
  /** Monotonic per device, to break ties when two taps share a millisecond. */
  seq: number;
  attempts: number;
  last_error?: string;
};

export type SyncResult = {
  client_event_id: string;
  status: "APPLIED" | "NOOP" | "CONFLICT" | "REJECTED";
  conflict_code?: string | null;
  message?: string;
};

/** Create an event. The id and the timestamp are fixed at capture. */
export function createEvent(
  action: RiderAction,
  deliveryId: string,
  payload: Record<string, unknown>,
  seq: number,
  now: Date = new Date(),
): OutboxEvent {
  return {
    client_event_id: randomUUID(),
    delivery_id: deliveryId,
    action,
    payload,
    captured_at: now.toISOString(),
    seq,
    attempts: 0,
  };
}

/**
 * The order events must be applied in.
 *
 * Capture time first, then the device sequence. A phone that
 * reconnects mid-journey may send "arrived" before "picked up"
 * depending on how the queue was drained; replaying them in the order
 * they HAPPENED is what makes the server's state machine agree with
 * reality.
 */
export function orderForSync(events: OutboxEvent[]): OutboxEvent[] {
  return [...events].sort((a, b) => {
    const t = Date.parse(a.captured_at) - Date.parse(b.captured_at);
    return t !== 0 ? t : a.seq - b.seq;
  });
}

/**
 * Remove duplicates by event id, keeping the first.
 *
 * A device that crashes mid-write can leave the same event twice. The
 * server would deduplicate anyway, but sending it twice wastes a
 * round trip on a connection that is already poor.
 */
export function dedupe(events: OutboxEvent[]): OutboxEvent[] {
  const seen = new Set<string>();
  return events.filter((e) => {
    if (seen.has(e.client_event_id)) return false;
    seen.add(e.client_event_id);
    return true;
  });
}

/**
 * How long to wait before trying this event again.
 *
 * Capped at five minutes: a rider's phone finds signal in bursts, and
 * an hour-long backoff would mean a delivery completed at 14:00
 * reporting at 15:00 because the one retry fell in a tunnel.
 */
export function nextBackoffMs(attempts: number): number {
  return Math.min(2 ** Math.max(0, attempts) * 1000, 5 * 60_000);
}

/** Older than the window means somebody should be told. */
export function isStale(
  event: OutboxEvent,
  now: Date = new Date(),
  hours = 24,
): boolean {
  return now.getTime() - Date.parse(event.captured_at) > hours * 3_600_000;
}

/**
 * What to send next.
 *
 * Offline sends nothing. Otherwise: deduplicated, in capture order,
 * skipping anything still inside its backoff, and capped so a
 * fortnight of accumulated events does not arrive as one enormous
 * request on a weak connection.
 */
export function planSync(
  events: OutboxEvent[],
  { online, now = new Date(), limit = 25 }: { online: boolean; now?: Date; limit?: number },
): OutboxEvent[] {
  if (!online) return [];

  const ready = dedupe(events).filter((e) => {
    if (e.attempts === 0) return true;
    const lastTried = Date.parse(e.captured_at);
    return now.getTime() - lastTried >= nextBackoffMs(e.attempts);
  });

  return orderForSync(ready).slice(0, limit);
}

/**
 * Fold the server's answers back into the outbox.
 *
 * ── The rule ──
 *
 * An event is removed only when the server has taken responsibility
 * for it: APPLIED, NOOP, CONFLICT or REJECTED are all definite
 * answers. Anything with no answer STAYS — a dropped event is a
 * delivery nobody can account for, and a duplicate is merely a wasted
 * request the server will recognise.
 *
 * Conflicts leave the outbox but are handed back for the rider to be
 * told about. Silently discarding one would mean a rider believing
 * they delivered something the system does not think they did.
 */
export function applyResults(
  events: OutboxEvent[],
  results: SyncResult[],
): { remaining: OutboxEvent[]; conflicts: SyncResult[]; applied: number } {
  const byId = new Map(results.map((r) => [r.client_event_id, r]));

  const remaining: OutboxEvent[] = [];
  const conflicts: SyncResult[] = [];
  let applied = 0;

  for (const e of events) {
    const r = byId.get(e.client_event_id);

    if (!r) {
      // No answer. Keep it and count the attempt.
      remaining.push({ ...e, attempts: e.attempts + 1 });
      continue;
    }

    if (r.status === "APPLIED" || r.status === "NOOP") {
      applied += 1;
      continue;
    }

    // CONFLICT or REJECTED: the server has ruled. Do not retry it —
    // retrying would not change the answer — but do not hide it either.
    conflicts.push(r);
  }

  return { remaining, conflicts, applied };
}

/** What the rider's screen should say about one delivery. */
export function pendingFor(events: OutboxEvent[], deliveryId: string): OutboxEvent[] {
  return orderForSync(events.filter((e) => e.delivery_id === deliveryId));
}

/**
 * Whether a delivery is waiting to sync.
 *
 * The screen says "waiting to sync", never "delivered", until the
 * server has agreed. It must not tell a rider something the system
 * does not yet know.
 */
export function isAwaitingSync(events: OutboxEvent[], deliveryId: string): boolean {
  return events.some((e) => e.delivery_id === deliveryId);
}

export type SignOutPlan = {
  /** Safe to wipe: nothing here that the server has not already seen. */
  safe: boolean;
  /** Events that would be destroyed. */
  unsent: number;
  /** Deliveries they belong to, for a warning a rider can act on. */
  deliveries: string[];
  warning: string | null;
};

/**
 * What signing out would cost.
 *
 * ── Why sign-out clears the outbox at all ──
 *
 * The outbox holds customers' names, addresses and door instructions.
 * A rider handing a shared phone to the next shift must not hand over
 * yesterday's delivery round with it. So signing out wipes it.
 *
 * ── Why it is not simply `store.clear()` ──
 *
 * Wiping unsynced events destroys the only record that a delivery
 * happened. Phase 4b's whole rule was that an unanswered event stays,
 * because a dropped event is a parcel nobody can account for. A
 * sign-out button that silently discards three completed deliveries
 * would break that rule more thoroughly than any bug, and it would do
 * it on purpose.
 *
 * So the caller syncs first, and if anything survives the sync the
 * rider is told exactly what they are about to lose and has to say so
 * again. Their choice, made knowingly — not ours, made quietly.
 */
export function planSignOut(events: OutboxEvent[]): SignOutPlan {
  const unsent = events.length;
  if (unsent === 0) {
    return { safe: true, unsent: 0, deliveries: [], warning: null };
  }

  const deliveries = [...new Set(events.map((e) => e.delivery_id))];
  const n = `${unsent} update${unsent > 1 ? "s" : ""}`;
  const d = `${deliveries.length} job${deliveries.length > 1 ? "s" : ""}`;

  return {
    safe: false,
    unsent,
    deliveries,
    warning:
      `${n} on ${d} have not reached us yet. Signing out now deletes them ` +
      "and nobody will know that work was done. Get signal and send them first.",
  };
}
