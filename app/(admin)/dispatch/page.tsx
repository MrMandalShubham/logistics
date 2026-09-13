import Link from "next/link";
import { withReader } from "@/lib/auth/current";
import { ridersForDispatch, queueForDispatch, inFlight } from "@/lib/fleet/dispatch";
import { assignDelivery } from "@/app/actions/dispatch";
import Suggest, { type RankedRider } from "./Suggest";
import {
  Page, PageHead, Section, Stat, StatRow, TableWrap, Th, Td,
  Badge, Empty, Notice, Code, linkStyle,
} from "@/lib/ui";
import { neutral } from "@/lib/ui/theme";

export const dynamic = "force-dynamic";

/**
 * The dispatch board.
 *
 * What is waiting, who is free, and what is already out — read
 * through the same claims-and-RLS path an API request takes, so a
 * dispatcher bound to SH1 sees SH1 because the policy says so, not
 * because this page remembered to filter.
 *
 * ── Why there is no map ──
 *
 * Shop coordinates are set on the Locations screen and nothing else
 * in this estate has a map provider. A half-drawn map is worse than a
 * list, and a list is what somebody handling tens of orders a day
 * actually works from.
 */
export default async function DispatchPage() {
  const result = await withReader(async (db) => {
    const [queue, riders, active] = await Promise.all([
      queueForDispatch(db), ridersForDispatch(db), inFlight(db),
    ]);

    // Phase 8: who SHOULD take each one, and why. Ranking, not
    // assigning — the dispatcher still clicks.
    const ranked: Record<string, RankedRider[]> = {};
    for (const d of queue as { id: string }[]) {
      const { rows } = await db.query("select * from fleet.rank_riders_for($1)", [d.id]);
      ranked[d.id] = rows as RankedRider[];
    }

    return { queue, riders, active, ranked };
  });

  if (!result.ok) {
    return (
      <Page width={1180}>
        <PageHead kicker="Dispatch" title="Could not read the board" />
        <Notice tone="danger" title="The database did not answer">
          {result.error ?? "Your session has expired."}
        </Notice>
      </Page>
    );
  }

  const { queue, riders, active, ranked } = result.data;
  const perms = (result.claims.permissions as string[]) ?? [];
  const mayAssign = perms.includes("deliveries:assign");
  const available = riders.filter((r) => r.unavailable_reason === null);
  const awaiting = active.filter(
    (a: Record<string, unknown>) => a.assignment_status === "OFFERED").length;

  async function assign(formData: FormData) {
    "use server";
    await assignDelivery(
      String(formData.get("delivery_id")), String(formData.get("rider_id")));
  }

  return (
    <Page width={1180}>
      <PageHead
        kicker="Dispatch"
        title="The board"
        sub="Ranked by distance where a shop has coordinates, then by load and idle time. It suggests; you decide."
      />

      {!mayAssign && (
        <Notice tone="neutral">
          You can see the board but not assign. That needs <Code>deliveries:assign</Code>.
        </Notice>
      )}

      <StatRow>
        <Stat n={queue.length} label="waiting for a rider"
              tone={queue.length ? "attention" : "success"} />
        <Stat n={available.length} label={`available of ${riders.length} riders`}
              tone={available.length ? "success" : "danger"} />
        <Stat n={active.length} label="out now" />
        <Stat n={awaiting} label="awaiting a reply"
              tone={awaiting ? "attention" : "neutral"}
              hint="offers expire on their own" />
      </StatRow>

      <Section title="Waiting for a rider">
        {queue.length === 0 ? (
          <Empty
            title="Nothing waiting"
            hint={<>Admit a delivery from the <Link href="/deliveries" style={linkStyle}>queue</Link> first.</>}
          />
        ) : (
          <TableWrap>
            <thead><tr>
              <Th>Tracking</Th><Th>Pickup</Th><Th>Destination</Th>
              <Th align="right">Items</Th><Th>Stock</Th><Th>Assign to</Th>
            </tr></thead>
            <tbody>
              {queue.map((d: Record<string, unknown>) => (
                <tr key={String(d.id)}>
                  <Td>
                    <Link href={`/deliveries/${d.id}`} style={linkStyle}>
                      {String(d.tracking_id)}
                    </Link>
                  </Td>
                  <Td>{String(d.pickup_location_code)}</Td>
                  <Td muted>{d.city ? `${d.city} ${d.pincode ?? ""}` : "—"}</Td>
                  <Td align="right">{String(d.item_count)}</Td>
                  <Td>
                    <Badge tone={d.hold_status === "held" ? "success" : "attention"}>
                      {String(d.hold_status)}
                    </Badge>
                  </Td>
                  <Td style={{ minWidth: 330 }}>
                    {mayAssign && available.length > 0 ? (
                      <Suggest
                        deliveryId={String(d.id)}
                        ranked={ranked[String(d.id)] ?? []}
                        fallback={available}
                        assign={assign}
                      />
                    ) : (
                      <span style={{ color: neutral[400] }}>
                        {!mayAssign ? "—" : "no rider available"}
                      </span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Section>

      <Section title="Out now">
        {active.length === 0 ? (
          <Empty title="Nothing is out" hint="Assigned deliveries appear here until they finish." />
        ) : (
          <TableWrap>
            <thead><tr>
              <Th>Tracking</Th><Th>Rider</Th><Th>State</Th>
              <Th>Offer expires</Th><Th>Destination</Th>
            </tr></thead>
            <tbody>
              {active.map((a: Record<string, unknown>) => (
                <tr key={String(a.id)}>
                  <Td>
                    <Link href={`/deliveries/${a.id}`} style={linkStyle}>
                      {String(a.tracking_id)}
                    </Link>
                  </Td>
                  <Td>{String(a.rider_code)} · {String(a.rider_name)}</Td>
                  <Td>
                    <Badge tone={a.assignment_status === "OFFERED" ? "attention" : "accent"}>
                      {a.assignment_status === "OFFERED" ? "awaiting reply" : "accepted"}
                    </Badge>
                  </Td>
                  <Td muted>
                    {a.assignment_status === "OFFERED" && a.expires_at
                      ? new Date(String(a.expires_at)).toLocaleTimeString()
                      : "—"}
                  </Td>
                  <Td muted>{a.city ? `${a.city} ${a.pincode ?? ""}` : "—"}</Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Section>

      <Section title="Riders"
               actions={<Link href="/riders" style={linkStyle}>Manage →</Link>}>
        <TableWrap>
          <thead><tr>
            <Th>Rider</Th><Th>Vehicle</Th><Th>Base</Th>
            <Th align="right">Load</Th><Th>State</Th>
          </tr></thead>
          <tbody>
            {riders.map((r) => (
              <tr key={r.id}>
                <Td>
                  <strong style={{ color: neutral[900] }}>{r.code}</strong>{" "}
                  <span style={{ color: neutral[500] }}>{r.display_name}</span>
                </Td>
                <Td>{r.vehicle_type.toLowerCase()}</Td>
                <Td>{r.home_location_code ?? "any"}</Td>
                <Td align="right">{r.active_count}/{r.max_concurrent}</Td>
                <Td>
                  {r.unavailable_reason
                    ? <Badge tone="attention">{r.unavailable_reason}</Badge>
                    : <Badge tone="success">available</Badge>}
                </Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      </Section>
    </Page>
  );
}
