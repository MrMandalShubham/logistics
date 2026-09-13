"use client";

import { useState } from "react";

/**
 * ── Why this posts to the API rather than a server action ──
 *
 * It is the same endpoint an integrator calls, with the same body and
 * the same errors. One sign-in path means one place where lockout,
 * the failure counter and the audit row happen, and no chance of a
 * screen and an API disagreeing about what a valid password is.
 *
 * ── Why the error messages are shown verbatim ──
 *
 * The server already decided what is safe to say. "Locked out, try
 * again in 240 seconds" and "email or password is wrong" are
 * deliberately different sentences written on the server side, and
 * rewording them here would either leak more than intended or lose
 * the one detail that helps.
 */
export default function SignInForm() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const fd = new FormData(e.currentTarget);
    try {
      const res = await fetch("/api/v1/auth/sign-in", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: String(fd.get("email") ?? ""),
          password: String(fd.get("password") ?? ""),
        }),
      });

      const body = await res.json().catch(() => null);

      if (!res.ok) {
        setError(body?.error?.message ?? `Sign-in failed (${res.status}).`);
        setBusy(false);
        return;
      }

      // A first sign-in with a password somebody else chose goes
      // straight to changing it — every other route is blocked until
      // it is, so landing anywhere else would be a dead end.
      if (body?.user?.must_change_password) {
        window.location.href = "/change-password";
        return;
      }

      // Riders get the task list; staff get the board.
      window.location.href = body?.user?.role === "rider" ? "/me" : "/dispatch";
    } catch {
      setError("Could not reach the server. Is it running?");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} style={S.form}>
      <label style={S.field}>
        <span style={S.label}>Email</span>
        <input name="email" type="email" autoComplete="username" required
               autoFocus style={S.input} />
      </label>

      <label style={S.field}>
        <span style={S.label}>Password</span>
        <input name="password" type="password" autoComplete="current-password"
               required style={S.input} />
      </label>

      <button type="submit" style={S.button} disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>

      {error && <p style={S.error}>{error}</p>}
    </form>
  );
}

const S: Record<string, React.CSSProperties> = {
  form: { display: "flex", flexDirection: "column", gap: 14 },
  field: { display: "flex", flexDirection: "column", gap: 5 },
  label: { fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, color: "#888" },
  input: { padding: "11px 12px", fontSize: 15, border: "1px solid #ddd",
           borderRadius: 10, boxSizing: "border-box" },
  button: { padding: 13, background: "#0b5fff", color: "white", border: 0,
            borderRadius: 10, fontSize: 15, fontWeight: 600, cursor: "pointer",
            marginTop: 4 },
  error: { background: "#fff6f4", border: "1px solid #f5b5ad", color: "#8a1c10",
           borderRadius: 10, padding: "10px 12px", margin: 0, fontSize: 13 },
};
