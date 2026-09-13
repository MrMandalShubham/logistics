import { withReader } from "@/lib/auth/current";
import { ridersForDispatch } from "@/lib/fleet/dispatch";
import { setRiderAvailability, setRiderStatus } from "@/app/actions/dispatch";
import {
  Page, PageHead, Stat, StatRow, TableWrap, Th, Td, Badge, Empty, Notice,
  buttonStyle,
} from "@/lib/ui";
import { neutral, radius, type as t, font } from "@/lib/ui/theme";

export const dynamic = "force-dynamic";

/**
 * The roster.
 *
 * Availability and status are two different questions and are kept
 * apart deliberately: "on shift right now" changes several times a
 * day and is the rider's own business; "suspended" or "offboarded" is
 * an employment decision that also closes their login.
 */
export default async function RidersPage() {
  const result = await withReader(async (db) => ridersForDispatch(db));

  if (!result.ok) {
    return (
      <Page>
        <PageHead kicker="Riders" title="Could not read the roster" />
        <Notice tone="danger" title="The database did not answer">
          {result.error ?? "Your session has expired."}
        </Notice>
      </Page>
    );
  }

  const riders = result.data;
  const perms = (result.claims.permissions as string[]) ?? [];
  const mayToggle = perms.includes("riders:availability");
  const mayManage = perms.includes("riders:write");

  const available = riders.filter((r) => r.unavailable_reason === null);
  const carrying = riders.reduce((n, r) => n + Number(r.active_count), 0);

  async function toggle(formData: FormData) {
    "use server";
    await setRiderAvailability(
      String(formData.get("rider_id")),
      formData.get("online") === "true",
      "changed from the riders screen");
  }

  async function changeStatus(formData: FormData) {
    "use server";
    await setRiderStatus(
      String(formData.get("rider_id")),
      String(formData.get("status")),
      "changed from the riders screen");
  }

  return (
    <Page>
      <PageHead
        kicker="Riders"
        title="Who is on shift"
        sub="Availability is today; status is employment. Offboarding also closes the login — a roster change that leaves the door open is not an offboarding."
      />

      <StatRow>
        <Stat n={available.length} label={`available of ${riders.length}`}
              tone={available.length ? "success" : "attention"} />
        <Stat n={carrying} label="parcels being carried" />
      </StatRow>

      <div style={{ marginTop: 24 }}>
        {riders.length === 0 ? (
          <Empty
            title="No riders yet"
            hint={
              <>
                Onboard one with <code style={{ fontFamily: "inherit" }}>POST /api/v1/riders</code>{" "}
                — it returns a one-time password they change at first sign-in.
              </>
            }
          />
        ) : (
          <TableWrap>
            <thead><tr>
              <Th>Rider</Th><Th>Contact</Th><Th>Vehicle</Th><Th>Base</Th>
              <Th align="right">Load</Th><Th>State</Th>
              <Th>Availability</Th><Th>Status</Th>
            </tr></thead>
            <tbody>
              {riders.map((r) => (
                <tr key={r.id}>
                  <Td>
                    <strong style={{ color: neutral[900] }}>{r.code}</strong>
                    <br />
                    <span style={{ ...t.small, color: neutral[500] }}>{r.display_name}</span>
                  </Td>
                  <Td muted>{r.phone}</Td>
                  <Td>{r.vehicle_type.toLowerCase()}</Td>
                  <Td>{r.home_location_code ?? "any"}</Td>
                  <Td align="right">{r.active_count}/{r.max_concurrent}</Td>
                  <Td>
                    {r.unavailable_reason
                      ? <Badge tone="attention">{r.unavailable_reason}</Badge>
                      : <Badge tone="success">available</Badge>}
                  </Td>
                  <Td>
                    {mayToggle && r.status === "ACTIVE" ? (
                      <form action={toggle}>
                        <input type="hidden" name="rider_id" value={r.id} />
                        <input type="hidden" name="online" value={String(!r.is_online)} />
                        <button type="submit"
                                style={buttonStyle(r.is_online ? "quiet" : "primary")}>
                          {r.is_online ? "Set offline" : "Set online"}
                        </button>
                      </form>
                    ) : <span style={{ color: neutral[400] }}>—</span>}
                  </Td>
                  <Td>
                    {mayManage && r.status !== "OFFBOARDED" ? (
                      <form action={changeStatus} style={{ display: "flex", gap: 6 }}>
                        <input type="hidden" name="rider_id" value={r.id} />
                        <select name="status" defaultValue={r.status} style={selectStyle}>
                          <option value="ACTIVE">active</option>
                          <option value="SUSPENDED">suspended</option>
                          <option value="OFFBOARDED">offboarded</option>
                        </select>
                        <button type="submit" style={buttonStyle("quiet")}>Apply</button>
                      </form>
                    ) : (
                      <Badge tone="neutral">{r.status.toLowerCase()}</Badge>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </div>
    </Page>
  );
}

const selectStyle: React.CSSProperties = {
  padding: "8px 10px", border: `1px solid ${neutral[200]}`,
  borderRadius: radius.sm, fontSize: 13.5, fontFamily: font,
  background: neutral[0], color: neutral[700],
};
