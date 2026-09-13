import Link from "next/link";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { pool } from "@/lib/db";
import { COOKIE_NAME, hashToken } from "@/lib/auth/session";
import { LABELS } from "@/lib/delivery/states";
import SignOutButton from "@/app/(rider)/SignOutButton";
import { rider } from "@/lib/ui/rider";
import { neutral, semantic, radius, font } from "@/lib/ui/theme";

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

      <h2 style={S.h}>
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

      {/* Q32. Signing out wipes the outbox, which holds customers'
          addresses and door instructions — on a shared phone that is
          the last rider's round. It syncs first and refuses to
          discard unsent work without being told twice. */}
      <SignOutButton />
    </main>
  );
}

const S: Record<string, React.CSSProperties> = {
  page: rider.page,
  header: { display: "flex", justifyContent: "space-between", alignItems: "center",
            marginBottom: 20, gap: 12 },
  code: { ...rider.tracking, fontSize: 13, color: neutral[500] },
  name: { fontSize: 21, fontWeight: 700, color: neutral[900], lineHeight: 1.2 },

  // A shift toggle is a decision, so it shows the state it is IN, not
  // the state it would move to. Green means you are taking work.
  online: { minHeight: 48, padding: "12px 20px", border: 0, borderRadius: radius.pill,
            background: semantic.success, color: neutral[0],
            fontSize: 15, fontWeight: 700, cursor: "pointer", fontFamily: font },
  offline: { minHeight: 48, padding: "12px 20px", border: `1px solid ${neutral[200]}`,
             borderRadius: radius.pill, background: neutral[0], color: neutral[500],
             fontSize: 15, fontWeight: 700, cursor: "pointer", fontFamily: font },

  warn: { background: semantic.attentionSoft, border: `1px solid ${semantic.attentionEdge}`,
          color: semantic.attention, borderRadius: radius.lg, padding: "12px 14px",
          fontSize: 14.5, marginBottom: 16 },

  h1: { fontSize: 24, fontWeight: 700, color: neutral[900], margin: "24px 0 6px" },
  h: { fontSize: 15, fontWeight: 700, color: neutral[900], margin: "0 0 12px" },
  muted: { color: neutral[500] },
  list: { listStyle: "none", padding: 0, margin: 0,
          display: "flex", flexDirection: "column", gap: 12 },
  card: rider.card,
  cardTop: { display: "flex", alignItems: "center", gap: 8, marginBottom: 6 },
  tracking: rider.tracking,
  newBadge: { background: semantic.accent, color: neutral[0], fontSize: 10.5,
              fontWeight: 800, letterSpacing: 0.6, padding: "3px 8px",
              borderRadius: radius.pill },
  status: { color: semantic.accent, fontWeight: 700, fontSize: 14.5, marginBottom: 4 },
  where: { color: neutral[500], fontSize: 14 },
};
