import Link from "next/link";
import { cookies } from "next/headers";
import { pool } from "@/lib/db";
import { COOKIE_NAME, hashToken } from "@/lib/auth/session";
import { ridersForDispatch, queueForDispatch, inFlight } from "@/lib/fleet/dispatch";
import { assignDelivery } from "@/app/actions/dispatch";

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
 * Inventory exposes no coordinates for its shops (open question Q21),
 * so a map could plot the destination and not the origin. A
 * half-drawn map is worse than a list, and a list is what somebody
 * handling tens of orders a day actually works from.
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

    const [queue, riders, active] = await Promise.all([
      queueForDispatch(db), ridersForDispatch(db), inFlight(db),
    ]);

    await db.query("commit");
    return { claims: c.claims, queue, riders, active };
  } catch {
    await db.query("rollback").catch(() => {});
    return null;
  } finally {
    db.release();
  }
}

export default async function DispatchPage() {
  const data = await load();

  if (!data) {
    return (
      <main style={S.page}>
        <h1>Dispatch</h1>
        <p>You are not signed in, or your session has expired.</p>
      </main>
    );
  }

  const { claims, queue, riders, active } = data;
  const perms = (claims.permissions as string[]) ?? [];
  const mayAssign = perms.includes("deliveries:assign");
  const available = riders.filter((r) => r.unavailable_reason === null);

  async function assign(formData: FormData) {
    "use server";
    await assignDelivery(
      String(formData.get("delivery_id")), String(formData.get("rider_id")));
  }

  return (
    <main style={S.page}>
      <div style={S.head}>
        <h1 style={{ margin: 0 }}>Dispatch</h1>
        <nav style={S.nav}>
          <Link href="/deliveries" style={S.link}>Deliveries</Link>
          <Link href="/riders" style={S.link}>Riders</Link>
        </nav>
      </div>

      <div style={S.summary}>
        <Stat n={queue.length} label="waiting" />
        <Stat n={available.length} label={`available of ${riders.length} riders`} />
        <Stat n={active.length} label="out" />
        <Stat
          n={active.filter((a: { assignment_status: string }) => a.assignment_status === "OFFERED").length}
          label="awaiting a reply"
        />
      </div>

      {!mayAssign && (
        <p style={S.note}>
          Your role can see the board but not assign. That needs <code>deliveries:assign</code>.
        </p>
      )}

      <h2 style={S.h2}>Waiting for a rider</h2>
      {queue.length === 0 ? (
        <p style={S.muted}>
          Nothing waiting. Admit a delivery from the <Link href="/deliveries" style={S.link}>queue</Link> first.
        </p>
      ) : (
        <table style={S.table}>
          <thead>
            <tr>{["Tracking", "Pickup", "Destination", "Items", "Hold", "Assign to"]
              .map((h) => <th key={h} style={S.th}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {queue.map((d: Record<string, unknown>) => (
              <tr key={String(d.id)}>
                <td style={S.td}>
                  <Link href={`/deliveries/${d.id}`} style={S.link}>{String(d.tracking_id)}</Link>
                </td>
                <td style={S.td}>{String(d.pickup_location_code)}</td>
                <td style={S.td}>{d.city ? `${d.city} ${d.pincode}` : "—"}</td>
                <td style={S.td}>{String(d.item_count)}</td>
                <td style={{ ...S.td, color: d.hold_status === "held" ? "#1a7f37" : "#b35900" }}>
                  {String(d.hold_status)}
                </td>
                <td style={S.td}>
                  {mayAssign && available.length > 0 ? (
                    <form action={assign} style={S.form}>
                      <input type="hidden" name="delivery_id" value={String(d.id)} />
                      <select name="rider_id" style={S.select} defaultValue={available[0].id}>
                        {available.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.code} · {r.display_name} ({r.active_count}/{r.max_concurrent})
                          </option>
                        ))}
                      </select>
                      <button type="submit" style={S.button}>Assign</button>
                    </form>
                  ) : (
                    <span style={S.muted}>
                      {!mayAssign ? "—" : "no rider available"}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 style={S.h2}>Out now</h2>
      {active.length === 0 ? (
        <p style={S.muted}>Nothing is out.</p>
      ) : (
        <table style={S.table}>
          <thead>
            <tr>{["Tracking", "Rider", "State", "Offer expires", "Destination"]
              .map((h) => <th key={h} style={S.th}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {active.map((a: Record<string, unknown>) => (
              <tr key={String(a.id)}>
                <td style={S.td}>
                  <Link href={`/deliveries/${a.id}`} style={S.link}>{String(a.tracking_id)}</Link>
                </td>
                <td style={S.td}>{String(a.rider_code)} · {String(a.rider_name)}</td>
                <td style={S.td}>
                  {a.assignment_status === "OFFERED"
                    ? <span style={S.pending}>awaiting reply</span>
                    : <span style={S.accepted}>accepted</span>}
                </td>
                <td style={S.td}>
                  {a.assignment_status === "OFFERED" && a.expires_at
                    ? new Date(String(a.expires_at)).toLocaleTimeString()
                    : "—"}
                </td>
                <td style={S.td}>{a.city ? `${a.city} ${a.pincode}` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 style={S.h2}>Riders</h2>
      <table style={S.table}>
        <thead>
          <tr>{["Rider", "Vehicle", "Base", "Load", "State"]
            .map((h) => <th key={h} style={S.th}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {riders.map((r) => (
            <tr key={r.id}>
              <td style={S.td}>{r.code} · {r.display_name}</td>
              <td style={S.td}>{r.vehicle_type.toLowerCase()}</td>
              <td style={S.td}>{r.home_location_code ?? "any"}</td>
              <td style={S.td}>{r.active_count}/{r.max_concurrent}</td>
              <td style={S.td}>
                {/* Unavailable riders are shown, not hidden. A name that
                    quietly vanishes just looks like a missing rider. */}
                {r.unavailable_reason
                  ? <span style={S.unavailable}>{r.unavailable_reason}</span>
                  : <span style={S.accepted}>available</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <div style={S.stat}>
      <div style={S.statN}>{n}</div>
      <div style={S.statL}>{label}</div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  page: { maxWidth: 1200, margin: "40px auto", padding: "0 24px", lineHeight: 1.5 },
  head: { display: "flex", justifyContent: "space-between", alignItems: "baseline",
          borderBottom: "1px solid #ddd", paddingBottom: 12, marginBottom: 20 },
  nav: { display: "flex", gap: 16 },
  summary: { display: "flex", gap: 32, margin: "20px 0 8px" },
  stat: { minWidth: 90 },
  statN: { fontSize: 30, fontWeight: 700, lineHeight: 1.1 },
  statL: { fontSize: 12, color: "#777", textTransform: "uppercase", letterSpacing: 0.4 },
  h2: { fontSize: 14, textTransform: "uppercase", color: "#666", letterSpacing: 0.5,
        marginTop: 34, borderBottom: "1px solid #eee", paddingBottom: 6 },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 14 },
  th: { textAlign: "left", padding: "8px 10px", borderBottom: "2px solid #ddd",
        fontSize: 11, textTransform: "uppercase", color: "#666", letterSpacing: 0.4 },
  td: { padding: "8px 10px", borderBottom: "1px solid #eee", verticalAlign: "middle" },
  form: { display: "flex", gap: 6, alignItems: "center" },
  select: { padding: "5px 8px", border: "1px solid #ccc", borderRadius: 6, fontSize: 13 },
  button: { padding: "6px 14px", background: "#0b5fff", color: "white", border: 0,
            borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: "pointer" },
  link: { color: "#0b5fff", textDecoration: "none", fontWeight: 600 },
  muted: { color: "#777", fontSize: 13 },
  note: { background: "#fff8e6", border: "1px solid #ffe0a3", borderRadius: 8,
          padding: "8px 12px", fontSize: 13 },
  pending: { color: "#b35900", fontWeight: 600 },
  accepted: { color: "#1a7f37", fontWeight: 600 },
  unavailable: { color: "#999" },
};
