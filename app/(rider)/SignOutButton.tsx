"use client";

import { useState } from "react";
import { planSignOut, planSync, applyResults,
         type OutboxEvent, type SyncResult } from "@/lib/offline/outbox";
import * as store from "@/lib/offline/store";
import { neutral, semantic } from "@/lib/ui/theme";

/**
 * Sign out, and take the customers' addresses with you.
 *
 * ── Why this exists (Q32) ──
 *
 * Until now the rider app had no sign-out at all, and the outbox
 * survived on the device indefinitely. It holds recipients' names,
 * street addresses and door instructions — "key under the blue pot" —
 * for every job that phone has handled. On a phone shared between
 * shifts that is the previous rider's round, readable by the next one.
 *
 * ── Why it tries to sync first ──
 *
 * Wiping unsynced events destroys the only record that a delivery
 * happened. So: sync, then check what survived. Anything left is
 * shown to the rider by name and count, and they have to choose it
 * deliberately. A button that quietly deleted three completed
 * deliveries would break Phase 4b's one rule on purpose.
 */
export default function SignOutButton() {
  const [busy, setBusy] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);

  async function finish() {
    // Clear BEFORE the request. If the network dies mid sign-out the
    // rider must not be left signed out with the round still on the
    // phone — the addresses are the part that matters.
    try {
      if (store.isSupported()) await store.clear();
    } catch {
      /* storage already unavailable: nothing to leak */
    }

    try {
      await fetch("/api/v1/auth/sign-out", { method: "POST" });
    } catch {
      /* the cookie is httpOnly, so we cannot clear it here — but the
         session is short-lived and the device now holds no round */
    }

    window.location.href = "/sign-in";
  }

  async function onClick() {
    if (warning) { await finish(); return; }   // second press: they chose

    setBusy(true);
    try {
      if (!store.isSupported()) { await finish(); return; }

      // One last attempt to get their work to the server.
      const queued: OutboxEvent[] = await store.all();
      const batch = planSync(queued, { online: navigator.onLine });

      if (batch.length > 0) {
        try {
          const res = await fetch("/api/v1/me/sync", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ events: batch }),
          });
          if (res.ok) {
            const { results } = await res.json();
            await store.replaceAll(applyResults(queued, results as SyncResult[]).remaining);
          }
        } catch {
          /* no signal. The plan below will say so. */
        }
      }

      const plan = planSignOut(await store.all());
      if (plan.safe) { await finish(); return; }

      setWarning(plan.warning);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={S.wrap}>
      {warning && <p style={S.warning}>{warning}</p>}
      <button style={warning ? S.danger : S.plain} disabled={busy} onClick={onClick}>
        {busy ? "Checking…" : warning ? "Sign out anyway and delete them" : "Sign out"}
      </button>
      {warning && (
        <button style={S.plain} onClick={() => setWarning(null)}>Stay signed in</button>
      )}
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  wrap: { marginTop: 32, display: "flex", flexDirection: "column", gap: 10 },
  plain: { padding: 14, background: neutral[100], color: neutral[700], border: 0,
           borderRadius: 12, fontSize: 15, fontWeight: 600, cursor: "pointer" },
  danger: { padding: 14, background: semantic.danger, color: "white", border: 0,
            borderRadius: 12, fontSize: 15, fontWeight: 700, cursor: "pointer" },
  warning: { background: semantic.dangerSoft, color: semantic.danger, border: "1px solid #f5b5ad",
             borderRadius: 12, padding: "12px 14px", fontSize: 14, margin: 0 },
};
