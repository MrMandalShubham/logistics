"use client";

import { useState } from "react";
import { neutral } from "@/lib/ui/theme";

/**
 * The staff app had no sign-out at all.
 *
 * Unlike the rider's, this one has nothing to clear: staff screens
 * read from the server on every request and keep no local copy of a
 * delivery. A rider's phone holds an outbox full of customer
 * addresses, which is why that button warns before wiping and this
 * one simply goes.
 */
export default function SignOut() {
  const [busy, setBusy] = useState(false);

  return (
    <button
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await fetch("/api/v1/auth/sign-out", { method: "POST" });
        } catch {
          /* the cookie is httpOnly, so the server clears it or nobody does */
        }
        window.location.href = "/sign-in";
      }}
      style={{
        background: "transparent", color: neutral[400], border: `1px solid ${neutral[700]}`,
        borderRadius: 8, padding: "6px 12px", fontSize: 12.5, fontWeight: 600,
        cursor: "pointer", whiteSpace: "nowrap", fontFamily: "inherit",
      }}
    >
      {busy ? "…" : "Sign out"}
    </button>
  );
}
