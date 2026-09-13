import Link from "next/link";
import { cookies } from "next/headers";
import { pool } from "@/lib/db";
import { COOKIE_NAME, hashToken } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/**
 * Outbound health: what is queued, what is retrying, what is dead.
 *
 * ── Why every number on this page comes from a definer function ──
 *
 * This codebase has now been bitten four times by the same thing: a
 * plain SELECT under row-level security, as a role with no matching
 * policy, returns zero rows and reports success. On a health screen
 * that failure mode is the worst possible one — "nothing is wrong"
 * and "you cannot see anything" render identically, and the second
 * one is indistinguishable from an all-clear.
 *
 * So `integration.outbound_health()`, `integration.dead_outbound()`
 * and `ops.recent_notifications()` are SECURITY DEFINER, and a
 * viewer without permission gets an error rather than a calm empty
 * table.
 *
 * ── Why a dead status push is not an incident ──
 *
 * A dead INVENTORY commit means stock left a building and no ledger
 * records it. A dead GROCERY status means somebody's order page is
 * stale while their shopping sits on their doorstep. Both belong
 * here; only one of them is somebody's evening.
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

    const [health, dead, notifications] = await Promise.all([
      db.query("select * from integration.outbound_health()"),
      db.query("select * from integration.dead_outbound(25)"),
      db.query("select * from ops.recent_notifications(null, 25)"),
    ]);

    await db.query("commit");
    return {
      claims: c.claims,
      health: health.rows,
      dead: dead.rows,
      notifications: notifications.rows,
    };
  } catch (e) {
    await db.query("rollback").catch(() => {});
    return { error: (e as Error).message };
  } finally {
    db.release();
  }
}

export default async function IntegrationPage() {
  const data = await load();

  if (!data) {
    return <main style={S.page}><h1 style={S.h1}>Integration</h1>
      <p>You are not signed in, or your session has expired.</p></main>;
  }

  if ("error" in data) {
    // Said out loud rather than shown as an empty table.
    return <main style={S.page}><h1 style={S.h1}>Integration</h1>
      <p style={S.error}>Could not read the queue: {data.error}</p></main>;
  }

  const { health, dead, notifications } = data;
  const total = (s: string) =>
    health.filter((h) => h.status === s).reduce((n, h) => n + Number(h.n), 0);

  const queued = total("PENDING") + total("SENDING");
  const deadN = total("DEAD");

  return (
    <main style={S.page}>
      <h1 style={S.h1}>Integration</h1>
      <p style={S.sub}>
        Events logistics owes the rest of the estate. Nothing here is sent by a
        page load — a worker drains the queue.
      </p>

      <div style={S.cards}>
        <div style={S.card}>
          <div style={S.n}>{queued}</div><div style={S.cap}>waiting to send</div>
        </div>
        <div style={S.card}>
          <div style={S.n}>{total("DELIVERED")}</div><div style={S.cap}>delivered</div>
        </div>
        <div style={{ ...S.card, ...(deadN > 0 ? S.cardBad : {}) }}>
          <div style={S.n}>{deadN}</div><div style={S.cap}>dead — need a person</div>
        </div>
      </div>

      <h2 style={S.h2}>Queue</h2>
      {health.length === 0 ? (
        <p style={S.empty}>The queue is empty.</p>
      ) : (
        <table style={S.table}>
          <thead><tr>
            <th style={S.th}>Target</th><th style={S.th}>Status</th>
            <th style={S.thR}>Count</th><th style={S.th}>Oldest</th>
            <th style={S.th}>Next attempt</th>
          </tr></thead>
          <tbody>
            {health.map((h, i) => (
              <tr key={i}>
                <td style={S.td}>{h.target}</td>
                <td style={{ ...S.td, ...(h.status === "DEAD" ? S.bad : {}) }}>{h.status}</td>
                <td style={S.tdR}>{String(h.n)}</td>
                <td style={S.tdMuted}>{when(h.oldest)}</td>
                <td style={S.tdMuted}>{h.status === "PENDING" ? when(h.next_due) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 style={S.h2}>Dead letters</h2>
      {dead.length === 0 ? (
        <p style={S.empty}>Nothing has been given up on.</p>
      ) : (
        <table style={S.table}>
          <thead><tr>
            <th style={S.th}>When</th><th style={S.th}>Target</th>
            <th style={S.th}>Event</th><th style={S.th}>Delivery</th>
            <th style={S.th}>Last error</th>
          </tr></thead>
          <tbody>
            {dead.map((d) => (
              <tr key={String(d.id)}>
                <td style={S.tdMuted}>{when(d.created_at)}</td>
                <td style={S.td}>{d.target}</td>
                <td style={S.td}>{d.event}</td>
                <td style={S.td}>
                  {d.delivery_id ? (
                    <Link href={`/deliveries/${d.delivery_id}`} style={S.link}>
                      {d.tracking_id ?? "open"}
                    </Link>
                  ) : "—"}
                </td>
                <td style={S.tdErr}>{d.last_error}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 style={S.h2}>Recent notifications</h2>
      <p style={S.note}>
        A <code>customer_app</code> row is the notification: pushing the status to
        Grocery is what the customer sees. There is no email or SMS provider in
        this estate, so those channels record intent and send nothing.
      </p>
      {notifications.length === 0 ? (
        <p style={S.empty}>Nothing has been sent yet.</p>
      ) : (
        <table style={S.table}>
          <thead><tr>
            <th style={S.th}>When</th><th style={S.th}>Delivery</th>
            <th style={S.th}>Channel</th><th style={S.th}>Status</th>
            <th style={S.th}>Says</th>
          </tr></thead>
          <tbody>
            {notifications.map((n) => (
              <tr key={String(n.id)}>
                <td style={S.tdMuted}>{when(n.created_at)}</td>
                <td style={S.td}>
                  {n.delivery_id ? (
                    <Link href={`/deliveries/${n.delivery_id}`} style={S.link}>
                      {n.tracking_id ?? "open"}
                    </Link>
                  ) : "—"}
                </td>
                <td style={S.td}>{n.channel}</td>
                <td style={{ ...S.td, ...(n.status === "FAILED" ? S.bad : {}) }}>
                  {n.status}
                </td>
                <td style={S.tdMuted}>
                  {String((n.payload as Record<string, unknown>)?.message ?? "")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

function when(v: unknown): string {
  if (!v) return "—";
  return new Date(String(v)).toISOString().replace("T", " ").slice(0, 19);
}

const S: Record<string, React.CSSProperties> = {
  page: { maxWidth: 1100, margin: "0 auto", padding: 24, fontSize: 14 },
  h1: { fontSize: 26, margin: "0 0 4px" },
  h2: { fontSize: 16, margin: "32px 0 10px" },
  sub: { color: "#666", margin: "0 0 20px" },
  note: { color: "#666", fontSize: 13, margin: "0 0 10px" },
  cards: { display: "flex", gap: 12, flexWrap: "wrap" },
  card: { flex: "1 1 160px", padding: 16, border: "1px solid #e5e5e5",
          borderRadius: 12, background: "#fff" },
  cardBad: { borderColor: "#f5b5ad", background: "#fff6f4" },
  n: { fontSize: 30, fontWeight: 700 },
  cap: { color: "#777", fontSize: 12, marginTop: 2 },
  table: { width: "100%", borderCollapse: "collapse", background: "#fff",
           border: "1px solid #e5e5e5", borderRadius: 10, overflow: "hidden" },
  th: { textAlign: "left", padding: "9px 12px", background: "#fafafa",
        borderBottom: "1px solid #e5e5e5", fontSize: 11,
        textTransform: "uppercase", letterSpacing: 0.5, color: "#888" },
  thR: { textAlign: "right", padding: "9px 12px", background: "#fafafa",
         borderBottom: "1px solid #e5e5e5", fontSize: 11,
         textTransform: "uppercase", letterSpacing: 0.5, color: "#888" },
  td: { padding: "9px 12px", borderBottom: "1px solid #f2f2f2" },
  tdR: { padding: "9px 12px", borderBottom: "1px solid #f2f2f2", textAlign: "right",
         fontVariantNumeric: "tabular-nums" },
  tdMuted: { padding: "9px 12px", borderBottom: "1px solid #f2f2f2", color: "#777" },
  tdErr: { padding: "9px 12px", borderBottom: "1px solid #f2f2f2", color: "#8a1c10",
           fontSize: 12, maxWidth: 380, overflowWrap: "anywhere" },
  bad: { color: "#8a1c10", fontWeight: 700 },
  empty: { color: "#888" },
  error: { color: "#8a1c10" },
  link: { color: "#0b5fff", textDecoration: "none" },
};
