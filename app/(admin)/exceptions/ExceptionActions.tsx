"use client";

import { useState, useTransition } from "react";
import {
  resolveException, resolveConflict, resolveDisputedProof,
  rescheduleDelivery, requireReturn, type ActionResult,
} from "@/app/actions/exceptions";

/**
 * The buttons that close an exception.
 *
 * ── Why every one of them needs a note ──
 *
 * "Resolved" on its own answers nothing three weeks later, when
 * somebody is asking why a delivery whose code failed was recorded as
 * delivered. The database enforces this — the note is not optional in
 * `resolve_conflict` or `resolve_disputed_proof` — and the form
 * enforces it too so the refusal arrives before the round trip
 * rather than after it.
 *
 * The screen only ever offers what the person is allowed to do; the
 * database decides whether they actually may. Neither trusts the
 * other, which is the point.
 */
export default function ExceptionActions({
  kind, exceptionId, eventId, deliveryId, status,
}: {
  kind: "exception" | "conflict" | "dispute";
  exceptionId?: string;
  eventId?: string;
  deliveryId?: string;
  status?: string;
}) {
  const [note, setNote] = useState("");
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();

  const run = (fn: (fd: FormData) => Promise<ActionResult>, extra: Record<string, string>) =>
    start(async () => {
      const fd = new FormData();
      fd.set("note", note);
      for (const [k, v] of Object.entries(extra)) fd.set(k, v);
      setResult(await fn(fd));
    });

  const needNote = kind !== "exception" && note.trim() === "";

  return (
    <div style={S.wrap}>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={
          kind === "dispute"
            ? "Who did you speak to, and what did they say?"
            : kind === "conflict"
              ? "What did you find out?"
              : "What was decided? (optional)"}
        style={S.note}
        rows={2}
      />

      {kind === "conflict" && (
        <div style={S.row}>
          <button style={S.primary} disabled={pending || needNote}
            onClick={() => run(resolveConflict,
              { event_id: eventId!, decision: "ACCEPT" })}>
            The rider was right
          </button>
          <button style={S.plain} disabled={pending || needNote}
            onClick={() => run(resolveConflict,
              { event_id: eventId!, decision: "DISCARD" })}>
            Discard their report
          </button>
        </div>
      )}

      {kind === "dispute" && (
        <div style={S.row}>
          <button style={S.primary} disabled={pending || needNote}
            onClick={() => run(resolveDisputedProof,
              { delivery_id: deliveryId!, outcome: "DELIVERED" })}>
            It was delivered
          </button>
          <button style={S.danger} disabled={pending || needNote}
            onClick={() => run(resolveDisputedProof,
              { delivery_id: deliveryId!, outcome: "DELIVERY_FAILED" })}>
            It was not
          </button>
        </div>
      )}

      {kind === "exception" && (
        <div style={S.row}>
          {status === "DELIVERY_FAILED" && (
            <>
              <button style={S.primary} disabled={pending}
                onClick={() => run(rescheduleDelivery, { delivery_id: deliveryId! })}>
                Try again
              </button>
              <button style={S.plain} disabled={pending}
                onClick={() => run(requireReturn, { delivery_id: deliveryId! })}>
                Bring it back
              </button>
            </>
          )}
          <button style={S.plain} disabled={pending}
            onClick={() => run(resolveException,
              { exception_id: exceptionId!, resolution_code: "ACKNOWLEDGED" })}>
            Acknowledge
          </button>
        </div>
      )}

      {needNote && <p style={S.hint}>A note is required — this is the only record of why.</p>}

      {result && (
        <p style={result.ok ? S.ok : S.bad}>{result.message}</p>
      )}
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  wrap: { marginTop: 12, display: "flex", flexDirection: "column", gap: 8 },
  note: { width: "100%", padding: 10, fontSize: 14, border: "1px solid #ddd",
          borderRadius: 10, boxSizing: "border-box", fontFamily: "inherit", resize: "vertical" },
  row: { display: "flex", gap: 8, flexWrap: "wrap" },
  primary: { padding: "9px 16px", background: "#0b5fff", color: "white", border: 0,
             borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: "pointer" },
  plain: { padding: "9px 16px", background: "#f2f2f2", color: "#444", border: 0,
           borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: "pointer" },
  danger: { padding: "9px 16px", background: "#8a1c10", color: "white", border: 0,
            borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: "pointer" },
  hint: { color: "#999", fontSize: 12, margin: 0 },
  ok: { color: "#1a7f37", margin: "4px 0 0" },
  bad: { color: "#8a1c10", margin: "4px 0 0" },
};
