import type { CSSProperties, ReactNode } from "react";
import { neutral, semantic, radius, type as t, font, mono, shadow, toneStyles } from "./theme";

/**
 * The pieces every screen was rebuilding.
 *
 * Server components — no "use client" — so they cost nothing at
 * runtime and can be used inside the pages that read from the
 * database directly.
 *
 * Each takes a `style` escape hatch. A shared component that cannot
 * be nudged gets copied instead of used.
 */

type Tone = keyof typeof toneStyles;

// ─────────────── page frame ───────────────

export function Page({ children, width = 1100, style }: {
  children: ReactNode; width?: number; style?: CSSProperties;
}) {
  return (
    <main style={{
      maxWidth: width, margin: "0 auto", padding: "28px 24px 64px",
      fontFamily: font, fontSize: t.body.fontSize, lineHeight: 1.55,
      color: neutral[700], ...style,
    }}>
      {children}
    </main>
  );
}

/**
 * The heading block.
 *
 * Kicker, title, and an optional line of context — the same shape on
 * every screen, so the eye lands in the same place after navigating.
 * `actions` sits right-aligned for the one or two things you can do
 * from here.
 */
export function PageHead({ kicker, title, sub, actions }: {
  kicker?: string; title: string; sub?: ReactNode; actions?: ReactNode;
}) {
  return (
    <header style={{ marginBottom: 24 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          {kicker && (
            <div style={{ ...t.micro, color: semantic.accent, marginBottom: 4 }}>{kicker}</div>
          )}
          <h1 style={{ ...t.h1, color: neutral[900], margin: 0, lineHeight: 1.2 }}>{title}</h1>
        </div>
        {actions && (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>{actions}</div>
        )}
      </div>
      {sub && (
        <p style={{ color: neutral[500], margin: "8px 0 0", maxWidth: 760 }}>{sub}</p>
      )}
    </header>
  );
}

export function Section({ title, hint, children, actions }: {
  title: string; hint?: ReactNode; children: ReactNode; actions?: ReactNode;
}) {
  return (
    <section style={{ marginTop: 28 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: hint ? 4 : 10 }}>
        <h2 style={{ ...t.h3, color: neutral[900], margin: 0 }}>{title}</h2>
        {actions && <div style={{ marginLeft: "auto" }}>{actions}</div>}
      </div>
      {hint && (
        <p style={{ ...t.small, color: neutral[500], margin: "0 0 12px" }}>{hint}</p>
      )}
      {children}
    </section>
  );
}

// ─────────────── surfaces ───────────────

export function Card({ children, tone, pad = 16, style }: {
  children: ReactNode; tone?: Tone; pad?: number; style?: CSSProperties;
}) {
  const s = tone ? toneStyles[tone] : null;
  return (
    <div style={{
      background: s ? s.bg : neutral[0],
      border: `1px solid ${s ? s.edge : neutral[200]}`,
      borderRadius: radius.lg, padding: pad, boxShadow: s ? undefined : shadow.card,
      ...style,
    }}>
      {children}
    </div>
  );
}

/** A number worth looking at, with what it means underneath. */
export function Stat({ n, label, tone = "neutral", hint }: {
  n: ReactNode; label: string; tone?: Tone; hint?: string;
}) {
  const s = toneStyles[tone];
  return (
    <Card tone={tone === "neutral" ? undefined : tone} style={{ flex: "1 1 150px", minWidth: 140 }}>
      <div style={{ fontSize: 30, fontWeight: 700, lineHeight: 1.1,
                    color: tone === "neutral" ? neutral[900] : s.fg }}>
        {n}
      </div>
      <div style={{ ...t.small, color: neutral[500], marginTop: 4 }}>{label}</div>
      {hint && <div style={{ ...t.small, color: neutral[400], marginTop: 6 }}>{hint}</div>}
    </Card>
  );
}

export function StatRow({ children }: { children: ReactNode }) {
  return <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>{children}</div>;
}

// ─────────────── data ───────────────

/**
 * Tables scroll inside themselves.
 *
 * A delivery table on a laptop is wider than the viewport, and a page
 * that scrolls sideways as a whole loses the navigation off the left
 * edge. This keeps the chrome still and moves only the data.
 */
export function TableWrap({ children }: { children: ReactNode }) {
  return (
    <div style={{
      overflowX: "auto", border: `1px solid ${neutral[200]}`,
      borderRadius: radius.md, background: neutral[0],
    }}>
      <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 560 }}>
        {children}
      </table>
    </div>
  );
}

