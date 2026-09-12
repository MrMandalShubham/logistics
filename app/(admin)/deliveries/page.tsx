import Link from "next/link";
import { cookies } from "next/headers";
import { pool } from "@/lib/db";
import { COOKIE_NAME, hashToken } from "@/lib/auth/session";
import { LABELS } from "@/lib/delivery/states";

export const dynamic = "force-dynamic";

/**
 * The delivery queue.
 *
 * A server component reading through the same claims-and-RLS path an
 * API request takes, so a dispatcher bound to SH1 sees SH1 here for
 * exactly the same reason they do over HTTP -- not because this page
 * remembered to filter.
 *
 * The interactive dispatch board is Phase 3. This is a list.
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

    const { rows } = await db.query(
      `select d.id, d.tracking_id, d.status, d.pickup_location_code,
              d.hold_status, d.hold_expires_at, d.created_at,
              a.city, a.pincode,
              (select count(*)::int from delivery.delivery_item i
                where i.delivery_id = d.id) as item_count
         from delivery.delivery d
         left join delivery.delivery_address a on a.delivery_id = d.id
        order by d.created_at desc limit 100`);

    await db.query("commit");
    return { claims: c.claims, rows };
  } catch {
    await db.query("rollback").catch(() => {});
    return null;
  } finally {
    db.release();
  }
}

export default async function DeliveriesPage() {
  const data = await load();

  if (!data) {
    return (
      <main style={S.page}>
        <h1>Deliveries</h1>
        <p>You are not signed in, or your session has expired.</p>
        <p style={S.muted}>
          Sign in with <code>POST /api/v1/auth/sign-in</code>.
        </p>
      </main>
    );
  }

  const { claims, rows } = data;
  const scope = (claims.location_codes as string[])?.length
    ? (claims.location_codes as string[]).join(", ")
    : "all locations";

  return (
    <main style={S.page}>
      <div style={S.head}>
        <h1 style={{ margin: 0 }}>Deliveries</h1>
        <span style={S.muted}>
          {claims.full_name as string} · {claims.role as string} · {scope}
        </span>
      </div>

      {rows.length === 0 ? (
        <p style={S.empty}>
          Nothing in the queue. Send one with <code>npm run demo:order</code>.
        </p>
      ) : (
        <table style={S.table}>
          <thead>
            <tr>
              {["Tracking", "Status", "Pickup", "Destination", "Items", "Hold", "Received"]
                .map((h) => <th key={h} style={S.th}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r: any) => (
              <tr key={r.id}>
                <td style={S.td}>
                  <Link href={`/deliveries/${r.id}`} style={S.link}>{r.tracking_id}</Link>
                </td>
                <td style={S.td}>{LABELS[r.status] ?? r.status}</td>
                <td style={S.td}>{r.pickup_location_code}</td>
                <td style={S.td}>{r.city ? `${r.city} ${r.pincode}` : "—"}</td>
                <td style={S.td}>{r.item_count}</td>
                <td style={{ ...S.td, color: r.hold_status === "held" ? "#1a7f37" : "#b35900" }}>
                  {r.hold_status}
                </td>
                <td style={S.td}>{new Date(r.created_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

const S: Record<string, React.CSSProperties> = {
  page: { maxWidth: 1100, margin: "48px auto", padding: "0 24px", lineHeight: 1.5 },
  head: { display: "flex", justifyContent: "space-between", alignItems: "baseline",
          borderBottom: "1px solid #ddd", paddingBottom: 12, marginBottom: 20 },
  muted: { color: "#666", fontSize: 13 },
  empty: { color: "#666", padding: "40px 0" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 14 },
  th: { textAlign: "left", padding: "8px 10px", borderBottom: "2px solid #ddd",
        fontSize: 12, textTransform: "uppercase", color: "#666", letterSpacing: 0.4 },
  td: { padding: "8px 10px", borderBottom: "1px solid #eee" },
  link: { color: "#0b5fff", textDecoration: "none", fontWeight: 600 },
};
