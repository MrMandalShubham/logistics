import Link from "next/link";
import { withReader } from "@/lib/auth/current";
import {
  Page, PageHead, Section, Stat, StatRow, TableWrap, Th, Td,
  Badge, Empty, Notice, Code, linkStyle,
} from "@/lib/ui";
import { neutral } from "@/lib/ui/theme";

export const dynamic = "force-dynamic";

/**
 * Outbound health: what is queued, what is retrying, what is dead.
 *
 * ── Why every number here comes from a definer function ──
 *
 * This codebase has been bitten repeatedly by the same thing: a plain
 * SELECT under row-level security, as a role with no matching policy,
 * returns zero rows and reports success. On a health screen that is
 * the worst possible failure — "nothing is wrong" and "you cannot see
 * anything" render identically, and the second is indistinguishable
 * from an all-clear.
 *
 * So the reads are SECURITY DEFINER, and a viewer without permission
 * gets an error rather than a calm empty table.
 *
 * ── Why a dead status push is not an incident ──
 *
 * A dead INVENTORY commit means stock left a building and no ledger
 * records it. A dead GROCERY status means somebody's order page is
 * stale while their shopping sits on their doorstep. Both belong
 * here; only one of them is somebody's evening.
 */
export default async function IntegrationPage() {
  const result = await withReader(async (db) => {
    const [health, dead, notifications] = await Promise.all([
      db.query("select * from integration.outbound_health()"),
      db.query("select * from integration.dead_outbound(25)"),
      db.query("select * from ops.recent_notifications(null, 25)"),
    ]);
    return { health: health.rows, dead: dead.rows, notifications: notifications.rows };
  });

  if (!result.ok) {
    return (
      <Page>
        <PageHead kicker="Integration" title="Could not read the queue" />
        <Notice tone="danger" title="The database did not answer">
          {result.error ?? "Your session has expired."}
        </Notice>
      </Page>
    );
  }

  const { health, dead, notifications } = result.data;
  const total = (s: string) =>
    health.filter((h: Record<string, unknown>) => h.status === s)
          .reduce((n: number, h: Record<string, unknown>) => n + Number(h.n), 0);

  const queued = total("PENDING") + total("SENDING");
  const deadN = total("DEAD");

  return (
    <Page>
      <PageHead
        kicker="Integration"
        title="What we owe the rest of the estate"
        sub="Nothing here is sent by a page load — a worker drains the queue."
      />

      <StatRow>
        <Stat n={queued} label="waiting to send"
              tone={queued ? "attention" : "neutral"} />
        <Stat n={total("DELIVERED")} label="delivered" tone="success" />
        <Stat n={deadN} label="dead — need a person"
              tone={deadN ? "danger" : "success"} />
      </StatRow>

      <Section title="Queue">
        {health.length === 0 ? (
          <Empty title="The queue is empty"
                 hint="Events appear when a delivery changes state. An empty queue with deliveries moving means the worker is keeping up." />
        ) : (
          <TableWrap>
            <thead><tr>
              <Th>Target</Th><Th>Status</Th><Th align="right">Count</Th>
              <Th>Oldest</Th><Th>Next attempt</Th>
            </tr></thead>
            <tbody>
              {health.map((h: Record<string, unknown>, i: number) => (
                <tr key={i}>
                  <Td>{String(h.target)}</Td>
                  <Td>
                    <Badge tone={h.status === "DEAD" ? "danger"
                               : h.status === "DELIVERED" ? "success" : "attention"}>
                      {String(h.status)}
                    </Badge>
                  </Td>
                  <Td align="right">{String(h.n)}</Td>
                  <Td muted>{when(h.oldest)}</Td>
                  <Td muted>{h.status === "PENDING" ? when(h.next_due) : "—"}</Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Section>

      <Section title="Dead letters"
               hint="Given up on after six attempts. These do not retry themselves.">
        {dead.length === 0 ? (
          <Empty title="Nothing has been given up on" />
        ) : (
          <TableWrap>
            <thead><tr>
              <Th>When</Th><Th>Target</Th><Th>Event</Th><Th>Delivery</Th><Th>Last error</Th>
            </tr></thead>
            <tbody>
              {dead.map((d: Record<string, unknown>) => (
                <tr key={String(d.id)}>
                  <Td muted>{when(d.created_at)}</Td>
                  <Td>{String(d.target)}</Td>
                  <Td><Code>{String(d.event)}</Code></Td>
                  <Td>
                    {d.delivery_id ? (
                      <Link href={`/deliveries/${d.delivery_id}`} style={linkStyle}>
                        {d.tracking_id ? String(d.tracking_id) : "open"}
                      </Link>
                    ) : "—"}
                  </Td>
                  <Td style={{ color: "#8a1c10", fontSize: 12.5, maxWidth: 360,
                               overflowWrap: "anywhere" }}>
                    {String(d.last_error ?? "")}
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Section>

      <Section
        title="Recent notifications"
        hint="A customer_app row IS the notification: pushing the status to Grocery is what the customer sees. There is no email or SMS provider in this estate, so those channels record intent and send nothing."
      >
        {notifications.length === 0 ? (
          <Empty title="Nothing has been sent yet" />
        ) : (
          <TableWrap>
            <thead><tr>
              <Th>When</Th><Th>Delivery</Th><Th>Channel</Th><Th>Status</Th><Th>Says</Th>
            </tr></thead>
            <tbody>
              {notifications.map((n: Record<string, unknown>) => (
                <tr key={String(n.id)}>
                  <Td muted>{when(n.created_at)}</Td>
                  <Td>
                    {n.delivery_id ? (
                      <Link href={`/deliveries/${n.delivery_id}`} style={linkStyle}>
                        {n.tracking_id ? String(n.tracking_id) : "open"}
                      </Link>
                    ) : "—"}
                  </Td>
                  <Td>{String(n.channel)}</Td>
                  <Td>
                    <Badge tone={n.status === "SENT" ? "success"
                               : n.status === "FAILED" ? "danger" : "neutral"}>
                      {String(n.status)}
                    </Badge>
                  </Td>
                  <Td muted>
                    {String((n.payload as Record<string, unknown>)?.message ?? "")}
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Section>
    </Page>
  );
}

function when(v: unknown): string {
  if (!v) return "—";
  return new Date(String(v)).toISOString().replace("T", " ").slice(0, 19);
}
