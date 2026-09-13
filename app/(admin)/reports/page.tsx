import Link from "next/link";
import { withReader } from "@/lib/auth/current";
import {
  Page, PageHead, Section, Card, Stat, StatRow, TableWrap, Th, Td,
  Badge, Empty, Notice, Code, linkStyle,
} from "@/lib/ui";
import { neutral } from "@/lib/ui/theme";

export const dynamic = "force-dynamic";

/**
 * The numbers scope §8 has promised since Phase 0.
 *
 * All of them come from `delivery_status_history`, which is
 * insert-only and enforced so by trigger — which means they cannot
 * drift from what actually happened. A report computed from a mutable
 * status column tells you what the column says today.
 *
 * ── The two that say "not available" ──
 *
 * On-time rate needs a promised window, and Grocery sends none (Q8),
 * so `promised_to` is null on every real delivery. Rider utilisation
 * needs shift data this system does not hold.
 *
 * Both render as a stated gap with the reason. A plausible-looking
 * zero would be worse than an honest blank: somebody would act on it.
 */
export default async function ReportsPage() {
  const result = await withReader(async (db) => {
    const [stuck, funnel, latency, outcomes, commits, errors, jobs] = await Promise.all([
      db.query("select * from delivery.stuck_deliveries(60)"),
      db.query("select * from delivery.status_funnel(null)"),
      db.query("select * from delivery.latency_percentiles(null)"),
      db.query("select * from delivery.outcome_rates(null)"),
      db.query("select * from delivery.commit_health()"),
      db.query("select * from integration.error_rate()"),
      db.query("select * from ops.job_health()"),
    ]);
    return {
      stuck: stuck.rows, funnel: funnel.rows, latency: latency.rows,
      outcomes: outcomes.rows, commits: commits.rows,
      errors: errors.rows[0], jobs: jobs.rows,
    };
  });

  if (!result.ok) {
    return (
      <Page>
        <PageHead kicker="Reports" title="Could not read the numbers" />
        <Notice tone="danger" title="The database did not answer">
          {result.error ?? "Your session has expired."}
        </Notice>
      </Page>
    );
  }

  const { stuck, funnel, latency, outcomes, commits, errors, jobs } = result.data;
  const overdue = jobs.filter((j: Record<string, unknown>) => j.overdue);
  const unverified = commits.filter((c: Record<string, unknown>) => c.state !== "verified");

  return (
    <Page>
      <PageHead
        kicker="Reports"
        title="How it is going"
        sub="Computed from the delivery timeline, which is insert-only — so these cannot disagree with what happened."
      />

      {/* The scheduler first: if it is dead, nothing below is current. */}
      {overdue.length > 0 && (
        <Notice tone="danger" title="The scheduler is behind">
          <ul style={{ margin: "6px 0 8px", paddingLeft: 20 }}>
            {overdue.map((j: Record<string, unknown>) => (
              <li key={String(j.job)}>
                <Code>{String(j.job)}</Code>{" "}
                {j.seconds_since === null
                  ? "has never succeeded"
                  : `has not succeeded for ${j.seconds_since}s (allowed ${j.stale_after_seconds}s)`}
              </li>
            ))}
          </ul>
          <span style={{ fontSize: 12.5, color: neutral[500] }}>
            Nothing below is more current than the last successful drain. Start the worker
            with <Code>npm run worker</Code>.
          </span>
        </Notice>
      )}

      <StatRow>
        <Stat n={stuck.length} label="stuck deliveries"
              tone={stuck.length ? "danger" : "success"}
              hint="open, nothing for an hour" />
        <Stat n={funnel.reduce((n: number, f: Record<string, unknown>) => n + Number(f.n), 0)}
              label="deliveries, all time" />
        <Stat n={unverified.length ? unverified.reduce((n: number, c: Record<string, unknown>) => n + Number(c.n), 0) : 0}
              label="not yet verified with stock"
              tone={unverified.length ? "attention" : "success"}
              hint="anything but 'verified' needs chasing" />
        <Stat n={errors?.rate ?? "—"} label="integration errors"
              hint={`${errors?.dead ?? 0} dead of ${errors?.total ?? 0} · target < 0.1 %`} />
      </StatRow>

      <Section
        title="Stuck deliveries"
        hint="Open, and nothing has happened for an hour. The only report here that tells you about a problem nobody has reported yet."
      >
        {stuck.length === 0 ? (
          <Empty title="Nothing is stuck"
                 hint="Every open delivery has moved in the last hour." />
        ) : (
          <TableWrap>
            <thead><tr>
              <Th>Delivery</Th><Th>Status</Th><Th>At</Th><Th>With</Th><Th align="right">Stuck</Th>
            </tr></thead>
            <tbody>
              {stuck.map((d: Record<string, unknown>) => (
                <tr key={String(d.delivery_id)}>
                  <Td>
                    <Link href={`/deliveries/${d.delivery_id}`} style={linkStyle}>
                      {String(d.tracking_id)}
                    </Link>
                  </Td>
                  <Td><Badge tone="attention">{String(d.status)}</Badge></Td>
                  <Td>{String(d.location_code)}</Td>
                  <Td muted>{d.rider ? String(d.rider) : "the shop"}</Td>
                  <Td align="right">{age(d.stuck_minutes)}</Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Section>

      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ flex: "1 1 320px" }}>
          <Section title="Where everything is">
            {funnel.length === 0 ? (
              <Empty title="No deliveries yet"
                     hint="They arrive from Grocery when a customer pays." />
            ) : (
              <TableWrap>
                <tbody>
                  {funnel.map((f: Record<string, unknown>) => (
                    <tr key={String(f.status)}>
                      <Td>{String(f.status)}</Td>
                      <Td align="right">{String(f.n)}</Td>
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
            )}
          </Section>
        </div>

        <div style={{ flex: "1 1 320px" }}>
          <Section
            title="Commit and release"
            hint="The one set of numbers where anything but verified is a stock discrepancy."
          >
            {commits.length === 0 ? (
              <Empty title="Nothing delivered yet" />
            ) : (
              <TableWrap>
                <tbody>
                  {commits.map((c: Record<string, unknown>, i: number) => (
                    <tr key={i}>
                      <Td>{String(c.kind)}</Td>
                      <Td>
                        <Badge tone={c.state === "verified" ? "success"
                                   : c.state === "failed" ? "danger" : "attention"}>
                          {String(c.state)}
                        </Badge>
                      </Td>
                      <Td align="right">{String(c.n)}</Td>
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
            )}
          </Section>
        </div>
      </div>

      <Section title="Latency">
        {latency.length === 0 ? (
          <Empty title="Not enough completed journeys yet"
                 hint="These need deliveries that have gone all the way to a doorstep." />
        ) : (
          <TableWrap>
            <thead><tr>
              <Th>Metric</Th><Th align="right">n</Th>
              <Th align="right">p50</Th><Th align="right">p90</Th><Th>Target</Th>
            </tr></thead>
            <tbody>
              {latency.map((l: Record<string, unknown>) => (
                <tr key={String(l.metric)}>
                  <Td>{String(l.metric)}</Td>
                  <Td align="right" muted>{String(l.n)}</Td>
                  <Td align="right">{String(l.p50_minutes)} min</Td>
                  <Td align="right">{String(l.p90_minutes)} min</Td>
                  <Td muted>{String(l.target)}</Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Section>

      <Section title="Outcomes">
        <TableWrap>
          <tbody>
            {outcomes.map((o: Record<string, unknown>) => (
              <tr key={String(o.metric)}>
                <Td>{String(o.metric)}</Td>
                <Td style={o.value === "not available"
                      ? { color: neutral[400], fontStyle: "italic" } : undefined}>
                  {String(o.value)}
                </Td>
                <Td muted>{String(o.detail)}</Td>
              </tr>
            ))}
            <tr>
              <Td>integration error rate</Td>
              <Td>{String(errors?.rate ?? "—")}</Td>
              <Td muted>
                {String(errors?.dead ?? 0)} dead of {String(errors?.total ?? 0)} · target &lt; 0.1 %
              </Td>
            </tr>
          </tbody>
        </TableWrap>
      </Section>
    </Page>
  );
}

function age(minutes: unknown): string {
  const m = Number(minutes);
  if (m < 60) return `${m}m`;
  if (m < 60 * 24) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${Math.floor(m / (60 * 24))}d`;
}
