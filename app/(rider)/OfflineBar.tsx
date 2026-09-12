"use client";

import { useEffect, useState, useCallback } from "react";
import { applyResults, planSync, type OutboxEvent, type SyncResult } from "@/lib/offline/outbox";
import * as store from "@/lib/offline/store";

/**
 * The one client component in the rider app.
 *
 * It registers the service worker, watches connectivity, drains the
 * outbox, and tells the rider the truth about what the server does
 * and does not yet know.
 *
 * ── Why it says "waiting to sync" and never "delivered" ──
 *
 * Until the server has verified the code, a delivery is not delivered
 * as far as the system is concerned. Telling a rider otherwise would
 * mean they walk away believing something the system may later
 * dispute — and they are the one person who could still fix it.
 */
export default function OfflineBar() {
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState(0);
  const [conflicts, setConflicts] = useState<SyncResult[]>([]);
  const [syncing, setSyncing] = useState(false);

  const refresh = useCallback(async () => {
    if (!store.isSupported()) return;
    try {
      setPending((await store.all()).length);
    } catch {
      /* a private window with storage disabled: the app still works online */
    }
  }, []);

  const sync = useCallback(async () => {
    if (!store.isSupported() || syncing) return;

    setSyncing(true);
    try {
      const queued: OutboxEvent[] = await store.all();
      const batch = planSync(queued, { online: navigator.onLine });
      if (batch.length === 0) return;

      const res = await fetch("/api/v1/me/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: batch }),
      });

      if (!res.ok) return;   // keep everything; try again later

      const { results } = await res.json();
      const folded = applyResults(queued, results as SyncResult[]);

      await store.replaceAll(folded.remaining);
      setConflicts(folded.conflicts);
      setPending(folded.remaining.length);

      // A conflict changes what the rider should do next, so the page
      // has to re-read rather than keep showing a stale step.
      if (folded.applied > 0 || folded.conflicts.length > 0) {
        window.location.reload();
      }
    } catch {
      /* still offline, or the request died. Nothing is lost. */
    } finally {
      setSyncing(false);
    }
  }, [syncing]);

  useEffect(() => {
    setOnline(navigator.onLine);
    refresh();

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* no service worker: the app works, it just will not open offline */
      });
    }

    const up = () => { setOnline(true); sync(); };
    const down = () => setOnline(false);
    // Coming back from a locked screen is the commonest moment for a
    // phone to regain signal without firing `online`.
    const visible = () => { if (document.visibilityState === "visible") sync(); };

    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    document.addEventListener("visibilitychange", visible);

    const timer = setInterval(() => { if (navigator.onLine) sync(); }, 30_000);

    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
      document.removeEventListener("visibilitychange", visible);
      clearInterval(timer);
    };
  }, [refresh, sync]);

  if (conflicts.length > 0) {
    return (
      <div style={S.conflict}>
        <strong>Dispatch needs to talk to you.</strong>
        <ul style={S.list}>
          {conflicts.map((c) => (
            <li key={c.client_event_id}>{c.message ?? c.conflict_code}</li>
          ))}
        </ul>
        <button style={S.dismiss} onClick={() => setConflicts([])}>Got it</button>
      </div>
    );
  }

  if (!online) {
    return (
      <div style={S.offline}>
        <strong>No signal.</strong> Carry on — everything you do is saved
        {pending > 0 ? ` (${pending} waiting to send).` : " and will send itself."}
      </div>
    );
  }

  if (pending > 0) {
    return (
      <div style={S.pending}>
        {syncing ? "Sending…" : `${pending} job update${pending > 1 ? "s" : ""} waiting to send.`}
        {!syncing && (
          <button style={S.now} onClick={sync}>Send now</button>
        )}
      </div>
    );
  }

  return null;
}

const S: Record<string, React.CSSProperties> = {
  offline: { background: "#3a3a3a", color: "white", padding: "10px 16px",
             fontSize: 14, textAlign: "center" },
  pending: { background: "#fff4d6", color: "#7a5200", padding: "10px 16px",
             fontSize: 14, textAlign: "center", display: "flex",
             gap: 12, justifyContent: "center", alignItems: "center" },
  conflict: { background: "#ffe9e6", color: "#8a1c10", padding: "14px 16px",
              fontSize: 14, borderBottom: "2px solid #f5b5ad" },
  list: { margin: "8px 0 10px", paddingLeft: 20 },
  now: { padding: "5px 12px", border: "1px solid #d4a017", background: "white",
         borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer" },
  dismiss: { padding: "6px 14px", border: 0, background: "#8a1c10", color: "white",
             borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer" },
};
