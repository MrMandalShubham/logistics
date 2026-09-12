import Link from "next/link";
import { cookies } from "next/headers";
import { pool } from "@/lib/db";
import { COOKIE_NAME, hashToken } from "@/lib/auth/session";
import { ridersForDispatch } from "@/lib/fleet/dispatch";
import { setRiderAvailability, setRiderStatus } from "@/app/actions/dispatch";

export const dynamic = "force-dynamic";

/**
 * Rider management.
 *
 * Onboarding is an API call rather than a form, because it returns a
 * one-time password that must be handed over deliberately — putting
 * it on a page that anyone might leave open is the wrong shape for a
 * credential.
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

    const riders = await ridersForDispatch(db);
    await db.query("commit");
    return { claims: c.claims, riders };
  } catch {
    await db.query("rollback").catch(() => {});
    return null;
  } finally {
    db.release();
  }
}

export default async function RidersPage() {
  const data = await load();

  if (!data) {
    return <main style={S.page}><h1>Riders</h1><p>Not signed in.</p></main>;
  }

  const { claims, riders } = data;
  const perms = (claims.permissions as string[]) ?? [];
  const mayToggle = perms.includes("riders:availability");
  const mayManage = perms.includes("riders:write");

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
    <main style={S.page}>
      <div style={S.head}>
        <h1 style={{ margin: 0 }}>Riders</h1>
        <nav style={S.nav}>
          <Link href="/dispatch" style={S.link}>Dispatch</Link>
          <Link href="/deliveries" style={S.link}>Deliveries</Link>
        </nav>
      </div>

      {riders.length === 0 ? (
        <div style={S.empty}>
          <p>No riders yet.</p>
          <p style={S.muted}>Onboard one — it returns a one-time password:</p>
          <pre style={S.pre}>{`POST /api/v1/riders
{
  "email": "rider@example.com",
  "display_name": "Imran K",
  "phone": "+919876543210",
  "vehicle_type": "BIKE",
  "home_location": "SH1"
}`}</pre>
        </div>
      ) : (
        <table style={S.table}>
          <thead>
            <tr>{["Rider", "Contact", "Vehicle", "Base", "Load", "State", "Availability", "Status"]
              .map((h) => <th key={h} style={S.th}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {riders.map((r) => (
              <tr key={r.id}>
                <td style={S.td}><strong>{r.code}</strong><br />
                  <span style={S.muted}>{r.display_name}</span></td>
                <td style={{ ...S.td, ...S.muted }}>{r.phone}</td>
                <td style={S.td}>{r.vehicle_type.toLowerCase()}</td>
                <td style={S.td}>{r.home_location_code ?? "any"}</td>
                <td style={S.td}>{r.active_count}/{r.max_concurrent}</td>
                <td style={S.td}>
                  {r.unavailable_reason
                    ? <span style={S.unavailable}>{r.unavailable_reason}</span>
                    : <span style={S.ok}>available</span>}
                </td>
                <td style={S.td}>
                  {mayToggle && r.status === "ACTIVE" ? (
                    <form action={toggle}>
                      <input type="hidden" name="rider_id" value={r.id} />
                      <input type="hidden" name="online" value={String(!r.is_online)} />
                      <button type="submit" style={r.is_online ? S.buttonOff : S.buttonOn}>
                        {r.is_online ? "Set offline" : "Set online"}
                      </button>
                    </form>
                  ) : <span style={S.muted}>—</span>}
                </td>
                <td style={S.td}>
                  {mayManage && r.status !== "OFFBOARDED" ? (
                    <form action={changeStatus} style={S.form}>
                      <input type="hidden" name="rider_id" value={r.id} />
                      <select name="status" defaultValue={r.status} style={S.select}>
                        <option value="ACTIVE">active</option>
                        <option value="SUSPENDED">suspended</option>
                        <option value="OFFBOARDED">offboarded</option>
                      </select>
                      <button type="submit" style={S.buttonPlain}>Apply</button>
                    </form>
                  ) : <span style={S.muted}>{r.status.toLowerCase()}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p style={S.footnote}>
        Offboarding also disables the login — a roster change that leaves the door open
        is not an offboarding.
      </p>
    </main>
  );
}

const S: Record<string, React.CSSProperties> = {
  page: { maxWidth: 1150, margin: "40px auto", padding: "0 24px", lineHeight: 1.5 },
  head: { display: "flex", justifyContent: "space-between", alignItems: "baseline",
          borderBottom: "1px solid #ddd", paddingBottom: 12, marginBottom: 20 },
  nav: { display: "flex", gap: 16 },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 14 },
  th: { textAlign: "left", padding: "8px 10px", borderBottom: "2px solid #ddd",
        fontSize: 11, textTransform: "uppercase", color: "#666", letterSpacing: 0.4 },
  td: { padding: "10px", borderBottom: "1px solid #eee", verticalAlign: "middle" },
  form: { display: "flex", gap: 6, alignItems: "center" },
  select: { padding: "4px 8px", border: "1px solid #ccc", borderRadius: 6, fontSize: 13 },
  buttonOn: { padding: "5px 12px", background: "#1a7f37", color: "white", border: 0,
              borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer" },
  buttonOff: { padding: "5px 12px", background: "#fff", color: "#b35900",
               border: "1px solid #ffd699", borderRadius: 6, fontSize: 12,
               fontWeight: 600, cursor: "pointer" },
  buttonPlain: { padding: "5px 12px", background: "#f2f2f2", border: "1px solid #ccc",
                 borderRadius: 6, fontSize: 12, cursor: "pointer" },
  link: { color: "#0b5fff", textDecoration: "none", fontWeight: 600 },
  muted: { color: "#777", fontSize: 13 },
  ok: { color: "#1a7f37", fontWeight: 600 },
  unavailable: { color: "#999" },
  empty: { padding: "40px 0" },
  pre: { background: "#f6f6f4", border: "1px solid #e3e3df", borderRadius: 8,
         padding: 14, fontSize: 12, overflowX: "auto" },
  footnote: { marginTop: 28, fontSize: 12, color: "#888" },
};
