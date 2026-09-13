import Link from "next/link";
import { cookies } from "next/headers";
import { pool } from "@/lib/db";
import { COOKIE_NAME, hashToken } from "@/lib/auth/session";

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

    const [stuck, funnel, latency, outcomes, commits, errors, jobs] = await Promise.all([
      db.query("select * from delivery.stuck_deliveries(60)"),
      db.query("select * from delivery.status_funnel(null)"),
      db.query("select * from delivery.latency_percentiles(null)"),
      db.query("select * from delivery.outcome_rates(null)"),
      db.query("select * from delivery.commit_health()"),
      db.query("select * from integration.error_rate()"),
      db.query("select * from ops.job_health()"),
    ]);

    await db.query("commit");
    return {
      claims: c.claims,
      stuck: stuck.rows, funnel: funnel.rows, latency: latency.rows,
      outcomes: outcomes.rows, commits: commits.rows,
      errors: errors.rows[0], jobs: jobs.rows,
    };
  } catch (e) {
    await db.query("rollback").catch(() => {});
    return { error: (e as Error).message };
  } finally {
    db.release();
  }
}

export default async function ReportsPage() {
  const data = await load();

  if (!data) {
    return <main style={S.page}><h1 style={S.h1}>Reports</h1>
      <p>You are not signed in, or your session has expired.</p></main>;
  }
  if ("error" in data) {
    return <main style={S.page}><h1 style={S.h1}>Reports</h1>
      <p style={S.err}>Could not read the numbers: {data.error}</p></main>;
  }

  const { stuck, funnel, latency, outcomes, commits, errors, jobs } = data;
  const overdue = jobs.filter((j) => j.overdue);
  const badCommits = commits.filter(
    (c) => c.state === "failed" || c.state === "pending" || c.state === "none");

  return (
    <main style={S.page}>
      <h1 style={S.h1}>Reports</h1>
      <p style={S.sub}>
        Computed from the delivery timeline, which is insert-only — so these cannot
        disagree with what happened.
      </p>

      {/* ── The scheduler first: if it is dead, nothing below is current ── */}
      {overdue.length > 0 && (
        <div style={S.alarm}>
          <strong>The scheduler is behind.</strong>
          <ul style={S.list}>
            {overdue.map((j) => (
              <li key={j.job}>
                <code>{j.job}</code>{" "}
                {j.seconds_since === null
                  ? "has never succeeded"
                  : `has not succeeded for ${j.seconds_since}s (allowed ${j.stale_after_seconds}s)`}
                {j.last_outcome === false && j.last_detail && <> — {j.last_detail}</>}
              </li>
            ))}
          </ul>
          <span style={S.quiet}>
            Nothing below is more current than the last successful drain. Start the worker
            with <code>npm run worker</code>.
          </span>
        </div>
      )}

      {/* ── AC-18 ── */}
      <h2 style={S.h2}>Stuck deliveries</h2>
      <p style={S.note}>
        Open, and nothing has happened for an hour. The only report here that tells you
        about a problem nobody has reported yet.
      </p>
      {stuck.length === 0 ? (
        <p style={S.good}>Nothing is stuck.</p>
      ) : (
        <table style={S.table}>
          <thead><tr>
            <th style={S.th}>Delivery</th><th style={S.th}>Status</th>
            <th style={S.th}>At</th><th style={S.th}>With</th>
            <th style={S.thR}>Stuck</th>
          </tr></thead>
          <tbody>
            {stuck.map((d) => (
              <tr key={String(d.delivery_id)}>
                <td style={S.td}>
                  <Link href={`/deliveries/${d.delivery_id}`} style={S.link}>
                    {d.tracking_id}
                  </Link>
                </td>
                <td style={S.td}>{d.status}</td>
                <td style={S.td}>{d.location_code}</td>
                <td style={S.tdMuted}>{d.rider ?? "the shop"}</td>
                <td style={S.tdR}>{fmtAge(d.stuck_minutes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div style={S.cols}>
        <section style={S.col}>
          <h2 style={S.h2}>Where everything is</h2>
          {funnel.length === 0 ? <p style={S.empty}>No deliveries yet.</p> : (
            <table style={S.table}>
              <tbody>
                {funnel.map((f) => (
                  <tr key={f.status}>
                    <td style={S.td}>{f.status}</td>
                    <td style={S.tdR}>{String(f.n)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section style={S.col}>
          <h2 style={S.h2}>Commit and release</h2>
          <p style={S.note}>
            The one set of numbers where anything but <em>verified</em> is a stock
            discrepancy.
          </p>
          {commits.length === 0 ? <p style={S.empty}>Nothing delivered yet.</p> : (
            <table style={S.table}>
              <tbody>
                {commits.map((c, i) => (
                  <tr key={i}>
                    <td style={S.td}>{c.kind}</td>
                    <td style={{ ...S.td, ...(c.state !== "verified" ? S.warn : {}) }}>
                      {c.state}
                    </td>
                    <td style={S.tdR}>{String(c.n)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {badCommits.length > 0 && (
            <p style={S.quiet}>
              Anything not <em>verified</em> means Inventory has not confirmed the goods
              moved. Pending clears itself once the drain runs; failed needs a person.
            </p>
          )}
        </section>
      </div>

      <h2 style={S.h2}>Latency</h2>
      {latency.length === 0 ? (
        <p style={S.empty}>Not enough completed journeys yet.</p>
      ) : (
        <table style={S.table}>
          <thead><tr>
            <th style={S.th}>Metric</th><th style={S.thR}>n</th>
            <th style={S.thR}>p50</th><th style={S.thR}>p90</th><th style={S.th}>Target</th>
          </tr></thead>
          <tbody>
            {latency.map((l) => (
              <tr key={l.metric}>
                <td style={S.td}>{l.metric}</td>
                <td style={S.tdR}>{String(l.n)}</td>
                <td style={S.tdR}>{l.p50_minutes} min</td>
                <td style={S.tdR}>{l.p90_minutes} min</td>
                <td style={S.tdMuted}>{l.target}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 style={S.h2}>Outcomes</h2>
      <table style={S.table}>
        <tbody>
          {outcomes.map((o) => (
            <tr key={o.metric}>
              <td style={S.td}>{o.metric}</td>
              <td style={{ ...S.td, ...(o.value === "not available" ? S.muted : {}) }}>
                {o.value}
              </td>
              <td style={S.tdMuted}>{o.detail}</td>
            </tr>
          ))}
          <tr>
            <td style={S.td}>integration error rate</td>
            <td style={S.td}>{errors?.rate}</td>
            <td style={S.tdMuted}>
              {String(errors?.dead ?? 0)} dead of {String(errors?.total ?? 0)} (target &lt; 0.1 %)
            </td>
          </tr>
        </tbody>
      </table>
    </main>
  );
}

function fmtAge(minutes: unknown): string {
  const m = Number(minutes);
  if (m < 60) return `${m}m`;
  if (m < 60 * 24) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${Math.floor(m / (60 * 24))}d`;
}

const S: Record<string, React.CSSProperties> = {
  page: { maxWidth: 1000, margin: "0 auto", padding: 24, fontSize: 14 },
  h1: { fontSize: 26, margin: "0 0 4px" },
  h2: { fontSize: 16, margin: "28px 0 8px" },
  sub: { color: "#666", margin: "0 0 18px" },
  note: { color: "#666", fontSize: 13, margin: "0 0 10px" },
  quiet: { color: "#888", fontSize: 12, display: "block", marginTop: 8 },
  alarm: { background: "#fff6f4", border: "1px solid #f5b5ad", borderRadius: 12,
           padding: "14px 16px", color: "#8a1c10", marginBottom: 8 },
  list: { margin: "8px 0 0", paddingLeft: 20 },
  cols: { display: "flex", gap: 24, flexWrap: "wrap" },
  col: { flex: "1 1 320px" },
  table: { width: "100%", borderCollapse: "collapse", background: "#fff",
           border: "1px solid #e5e5e5", borderRadius: 10, overflow: "hidden" },
  th: { textAlign: "left", padding: "8px 12px", background: "#fafafa",
        borderBottom: "1px solid #e5e5e5", fontSize: 11,
        textTransform: "uppercase", letterSpacing: 0.5, color: "#888" },
  thR: { textAlign: "right", padding: "8px 12px", background: "#fafafa",
         borderBottom: "1px solid #e5e5e5", fontSize: 11,
         textTransform: "uppercase", letterSpacing: 0.5, color: "#888" },
  td: { padding: "8px 12px", borderBottom: "1px solid #f2f2f2" },
  tdR: { padding: "8px 12px", borderBottom: "1px solid #f2f2f2", textAlign: "right",
         fontVariantNumeric: "tabular-nums" },
  tdMuted: { padding: "8px 12px", borderBottom: "1px solid #f2f2f2", color: "#777" },
  muted: { color: "#999", fontStyle: "italic" },
  warn: { color: "#b35900", fontWeight: 600 },
  good: { color: "#1a7f37" },
  empty: { color: "#888" },
  err: { color: "#8a1c10" },
  link: { color: "#0b5fff", textDecoration: "none", fontWeight: 600 },
};
