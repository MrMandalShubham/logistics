import Link from "next/link";
import { neutral, semantic, radius, font, type as t } from "@/lib/ui/theme";
import { buttonStyle, linkStyle } from "@/lib/ui";

export type RankedRider = {
  rider_id: string; code: string; display_name: string;
  distance_km: string | null; position_source: "LIVE" | "HOME" | "NONE";
  active_count: number; max_concurrent: number;
  unavailable_reason: string | null; rank: number; why: string;
};

/**
 * The ranked rider picker.
 *
 * ── Why the list is ordered and annotated, and still a list ──
 *
 * `fleet.rank_riders_for` puts the best candidate first and says why
 * — distance, load, how long they have been idle. The dispatcher
 * still chooses, because a scoring function nobody has watched make a
 * decision is not one to hand the wheel to, and because the person on
 * the board knows things the database does not: who is about to
 * finish a shift, whose bike is playing up, who asked for the far
 * side of town.
 *
 * ── Why it degrades rather than disappears ──
 *
 * With no shop coordinates it falls back to the plain list and says
 * so, with a link to fix it. A missing geocode should make dispatch
 * worse, not broken.
 */
export default function Suggest({
  deliveryId, ranked, fallback, assign,
}: {
  deliveryId: string;
  ranked: RankedRider[];
  fallback: { id: string; code: string; display_name: string;
              active_count: number; max_concurrent: number }[];
  assign: (fd: FormData) => Promise<void>;
}) {
  const usable = ranked.filter((r) => r.unavailable_reason === null);
  const best = usable[0];

  return (
    <form action={assign} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <input type="hidden" name="delivery_id" value={deliveryId} />

      {usable.length > 0 ? (
        <>
          <select name="rider_id" style={selectStyle} defaultValue={best.rider_id}>
            {usable.map((r) => (
              <option key={r.rider_id} value={r.rider_id}>
                {r.rank === 1 ? "★ " : ""}{r.code} · {r.display_name}
                {r.distance_km !== null ? ` · ${r.distance_km} km` : ""}
                {` (${r.active_count}/${r.max_concurrent})`}
              </option>
            ))}
          </select>
          <button type="submit" style={buttonStyle()}>Assign</button>
          <span style={{ flexBasis: "100%", ...t.small, color: neutral[500] }}>
            {best.why}
          </span>
        </>
      ) : (
        <>
          <select name="rider_id" style={selectStyle} defaultValue={fallback[0]?.id}>
            {fallback.map((r) => (
              <option key={r.id} value={r.id}>
                {r.code} · {r.display_name} ({r.active_count}/{r.max_concurrent})
              </option>
            ))}
          </select>
          <button type="submit" style={buttonStyle()}>Assign</button>
          <span style={{ flexBasis: "100%", ...t.small, color: neutral[500] }}>
            Not ranked —{" "}
            <Link href="/locations" style={linkStyle}>set this shop&rsquo;s coordinates</Link>{" "}
            to sort by distance.
          </span>
        </>
      )}
    </form>
  );
}

const selectStyle: React.CSSProperties = {
  padding: "8px 10px", border: `1px solid ${neutral[200]}`,
  borderRadius: radius.sm, fontSize: 13.5, fontFamily: font,
  background: neutral[0], color: neutral[700], maxWidth: 240,
  outlineColor: semantic.accent,
};
