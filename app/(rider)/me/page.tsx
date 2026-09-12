import Link from "next/link";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { pool } from "@/lib/db";
import { COOKIE_NAME, hashToken } from "@/lib/auth/session";
import { LABELS } from "@/lib/delivery/states";

export const dynamic = "force-dynamic";

/**
 * The rider's day.
 *
 * Built for a phone held in one hand, in the rain, by somebody who is
 * about to get back on a bike. One screen, big targets, no navigation
 * chrome to get lost in.
 *
 * Offline support — the service worker and the outbox — is Phase 4b.
 * This screen assumes a connection and says so when it does not have
 * one.
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

    const { rows: [me] } = await db.query(
      `select id, code, display_name, status, is_online, active_count, max_concurrent
         from fleet.rider_current where user_id = $1`, [c.claims.sub]);

    const tasks = me
      ? (await db.query(
          `select d.id, d.tracking_id, d.status, d.pickup_location_code,
                  a.city, a.pincode, a.line1,
                  asg.status as assignment_status
             from delivery.delivery d
             join fleet.assignment asg
               on asg.delivery_id = d.id and asg.status in ('OFFERED','ACCEPTED')
             join fleet.rider r on r.id = asg.rider_id
             left join delivery.delivery_address a on a.delivery_id = d.id
            where r.user_id = $1
            order by asg.assigned_at`, [c.claims.sub])).rows
      : [];

    await db.query("commit");
    return { claims: c.claims, me, tasks };
  } catch {
    await db.query("rollback").catch(() => {});
    return null;
  } finally {
    db.release();
  }
}

export default async function RiderHome() {
  const data = await load();

  if (!data) {
    return (
      <main style={S.page}>
        <h1 style={S.h1}>Sign in</h1>
        <p style={S.muted}>Your session has expired.</p>
      </main>
    );
  }

  const { me, tasks } = data;

  if (!me) {
    return (
      <main style={S.page}>
        <h1 style={S.h1}>Not a rider</h1>
        <p style={S.muted}>This account has no rider profile.</p>
      </main>
    );
  }

  async function toggle() {
    "use server";
    const token = (await cookies()).get(COOKIE_NAME)?.value;
    if (!token) return;

    const db = await pool.connect();
    try {
      const { rows: [c] } = await db.query(
        "select identity.resolve_session($1) as claims", [hashToken(token)]);
      if (!c?.claims) return;

      await db.query("begin");
      await db.query("select set_config('request.jwt.claims',$1,true)",
        [JSON.stringify(c.claims)]);
      await db.query("set local role authenticated");

      const { rows: [r] } = await db.query(
        "select id, is_online from fleet.rider_current where user_id = $1", [c.claims.sub]);

      if (r) {
        await db.query("select fleet.set_availability($1,$2,'from my phone')",
          [r.id, !r.is_online]);
      }
      await db.query("commit");
    } catch {
      await db.query("rollback").catch(() => {});
    } finally {
      db.release();
    }
    revalidatePath("/me");
  }

  return (
    <main style={S.page}>
      <div style={S.header}>
        <div>
          <div style={S.code}>{me.code}</div>
          <div style={S.name}>{me.display_name}</div>
        </div>
        <form action={toggle}>
          <button type="submit" style={me.is_online ? S.online : S.offline}>
            {me.is_online ? "Online" : "Offline"}
          </button>
        </form>
      </div>

      {me.status !== "ACTIVE" && (
        <p style={S.warn}>
          Your account is {me.status.toLowerCase()}. Speak to dispatch.
        </p>
      )}

      <h2 style={S.h2}>
        {tasks.length === 0 ? "Nothing yet" : `${tasks.length} job${tasks.length > 1 ? "s" : ""}`}
      </h2>

      {tasks.length === 0 ? (
        <p style={S.muted}>
          {me.is_online
            ? "You are online. Dispatch will send you something."
            : "Go online to start receiving jobs."}
        </p>
      ) : (
        <ul style={S.list}>
          {tasks.map((t: Record<string, unknown>) => (
            <li key={String(t.id)}>
              <Link href={`/me/tasks/${t.id}`} style={S.card}>
                <div style={S.cardTop}>
                  <span style={S.tracking}>{String(t.tracking_id)}</span>
                  {t.assignment_status === "OFFERED" && (
                    <span style={S.newBadge}>NEW</span>
                  )}
                </div>
                <div style={S.status}>
                  {LABELS[String(t.status)] ?? String(t.status)}
                </div>
                <div style={S.where}>
                  Collect {String(t.pickup_location_code)}
                  {t.city ? ` · deliver to ${t.city} ${t.pincode}` : ""}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

const S: Record<string, React.CSSProperties> = {
  page: { maxWidth: 560, margin: "0 auto", padding: "20px 16px 60px",
          fontSize: 16, lineHeight: 1.5 },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center",
            paddingBottom: 16, borderBottom: "1px solid #e5e5e5" },
  code: { fontSize: 12, color: "#888", letterSpacing: 1, textTransform: "uppercase" },
  name: { fontSize: 20, fontWeight: 700 },
  h1: { fontSize: 22 },
  h2: { fontSize: 13, textTransform: "uppercase", letterSpacing: 0.6,
        color: "#777", marginTop: 28 },
  // Big enough to hit with a thumb, wearing a glove.
  online: { padding: "12px 22px", background: "#1a7f37", color: "white", border: 0,
            borderRadius: 999, fontSize: 15, fontWeight: 700, cursor: "pointer" },
  offline: { padding: "12px 22px", background: "#fff", color: "#666",
             border: "2px solid #ccc", borderRadius: 999, fontSize: 15,
             fontWeight: 700, cursor: "pointer" },
  warn: { background: "#fff5e6", border: "1px solid #ffd699", borderRadius: 10,
          padding: "12px 14px", fontSize: 14 },
  list: { listStyle: "none", padding: 0, margin: 0, display: "flex",
          flexDirection: "column", gap: 12 },
  card: { display: "block", padding: 16, border: "1px solid #e0e0e0", borderRadius: 14,
          textDecoration: "none", color: "inherit", background: "#fff" },
  cardTop: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  tracking: { fontWeight: 700, fontSize: 17 },
  newBadge: { background: "#0b5fff", color: "white", fontSize: 11, fontWeight: 700,
              padding: "3px 9px", borderRadius: 999, letterSpacing: 0.5 },
  status: { color: "#0b5fff", fontWeight: 600, fontSize: 14, marginTop: 4 },
  where: { color: "#666", fontSize: 14, marginTop: 6 },
  muted: { color: "#777" },
};