export function Th({ children, align = "left" }: { children?: ReactNode; align?: "left" | "right" }) {
  return (
    <th style={{
      ...t.micro, color: neutral[500], textAlign: align,
      padding: "10px 14px", background: neutral[50],
      borderBottom: `1px solid ${neutral[200]}`, whiteSpace: "nowrap",
    }}>
      {children}
    </th>
  );
}

export function Td({ children, align = "left", muted, style }: {
  children?: ReactNode; align?: "left" | "right"; muted?: boolean; style?: CSSProperties;
}) {
  return (
    <td style={{
      padding: "11px 14px", borderBottom: `1px solid ${neutral[100]}`,
      textAlign: align, color: muted ? neutral[500] : neutral[700],
      fontVariantNumeric: align === "right" ? "tabular-nums" : undefined,
      ...style,
    }}>
      {children}
    </td>
  );
}

// ─────────────── small parts ───────────────

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: Tone }) {
  const s = toneStyles[tone];
  return (
    <span style={{
      display: "inline-block", background: s.bg, color: s.fg,
      border: `1px solid ${s.edge}`, borderRadius: radius.pill,
      padding: "2px 10px", fontSize: 11.5, fontWeight: 600, whiteSpace: "nowrap",
    }}>
      {children}
    </span>
  );
}

export function Code({ children }: { children: ReactNode }) {
  return (
    <code style={{
      fontFamily: mono, fontSize: 12, background: neutral[50],
      border: `1px solid ${neutral[200]}`, borderRadius: 5, padding: "1px 6px",
    }}>
      {children}
    </code>
  );
}

/**
 * What an empty screen says.
 *
 * "No results" tells somebody nothing. Every empty state here says
 * what would put something in it — otherwise a working system and a
 * broken one look identical.
 */
export function Empty({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <Card style={{ textAlign: "center", padding: "32px 24px" }}>
      <div style={{ ...t.lead, color: neutral[700], fontWeight: 600 }}>{title}</div>
      {hint && <div style={{ ...t.small, color: neutral[500], marginTop: 6 }}>{hint}</div>}
    </Card>
  );
}

/** Something a person should read before carrying on. */
export function Notice({ tone = "attention", title, children }: {
  tone?: Tone; title?: string; children: ReactNode;
}) {
  const s = toneStyles[tone];
  return (
    <div style={{
      background: s.bg, border: `1px solid ${s.edge}`, borderRadius: radius.lg,
      padding: "13px 16px", color: neutral[700], marginBottom: 16,
    }}>
      {title && <strong style={{ color: s.fg, display: "block", marginBottom: 4 }}>{title}</strong>}
      {children}
    </div>
  );
}

export const buttonStyle = (variant: "primary" | "quiet" | "danger" = "primary"): CSSProperties => ({
  padding: "9px 16px", borderRadius: radius.md, fontSize: 14, fontWeight: 600,
  cursor: "pointer", border: 0, fontFamily: font, lineHeight: 1.4,
  background: variant === "primary" ? semantic.accent
            : variant === "danger" ? semantic.danger : neutral[100],
  color: variant === "quiet" ? neutral[700] : neutral[0],
});

export const linkStyle: CSSProperties = {
  color: semantic.accent, textDecoration: "none", fontWeight: 600,
};
