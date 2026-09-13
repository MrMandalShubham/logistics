import type { CSSProperties } from "react";
import { neutral, semantic, radius, font, mono } from "./theme";

/**
 * The rider app's own sizing, from the same colours.
 *
 * ── Why it is not just the staff styles ──
 *
 * A dispatcher reads a dense table on a laptop, indoors, with a
 * mouse. A rider reads one thing at a time on a phone, outdoors,
 * often in sunlight, with a thumb and sometimes one hand because the
 * other is holding a parcel.
 *
 * So: bigger text, bigger targets, more contrast, fewer things on
 * screen. Apple and Google both put the minimum comfortable touch
 * target around 44px; nothing tappable here is under 48.
 *
 * The colours come from the shared tokens, so a status that is amber
 * on the dispatch board is amber on the phone.
 */
export const rider = {
  page: {
    maxWidth: 560, margin: "0 auto", padding: "16px 16px 96px",
    fontFamily: font, fontSize: 16, lineHeight: 1.5, color: neutral[700],
  } as CSSProperties,

  /** One job, one obvious next action. Full width, impossible to miss. */
  primary: {
    width: "100%", minHeight: 56, padding: "16px 20px",
    background: semantic.accent, color: neutral[0], border: 0,
    borderRadius: radius.lg, fontSize: 18, fontWeight: 700,
    cursor: "pointer", fontFamily: font,
  } as CSSProperties,

  secondary: {
    flex: 1, minHeight: 48, padding: "13px 16px",
    background: semantic.accentSoft, color: semantic.accent, border: 0,
    borderRadius: radius.md, fontSize: 15, fontWeight: 600,
    textAlign: "center", textDecoration: "none", fontFamily: font,
    display: "flex", alignItems: "center", justifyContent: "center",
  } as CSSProperties,

  quiet: {
    flex: 1, minHeight: 48, padding: "13px 16px",
    background: neutral[100], color: neutral[700], border: 0,
    borderRadius: radius.md, fontSize: 15, fontWeight: 600,
    textAlign: "center", textDecoration: "none", fontFamily: font,
    display: "flex", alignItems: "center", justifyContent: "center",
  } as CSSProperties,

  card: {
    display: "block", padding: 16, background: neutral[0],
    border: `1px solid ${neutral[200]}`, borderRadius: radius.lg,
    textDecoration: "none", color: "inherit",
  } as CSSProperties,

  block: {
    padding: 16, background: neutral[0],
    border: `1px solid ${neutral[200]}`, borderRadius: radius.lg,
    marginBottom: 14,
  } as CSSProperties,

  label: {
    fontSize: 11, textTransform: "uppercase" as const, letterSpacing: 0.7,
    color: neutral[500], fontWeight: 600, marginBottom: 8,
  } as CSSProperties,

  tracking: { fontFamily: mono, fontSize: 15, color: neutral[900], fontWeight: 700 },

  /** Big enough to read at arm's length on a doorstep. */
  address: { fontSize: 17, lineHeight: 1.6, color: neutral[900] },

  /** The six-digit box. Wide spacing so a mistyped digit is visible. */
  otp: {
    width: "100%", padding: "18px 16px", fontSize: 30, letterSpacing: 10,
    textAlign: "center" as const, border: `2px solid ${neutral[200]}`,
    borderRadius: radius.lg, boxSizing: "border-box" as const,
    fontFamily: mono, color: neutral[900],
  } as CSSProperties,

  hint: { color: neutral[500], fontSize: 13.5, marginTop: 10 },
};
