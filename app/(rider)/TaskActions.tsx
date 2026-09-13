"use client";

import { useEffect, useState } from "react";
import { createEvent, planSync, applyResults, isAwaitingSync,
         type OutboxEvent, type SyncResult } from "@/lib/offline/outbox";
import * as store from "@/lib/offline/store";

/**
 * The buttons a rider actually presses.
 *
 * ── Why these are not server actions ──
 *
 * A server action is a network round trip. A rider in a basement
 * pressing "I have the parcel" would get a spinner and then nothing,
 * and would have no idea whether it counted.
 *
 * So every action is CAPTURED FIRST — written to the outbox with an
 * id and a timestamp fixed at the moment of the tap — and only then
 * sent. If the send fails, nothing is lost and the screen says so.
 *
 * ── Why it says "waiting to sync" ──
 *
 * Until the server has verified the code, the delivery is not
 * delivered as far as the system is concerned. Saying otherwise would
 * send a rider away believing something that may later be disputed,
 * when they are the one person who could still sort it out.
 */
export default function TaskActions({
  deliveryId,
  status,
  nextStep,
  canComplete,
}: {
  deliveryId: string;
  status: string;
  nextStep: { to: string; label: string } | null;
  canComplete: boolean;
}) {
  const [otp, setOtp] = useState("");
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!store.isSupported()) return;
    store.all()
      .then((events) => setQueued(isAwaitingSync(events, deliveryId)))
      .catch(() => { /* storage blocked; online still works */ });
  }, [deliveryId]);

  /** Capture, then try to send. Capture never fails for lack of signal. */
  async function capture(action: OutboxEvent["action"], payload: Record<string, unknown>) {
    setBusy(true);
    setMessage(null);

    const event = createEvent(action, deliveryId, payload, Date.now());

    try {
      if (store.isSupported()) await store.put(event);
    } catch {
      // No storage at all. Fall through and try the network — better
      // to attempt it than to refuse the rider outright.
    }

    setQueued(true);

    try {
      const events: OutboxEvent[] = store.isSupported() ? await store.all() : [event];
      const batch = planSync(events, { online: navigator.onLine });

      if (batch.length === 0) {
        setMessage("Saved. It will send when you have signal.");
        setBusy(false);
        return;
      }

      const res = await fetch("/api/v1/me/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: batch }),
      });

      if (!res.ok) {
        setMessage("Saved. It will send when you have signal.");
        setBusy(false);
        return;
      }

      const { results } = await res.json();
      const folded = applyResults(events, results as SyncResult[]);

      if (store.isSupported()) await store.replaceAll(folded.remaining);

      const conflict = folded.conflicts[0];
      if (conflict) {
        // Do not reload past a conflict — the rider needs to read it.
        setMessage(conflict.message ?? `Dispatch needs to talk to you (${conflict.conflict_code}).`);
        setQueued(false);
        setBusy(false);
        return;
      }

      window.location.reload();
    } catch {
      setMessage("Saved. It will send when you have signal.");
      setBusy(false);
    }
  }

  if (queued && !message) {
    return (
      <div style={S.waiting}>
        <strong>Waiting to sync.</strong> Your work is saved on this phone.
      </div>
    );
  }

  return (
    <div>
      {message && <div style={S.message}>{message}</div>}

      {canComplete ? (
        <div style={S.block}>
          <div style={S.label}>Ask the customer for their code</div>
          <input
            value={otp}
            onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
            inputMode="numeric" placeholder="6-digit code" style={S.otp}
            autoComplete="off"
          />
          <button
            style={S.primary}
            disabled={busy || otp.length !== 6}
            onClick={() => capture("complete", { otp })}
          >
            {busy ? "Saving…" : "Complete delivery"}
          </button>
          <p style={S.hint}>
            If they do not have the code, ring dispatch — do not guess.
          </p>
        </div>
      ) : nextStep ? (
        <button
          style={S.primary}
          disabled={busy}
          onClick={() => capture("step", { to: nextStep.to })}
        >
          {busy ? "Saving…" : nextStep.label}
        </button>
      ) : (
        <p style={S.hint}>Waiting on dispatch.</p>
      )}

      {/* No failure buttons on the way back. A return cannot fail —
          the rider is walking to the shop they collected it from, and
          offering "nobody answered" there would be nonsense. */}
      {!["DELIVERED", "RETURNED", "CANCELLED",
         "RETURN_REQUIRED", "RETURN_IN_TRANSIT"].includes(status) && (
        <details style={S.details}>
          <summary style={S.summary}>Something went wrong</summary>
          <div style={S.reasons}>
            {[
              ["CUSTOMER_UNREACHABLE", "Nobody answered"],
              ["ADDRESS_WRONG", "Address is wrong"],
              ["CUSTOMER_REFUSED", "They refused it"],
              ["NO_ACCESS", "Could not get in"],
              ["PACKAGE_DAMAGED", "Parcel is damaged"],
            ].map(([code, label]) => (
              <button
                key={code} style={S.reason} disabled={busy}
                onClick={() => capture("fail", { reason_code: code })}
              >
                {label}
              </button>
            ))}
          </div>
          <p style={S.hint}>
            You keep the parcel. Dispatch will tell you what to do with it.
          </p>
        </details>
      )}
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  block: { padding: 16, border: "1px solid #e5e5e5", borderRadius: 14, background: "#fff" },
  label: { fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6,
           color: "#888", marginBottom: 8 },
  otp: { width: "100%", padding: 16, fontSize: 26, letterSpacing: 8,
         textAlign: "center", border: "2px solid #ddd", borderRadius: 12,
         boxSizing: "border-box" },
  primary: { width: "100%", padding: 18, background: "#0b5fff", color: "white",
             border: 0, borderRadius: 14, fontSize: 18, fontWeight: 700,
             cursor: "pointer", marginTop: 10 },
  waiting: { padding: 16, background: "#fff4d6", color: "#7a5200",
             borderRadius: 14, textAlign: "center" },
  message: { padding: "12px 14px", background: "#eef3ff", color: "#0b3aa8",
             borderRadius: 12, marginBottom: 12, fontSize: 14 },
  hint: { color: "#888", fontSize: 13, marginTop: 10 },
  details: { marginTop: 28 },
  summary: { color: "#b35900", fontSize: 14, cursor: "pointer" },
  reasons: { display: "flex", flexDirection: "column", gap: 8, marginTop: 12 },
  reason: { padding: 14, background: "#fff", border: "1px solid #ffd699",
            borderRadius: 12, fontSize: 15, cursor: "pointer", textAlign: "left" },
};
