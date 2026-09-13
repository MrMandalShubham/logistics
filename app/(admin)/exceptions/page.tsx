import Link from "next/link";
import { withReader } from "@/lib/auth/current";
import ExceptionActions from "./ExceptionActions";
import {
  Page, PageHead, Section, Card, Stat, StatRow, Badge, Empty, Notice, Code, linkStyle,
} from "@/lib/ui";
import { neutral, type as t } from "@/lib/ui/theme";

export const dynamic = "force-dynamic";

/**
 * The work queue for when things go wrong.
 *
 * Phases 4a, 4b and 5 all raise exceptions. Until Phase 6 nothing
 * closed them, and `open_conflicts()` listed disagreements that
 * nobody could decide. This is where a person does both.
 *
 * ── Ordering ──
 *
 * CRITICAL first, then oldest. A conflict between two riders about
 * one doorstep deserves more attention than a delivery that failed
 * because nobody was home — and the age column is there because the
 * second one still matters after four hours.
 */
export default async function ExceptionsPage() {
  const result = await withReader(async (db) => {
    const [open, conflicts] = await Promise.all([
      db.query("select * from delivery.open_exceptions(200)"),
      db.query("select * from integration.open_conflicts()"),
    ]);
    return {
      open: open.rows,
      conflicts: conflicts.rows.filter((r: Record<string, unknown>) => !r.resolved),
    };
  });

  if (!result.ok) {
    return (
      <Page width={960}>
        <PageHead kicker="Exceptions" title="Could not read the queue" />
        <Notice tone="danger" title="The database did not answer">
          {result.error ?? "Your session has expired."}
        </Notice>
      </Page>
    );
  }

  const { open, conflicts } = result.data;
  const perms = (result.claims.permissions as string[]) ?? [];
  const mayResolve = perms.includes("exceptions:resolve");
  const critical = open.filter((x: Record<string, unknown>) => x.severity === "CRITICAL");

  return (
    <Page width={960}>
      <PageHead
        kicker="Exceptions"
        title="What needs a person"
        sub="Things the system could not decide on its own. Each one closes with a name and a reason against it — nothing here is resolved by a timer."
      />

      {!mayResolve && (
        <Notice tone="neutral">
          You can see these but not resolve them. That needs <Code>exceptions:resolve</Code>.
        </Notice>
      )}

      <StatRow>
        <Stat n={critical.length} label="critical"
              tone={critical.length ? "danger" : "success"} />
        <Stat n={open.length} label="open" tone={open.length ? "attention" : "success"} />
        <Stat n={conflicts.length} label="conflicts to decide"
              tone={conflicts.length ? "danger" : "success"}
              hint="two accounts of one doorstep" />
      </StatRow>

      <Section
        title="Conflicts"
        hint="Two people disagree about what happened, and both are waiting."
      >
        {conflicts.length === 0 ? (
          <Empty title="Nobody is disagreeing about a doorstep"
                 hint="Conflicts appear when a rider's offline report contradicts what the system already recorded." />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {conflicts.map((c: Record<string, unknown>) => (
              <Card key={String(c.event_id)} tone="danger">
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <Link href={`/deliveries/${c.delivery_id}`} style={linkStyle}>
                    {String(c.tracking_id)}
                  </Link>
                  <Code>{String(c.conflict_code)}</Code>
                </div>
                <p style={{ margin: "10px 0 0", color: neutral[700] }}>
                  <strong>{String(c.rider_code)}</strong> reported{" "}
                  <strong>{String(c.action)}</strong> at {clock(c.captured_at)}, and we heard
                  at {clock(c.received_at)}.
                </p>
                {mayResolve && (
                  <ExceptionActions kind="conflict" eventId={String(c.event_id)} />
                )}
              </Card>
            ))}
          </div>
        )}
      </Section>

      <Section title="Open exceptions">
        {open.length === 0 ? (
          <Empty title="Nothing is waiting"
                 hint="Failed deliveries, lapsing stock holds and unverified commits all land here." />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {open.map((x: Record<string, unknown>) => (
              <Card key={String(x.id)}
                    tone={x.severity === "CRITICAL" ? "danger" : undefined}>
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <Link href={`/deliveries/${x.delivery_id}`} style={linkStyle}>
                    {String(x.tracking_id)}
                  </Link>
                  <Code>{String(x.code)}</Code>
                  <Badge tone={x.severity === "CRITICAL" ? "danger"
                             : x.severity === "WARNING" ? "attention" : "neutral"}>
                    {String(x.severity)}
                  </Badge>
                  <span style={{ marginLeft: "auto", ...t.small, color: neutral[400] }}>
                    {age(x.age_minutes)}
                  </span>
                </div>

                <p style={{ margin: "10px 0 0", color: neutral[700] }}>
                  Delivery is <strong>{String(x.status)}</strong> at {String(x.location_code)}.
                  {x.parcel_with_rider
                    ? <> The parcel is with <strong>{String(x.parcel_with_rider)}</strong>.</>
                    : <> The parcel is at the shop.</>}
                </p>
                {x.note ? (
                  <p style={{ margin: "6px 0 0", color: neutral[500], fontStyle: "italic" }}>
                    {String(x.note)}
                  </p>
                ) : null}

                {mayResolve && (
                  <ExceptionActions
                    kind={x.code === "PROOF_DISPUTED" ? "dispute" : "exception"}
                    exceptionId={String(x.id)}
                    deliveryId={String(x.delivery_id)}
                    status={String(x.status)}
                  />
                )}
              </Card>
            ))}
          </div>
        )}
      </Section>
    </Page>
  );
}

function clock(v: unknown): string {
  if (!v) return "—";
  return new Date(String(v)).toISOString().slice(11, 16);
}

function age(minutes: unknown): string {
  const m = Number(minutes);
  if (m < 60) return `${m}m`;
  if (m < 60 * 24) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / (60 * 24))}d`;
}
