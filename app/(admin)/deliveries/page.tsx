import Link from "next/link";
import { withReader } from "@/lib/auth/current";
import { LABELS, type DeliveryStatus } from "@/lib/delivery/states";
import {
  Page, PageHead, TableWrap, Th, Td, Badge, Empty, Notice, linkStyle,
} from "@/lib/ui";
import { statusTone } from "@/lib/ui/theme";

export const dynamic = "force-dynamic";

/**
 * Everything in flight, newest first.
 *
 * A server component reading through the same claims-and-RLS path an
 * API request takes, so a dispatcher bound to SH1 sees SH1 here for
 * exactly the same reason they do over HTTP — not because this page
 * remembered to filter.
 */
export default async function DeliveriesPage() {
  const result = await withReader(async (db) => {
    const { rows } = await db.query(
      `select d.id, d.tracking_id, d.status, d.pickup_location_code,
              d.hold_status, d.hold_expires_at, d.created_at,
              a.city, a.pincode,
              (select count(*)::int from delivery.delivery_item i
                where i.delivery_id = d.id) as item_count
         from delivery.delivery d
         left join delivery.delivery_address a on a.delivery_id = d.id
        order by d.created_at desc limit 100`);
    return rows;
  });

  if (!result.ok) {
    return (
      <Page>
        <PageHead kicker="Deliveries" title="Could not read the queue" />
        <Notice tone="danger" title="The database did not answer">
          {result.error ?? "Your session has expired."}
        </Notice>
      </Page>
    );
  }

  const rows = result.data;
  const open = rows.filter(
    (r: Record<string, unknown>) =>
      !["DELIVERED", "RETURNED", "CANCELLED"].includes(String(r.status)));

  return (
    <Page>
      <PageHead
        kicker="Deliveries"
        title="Everything in flight"
        sub={`${open.length} open of the ${rows.length} most recent. Newest first.`}
      />

      {rows.length === 0 ? (
        <Empty
          title="No deliveries yet"
          hint="They arrive from Grocery when a customer pays. Nothing here means nothing has been handed over — not that anything is broken."
        />
      ) : (
        <TableWrap>
          <thead><tr>
            <Th>Tracking</Th><Th>Status</Th><Th>Pickup</Th>
            <Th>Destination</Th><Th align="right">Items</Th>
            <Th>Stock hold</Th><Th>Created</Th>
          </tr></thead>
          <tbody>
            {rows.map((d: Record<string, unknown>) => (
              <tr key={String(d.id)}>
                <Td>
                  <Link href={`/deliveries/${d.id}`} style={linkStyle}>
                    {String(d.tracking_id)}
                  </Link>
                </Td>
                <Td>
                  <Badge tone={statusTone(String(d.status))}>
                    {LABELS[d.status as DeliveryStatus] ?? String(d.status)}
                  </Badge>
                </Td>
                <Td>{String(d.pickup_location_code)}</Td>
                <Td muted>{d.city ? `${d.city} ${d.pincode ?? ""}` : "—"}</Td>
                <Td align="right">{String(d.item_count)}</Td>
                <Td>
                  <Badge tone={d.hold_status === "held" ? "success"
                             : d.hold_status === "delivered" ? "accent" : "attention"}>
                    {String(d.hold_status)}
                  </Badge>
                </Td>
                <Td muted>{when(d.created_at)}</Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
    </Page>
  );
}

function when(v: unknown): string {
  if (!v) return "—";
  return new Date(String(v)).toISOString().replace("T", " ").slice(0, 16);
}
