"use client";

import { useState } from "react";
import { neutral, semantic } from "@/lib/ui/theme";

export const dynamic = "force-dynamic";

/**
 * The other half of the way in.
 *
 * `npm run admin:create` and every admin-issued reset set
 * `must_change_password`, and that flag blocks every route except
 * this one. Without a screen here, a freshly created account could
 * sign in and then reach nothing at all — which is precisely what
 * happened until now.
 */
export default function ChangePasswordPage() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const next = String(fd.get("new_password") ?? "");
    const again = String(fd.get("confirm") ?? "");

    if (next !== again) { setError("The two new passwords do not match."); return; }

    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/auth/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          current_password: String(fd.get("current_password") ?? ""),
          new_password: next,
        }),
      });
      const body = await res.json().catch(() => null);

      if (!res.ok) {
        setError(body?.error?.message ?? `Could not change it (${res.status}).`);
        setBusy(false);
        return;
      }

      setDone(true);
      // Changing a password ends other sessions, so go back through
      // the door rather than assuming this one still works.
      setTimeout(() => { window.location.href = "/sign-in"; }, 1500);
    } catch {
      setError("Could not reach the server.");
      setBusy(false);
    }
  }

  if (done) {
    return (
      <main style={S.page}>
        <h1 style={S.h1}>Password changed</h1>
        <p style={S.sub}>Sending you back to sign in…</p>
      </main>
    );
  }

  return (
    <main style={S.page}>
      <h1 style={S.h1}>Choose a password</h1>
      <p style={S.sub}>
        Your account was created with a password somebody else picked. Everything else
        is blocked until you change it.
      </p>

      <form onSubmit={onSubmit} style={S.form}>
        <label style={S.field}>
          <span style={S.label}>Current password</span>
          <input name="current_password" type="password" required
                 autoComplete="current-password" autoFocus style={S.input} />
        </label>
        <label style={S.field}>
          <span style={S.label}>New password</span>
          <input name="new_password" type="password" required minLength={12}
                 autoComplete="new-password" style={S.input} />
        </label>
        <label style={S.field}>
          <span style={S.label}>New password again</span>
          <input name="confirm" type="password" required minLength={12}
                 autoComplete="new-password" style={S.input} />
        </label>

        <button type="submit" style={S.button} disabled={busy}>
          {busy ? "Changing…" : "Change password"}
        </button>

        {error && <p style={S.error}>{error}</p>}
      </form>
    </main>
  );
}

const S: Record<string, React.CSSProperties> = {
  page: { maxWidth: 380, margin: "72px auto", padding: "0 24px",
          fontSize: 14, lineHeight: 1.6 },
  h1: { fontSize: 24, margin: "0 0 2px" },
  sub: { color: neutral[500], margin: "0 0 24px" },
  form: { display: "flex", flexDirection: "column", gap: 14 },
  field: { display: "flex", flexDirection: "column", gap: 5 },
  label: { fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, color: neutral[500] },
  input: { padding: "11px 12px", fontSize: 15, border: "1px solid #ddd",
           borderRadius: 10, boxSizing: "border-box" },
  button: { padding: 13, background: semantic.accent, color: "white", border: 0,
            borderRadius: 10, fontSize: 15, fontWeight: 600, cursor: "pointer",
            marginTop: 4 },
  error: { background: semantic.dangerSoft, border: "1px solid #f5b5ad", color: semantic.danger,
           borderRadius: 10, padding: "10px 12px", margin: 0, fontSize: 13 },
};
