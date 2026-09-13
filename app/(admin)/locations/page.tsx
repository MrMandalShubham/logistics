import { withReader } from "@/lib/auth/current";
import LocationForm from "./LocationForm";
import {
  Page, PageHead, Card, Badge, Notice, Code,
} from "@/lib/ui";
import { neutral, mono, type as t } from "@/lib/ui/theme";

export const dynamic = "force-dynamic";

/**
 * Where the shops are.
 *
 * ── Why this screen exists ──
 *
 * `integration.location_ref` has had `lat` and `lng` since Phase 1
 * and they were null the whole time, because the only thing that
 * filled them was a sync from Inventory and Inventory has no such
 * field (Q21). Four of the nine V2 features — automatic assignment,
 * batching, delivery zones and any honest ETA — need the answer.
 *
 * So logistics owns it now. Names and types still come from Inventory
 * and are overwritten on every sync; coordinates do not.
 *
 * ── Why a text box rather than a map ──
 *
 * There is no map provider anywhere in this estate. A shop is set up
 * once and moves approximately never, and somebody reading a latitude
 * off a maps app is a perfectly good way to do a thing that happens
 * three times. A map is a conversation with a bill attached.
 */
export default async function LocationsPage() {
  const result = await withReader(async (db) =>
    (await db.query("select * from integration.locations_with_geo()")).rows);

  if (!result.ok) {
    return (
      <Page width={860}>
        <PageHead kicker="Locations" title="Could not read the locations" />
        <Notice tone="danger" title="The database did not answer">
          {result.error ?? "Your session has expired."}
        </Notice>
      </Page>
    );
  }

  const locations = result.data;
  const perms = (result.claims.permissions as string[]) ?? [];
  const mayWrite = perms.includes("locations:write");
  const unset = locations.filter((l: Record<string, unknown>) => l.lat === null);

  return (
    <Page width={860}>
      <PageHead
        kicker="Locations"
        title="Where the shops are"
        sub="Names and types come from Inventory on every sync. Coordinates and the service radius are ours — Inventory has no such field, and where a rider collects from is not its fact to own."
      />

      {unset.length > 0 && (
        <Notice tone="attention"
                title={`${unset.length} of ${locations.length} shops have no coordinates`}>
          Dispatch cannot rank riders by distance from{" "}
          {unset.map((l: Record<string, unknown>) => String(l.code)).join(", ")}, and
          serviceability for their orders reads “cannot tell” rather than in or out of range.
        </Notice>
      )}

      {!mayWrite && (
        <Notice tone="neutral">
          You can see these but not change them. That needs <Code>locations:write</Code>.
        </Notice>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {locations.map((l: Record<string, unknown>) => (
          <Card key={String(l.code)}
                style={l.lat === null ? { borderColor: "#ffd89b" } : undefined}>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <strong style={{ fontFamily: mono, fontSize: 15, color: neutral[900] }}>
                {String(l.code)}
              </strong>
              <span style={{ color: neutral[700] }}>{String(l.name)}</span>
              <Badge tone="neutral">{String(l.type)}</Badge>
              {Number(l.open_deliveries) > 0 && (
                <Badge tone="accent">{String(l.open_deliveries)} open</Badge>
              )}
              <span style={{ marginLeft: "auto", ...t.small, color: neutral[400] }}>
                {sourceLabel(l)}
              </span>
            </div>

            <p style={{
              margin: "10px 0 0", fontFamily: l.lat === null ? "inherit" : mono,
              color: l.lat === null ? neutral[400] : neutral[700],
              fontStyle: l.lat === null ? "italic" : "normal",
            }}>
              {l.lat === null
                ? "No coordinates set."
                : `${l.lat}, ${l.lng}  ·  serves ${l.service_radius_km} km`}
            </p>

            {mayWrite && (
              <LocationForm
                code={String(l.code)}
                lat={l.lat === null ? "" : String(l.lat)}
                lng={l.lng === null ? "" : String(l.lng)}
                radius={String(l.service_radius_km)}
              />
            )}
          </Card>
        ))}
      </div>

      <p style={{ marginTop: 24, ...t.small, color: neutral[400] }}>
        A latitude in Mumbai is about 19, a longitude about 72. Entering them the wrong way
        round is refused — not by the range, because 72 is a legal latitude, but because it
        would put the shop thousands of kilometres from every other one.
      </p>
    </Page>
  );
}

function sourceLabel(l: Record<string, unknown>): string {
  switch (l.geo_source) {
    case "LOCAL":     return l.geo_set_by_name ? `set by ${l.geo_set_by_name}` : "set here";
    case "INVENTORY": return "from Inventory";
    case "SEED":      return "development seed";
    default:          return "not set";
  }
}
