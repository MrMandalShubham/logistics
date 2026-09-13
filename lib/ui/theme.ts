/**
 * One place for every colour, size and spacing decision.
 *
 * ── Why this exists ──
 *
 * Before it, fourteen screens each carried their own stylesheet.
 * `#0b5fff` appeared twenty-three times, `#8a1c10` eighteen, and the
 * greys were picked per file — `#f5f5f5` here, `#fafafa` there,
 * `#f2f2f2` next door — so the same surface looked slightly different
 * depending on which page you were on.
 *
 * ── Why tokens rather than a CSS framework ──
 *
 * This is a dense operational tool read all day by a handful of
 * people. It needs consistency and legibility, not a design language
 * or a build step. Plain objects keep the server components simple
 * and there is nothing to learn before changing a colour.
 */

/** Neutral ramp. Every grey in the app comes from here. */
export const neutral = {
  0:   "#ffffff",
  25:  "#fafbfc",   // page background
  50:  "#f4f6f8",   // subtle fill, table headers
  100: "#eceff3",   // hover
  200: "#dee3ea",   // borders
  300: "#c4ccd6",   // dividers on dark
  400: "#9aa5b4",   // placeholder
  500: "#6b7787",   // secondary text
  700: "#3d4757",   // body on light
  900: "#101820",   // headings, dark surfaces
} as const;

/**
 * Semantic colours.
 *
 * Named for what they MEAN, not what they look like. A status that is
 * "attention" today and "danger" tomorrow changes in one place, and
 * nobody has to remember whether amber meant warning or pending.
 */
export const semantic = {
  accent:      "#0b5fff",
  accentSoft:  "#eaf1ff",
  accentEdge:  "#c3d8ff",

  success:     "#1a7f37",
  successSoft: "#e9f6ed",
  successEdge: "#b4dfc2",

  attention:   "#b35900",   // needs a person, not yet broken
  attentionSoft: "#fff6e6",
  attentionEdge: "#ffd89b",

  danger:      "#8a1c10",   // something is wrong now
  dangerSoft:  "#fef2f0",
  dangerEdge:  "#f3b9b1",
} as const;

/** 4px rhythm. Every gap and pad is a multiple. */
export const space = {
  1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40, 12: 48,
} as const;

export const radius = { sm: 8, md: 10, lg: 14, pill: 999 } as const;

/**
 * Type scale.
 *
 * `micro` is for the uppercase labels above a value — small, spaced,
 * and never used for anything somebody has to read at length.
 */
export const type = {
  micro:  { fontSize: 11, letterSpacing: 0.6, textTransform: "uppercase" as const, fontWeight: 600 },
  small:  { fontSize: 12.5 },
  body:   { fontSize: 14 },
  lead:   { fontSize: 15.5 },
  h3:     { fontSize: 16, fontWeight: 700 },
  h2:     { fontSize: 20, fontWeight: 700 },
  h1:     { fontSize: 26, fontWeight: 700 },
  display:{ fontSize: 32, fontWeight: 700 },
} as const;

export const font =
  'ui-sans-serif, system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
export const mono =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

/** One shadow, used sparingly. Flat surfaces read as denser. */
export const shadow = {
  card: "0 1px 2px rgba(16,24,32,.04)",
  pop:  "0 8px 24px rgba(16,24,32,.12)",
} as const;

/**
 * Status → colour, in one place.
 *
 * The delivery state machine has fifteen statuses and they appear on
 * five screens. Deciding the colour at each call site is how
 * DELIVERY_FAILED ends up amber on one page and red on another.
 */
export function statusTone(status: string): "accent" | "success" | "attention" | "danger" | "neutral" {
  switch (status) {
    case "DELIVERED":
      return "success";
    case "DELIVERY_FAILED":
    case "RETURN_REQUIRED":
    case "RETURN_IN_TRANSIT":
      return "attention";
    case "CANCELLED":
    case "RETURNED":
      return "neutral";
    case "RECEIVED":
    case "READY_FOR_ASSIGNMENT":
      return "neutral";
    default:
      return "accent";   // everything in motion
  }
}

/** Human wording for a machine status, for places the LABELS map is not to hand. */
export const toneStyles = {
  accent:    { bg: semantic.accentSoft,    fg: semantic.accent,    edge: semantic.accentEdge },
  success:   { bg: semantic.successSoft,   fg: semantic.success,   edge: semantic.successEdge },
  attention: { bg: semantic.attentionSoft, fg: semantic.attention, edge: semantic.attentionEdge },
  danger:    { bg: semantic.dangerSoft,    fg: semantic.danger,    edge: semantic.dangerEdge },
  neutral:   { bg: neutral[50],            fg: neutral[500],       edge: neutral[200] },
} as const;
