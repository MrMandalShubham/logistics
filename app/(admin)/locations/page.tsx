import { cookies } from "next/headers";
import { pool } from "@/lib/db";
import { COOKIE_NAME, hashToken } from "@/lib/auth/session";
import LocationForm from "./LocationForm";

export const dynamic = "force-dynamic";

/**
 * Where the shops are.
 *
 * ── Why this screen exists ──
 *
 * `integration.location_ref` has had `lat` and `lng` since Phase 1
 * and they have been null since Phase 1, because the only thing that
 * filled them was a sync from Inventory and Inventory has no such
 * field (Q21). Four of the nine V2 features — automatic assignment,
 * batching, delivery zones and any honest ETA — need the answer.
 *
 * So logistics owns it now. Names and types still come from
 * Inventory and are overwritten on every sync; coordinates do not,
 * and a sync can no longer relabel them.
 *
 * ── Why a text box rather than a map ──
 *
 * There is no map provider anywhere in this estate. A shop is set up
 * once and moves approximately never, and somebody reading a
 * latitude off a maps app is a perfectly good way to do a thing that
 * happens three times. A map is a V2 conversation with a bill
 * attached.
 */
async function load() {
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  if (!token) return null;

  const db = await pool.connect();
  try {
    const { rows: [c] } = await db.query(
      "select identity.resolve_session($1) as claims", [hashToken(token)]);
    if (!c?.claims) return null;

    await db.query("begin");
    await db.query("select set_config('request.jwt.claims',$1,true)",
      [JSON.stringify(c.claims)]);
    await db.query("set local role authenticated");

    const { rows } = await db.query("select * from integration.locations_with_geo()");
    await db.query("commit");
    return { claims: c.claims, locations: rows };
  } catch (e) {
    await db.query("rollback").catch(() => {});
    return { error: (e as Error).message };
  } finally {
    db.release();
  }
}

export default async function LocationsPage() {
  const data = await load();

  if (!data) {
    return <main style={S.page}><h1 style={S.h1}>Locations</h1>
      <p>You are not signed in, or your session has expired.</p></main>;
  }
  if ("error" in data) {
    return <main style={S.page}><h1 style={S.h1}>Locations</h1>
      <p style={S.err}>Could not read the locations: {data.error}</p></main>;
  }

  const { claims, locations } = data;
  const perms = (claims.permissions as string[]) ?? [];
  const mayWrite = perms.includes("locations:write");
  const unset = locations.filter((l) => l.lat === null);

  return (
    <main style={S.page}>
      <h1 style={S.h1}>Locations</h1>
      <p style={S.sub}>
        Names and types come from Inventory on every sync. Coordinates and the service
        radius are ours — Inventory has no such field, and where a rider collects from is
        not its fact to own.
      </p>

      {unset.length > 0 && (
        <div style={S.alarm}>
          <strong>
            {unset.length} of {locations.length} shops have no coordinates.
          </strong>
          <span style={S.quiet}>
            Dispatch cannot rank riders by distance from{" "}
            {unset.map((l) => l.code).join(", ")}, and serviceability for orders from
            those shops reads &ldquo;cannot tell&rdquo; rather than in or out of range.
          </span>
        </div>
      )}

      {!mayWrite && (
        <p style={S.notice}>
          You can see these but not change them. That needs <code>locations:write</code>.
        </p>
      )}

      <div style={S.list}>
        {locations.map((l) => (
          <div key={l.code} style={{ ...S.item, ...(l.lat === null ? S.itemWarn : {}) }}>
            <div style={S.head}>
              <strong style={S.code}>{l.code}</strong>
              <span>{l.name}</span>
              <span style={S.type}>{l.type}</span>
              {Number(l.open_deliveries) > 0 && (
                <span style={S.badge}>{String(l.open_deliveries)} open</span>
              )}
              <span style={S.source}>{sourceLabel(l)}</span>
            </div>

            <p style={S.where}>
              {l.lat === null ? (
                <em style={S.muted}>No coordinates set.</em>
              ) : (
                <>
                  {l.lat}, {l.lng} · serves {l.service_radius_km} km
                </>
              )}
            </p>

            {mayWrite && (
              <LocationForm
                code={l.code}
                lat={l.lat === null ? "" : String(l.lat)}
                lng={l.lng === null ? "" : String(l.lng)}
                radius={String(l.service_radius_km)}
              />
            )}
          </div>
        ))}
      </div>

      <p style={S.footnote}>
        A latitude in Mumbai is about 19, a longitude about 72. Entering them the wrong way
        round is the commonest mistake and is refused — 72 is not a latitude anywhere
        outside the Arctic.
      </p>
    </main>
  );
}

function sourceLabel(l: Record<string, unknown>): string {
  switch (l.geo_source) {
    case "LOCAL":
      return l.geo_set_by_name ? `set by ${l.geo_set_by_name}` : "set here";
    case "INVENTORY": return "from Inventory";
    case "SEED": return "development seed";
    default: return "not set";
  }
}

const S: Record<string, React.CSSProperties> = {
  page: { maxWidth: 820, margin: "0 auto", padding: 24, fontSize: 14 },
  h1: { fontSize: 26, margin: "0 0 4px" },
  sub: { color: "#666", margin: "0 0 16px" },
  notice: { background: "#f5f5f5", border: "1px solid #e5e5e5", borderRadius: 10,
            padding: "10px 14px", color: "#555" },
  alarm: { background: "#fff8ec", border: "1px solid #ffd699", borderRadius: 12,
           padding: "12px 16px", color: "#7a5200", marginBottom: 14 },
  quiet: { display: "block", marginTop: 6, fontSize: 13 },
  list: { display: "flex", flexDirection: "column", gap: 10 },
  item: { padding: 16, border: "1px solid #e5e5e5", borderRadius: 12, background: "#fff" },
  itemWarn: { borderColor: "#ffd699" },
  head: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" },
  code: { fontFamily: "ui-monospace, monospace", fontSize: 15 },
  type: { fontSize: 11, color: "#888", letterSpacing: 0.5 },
  badge: { fontSize: 11, background: "#eef3ff", color: "#0b3aa8",
           padding: "2px 8px", borderRadius: 6 },
  source: { marginLeft: "auto", fontSize: 12, color: "#999" },
  where: { margin: "8px 0 0", fontFamily: "ui-monospace, monospace" },
  muted: { color: "#999", fontFamily: "inherit" },
  footnote: { marginTop: 24, color: "#888", fontSize: 12 },
  err: { color: "#8a1c10" },
};
