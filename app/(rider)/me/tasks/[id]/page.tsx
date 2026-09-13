import Link from "next/link";
import { cookies } from "next/headers";
import { pool } from "@/lib/db";
import { COOKIE_NAME, hashToken } from "@/lib/auth/session";
import { LABELS, RIDER_STEP, type DeliveryStatus } from "@/lib/delivery/states";
import TaskActions from "@/app/(rider)/TaskActions";
import { rider } from "@/lib/ui/rider";
import { neutral, semantic, radius } from "@/lib/ui/theme";

export const dynamic = "force-dynamic";

/**
 * One job, one obvious next thing to do.
 *
 * The rider is on a doorstep. Everything here is sized for a thumb
 * and reduced to the single action that comes next — the state
 * machine decides which, so a button can never offer a move the
 * database would refuse.
 */
async function withSession<T>(fn: (db: import("pg").PoolClient, claims: Record<string, unknown>) => Promise<T>): Promise<T | null> {
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

    const out = await fn(db, c.claims);
    await db.query("commit");
    return out;
  } catch (e) {
    await db.query("rollback").catch(() => {});
    throw e;
  } finally {
    db.release();
  }
}

export default async function TaskPage({
  params,
}: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const data = await withSession(async (db) => {
    const { rows: [d] } = await db.query(
      `select id, tracking_id, status, pickup_location_code,
              payment_method, is_prepaid, amount_to_collect_paise
         from delivery.delivery where id = $1`, [id]);

    if (!d) return { task: null, address: null, items: [] };

    const [a, items] = await Promise.all([
      db.query(`select recipient_name, line1, line2, city, pincode, lat, lng, instructions
                  from delivery.delivery_address where delivery_id = $1`, [id]),
      db.query(`select sku, name, quantity from delivery.delivery_item
                 where delivery_id = $1 order by name`, [id]),
    ]);

    return { task: d, address: a.rows[0] ?? null, items: items.rows };
  }).catch(() => null);

  if (!data) {
    return <main style={S.page}><p>Your session has expired.</p></main>;
  }

  if (!data.task) {
    // The same answer whether it does not exist or is not theirs.
    return (
      <main style={S.page}>
        <Link href="/me" style={S.back}>← My jobs</Link>
        <h1 style={S.h1}>Not your job</h1>
      </main>
    );
  }

  const { task: d, address: a, items } = data;
  const step = RIDER_STEP[d.status as DeliveryStatus] ?? null;
  const canComplete = d.status === "ARRIVED";
  const isDone = ["DELIVERED", "RETURNED", "CANCELLED"].includes(d.status);
  // The job has turned around: the destination is now the shop.
  const returning = ["RETURN_REQUIRED", "RETURN_IN_TRANSIT"].includes(d.status);

  return (
    <main style={S.page}>
      <Link href="/me" style={S.back}>← My jobs</Link>

      <h1 style={S.h1}>{d.tracking_id}</h1>
      <div style={S.status}>{LABELS[d.status] ?? d.status}</div>

      {returning && (
        <section style={S.returning}>
          <div style={S.label}>Take it back</div>
          <p style={S.returningText}>
            This one is going back to <strong>{d.pickup_location_code}</strong>.
            Do not attempt the address below — dispatch has already told the customer.
          </p>
        </section>
      )}

      {a && !returning && (
        <section style={S.block}>
          <div style={S.label}>Deliver to</div>
          <div style={S.address}>
            <strong>{a.recipient_name}</strong><br />
            {a.line1}{a.line2 ? <>, {a.line2}</> : null}<br />
            {a.city} {a.pincode}
          </div>
          {a.instructions && <p style={S.instructions}>{a.instructions}</p>}

          <div style={S.row}>
            <a
              href={`https://www.google.com/maps/dir/?api=1&destination=${a.lat},${a.lng}`}
              target="_blank" rel="noreferrer" style={S.secondary}
            >
              Navigate
            </a>
            {/* The number is not on this page. Fetching it is recorded. */}
            <a href={`/api/v1/me/tasks/${id}/contact`} style={S.secondaryMuted}>
              Show phone
            </a>
          </div>
        </section>
      )}

      <section style={S.block}>
        <div style={S.label}>
          {returning
            ? `Hand back at ${d.pickup_location_code}`
            : `Collect from ${d.pickup_location_code}`}
        </div>
        <ul style={S.items}>
          {items.map((i: Record<string, unknown>) => (
            <li key={String(i.sku)} style={S.item}>
              <strong>{String(i.quantity)}×</strong> {String(i.name)}
            </li>
          ))}
        </ul>
        {!d.is_prepaid && d.amount_to_collect_paise > 0 && (
          <p style={S.collect}>
            Collect ₹{(Number(d.amount_to_collect_paise) / 100).toFixed(2)}
          </p>
        )}
      </section>

      {isDone ? (
        <p style={S.done}>This job is finished.</p>
      ) : (
        /* Client-side on purpose: every tap is captured to the outbox
           with its own id and timestamp BEFORE anything is sent, so a
           rider with no signal is never left wondering whether it
           counted. */
        <TaskActions
          deliveryId={d.id}
          status={d.status}
          nextStep={step}
          canComplete={canComplete}
        />
      )}
    </main>
  );
}

const S: Record<string, React.CSSProperties> = {
  page: rider.page,
  back: { color: semantic.accent, textDecoration: "none", fontSize: 15, fontWeight: 600,
          display: "inline-block", minHeight: 44, lineHeight: "44px" },
  h1: { fontSize: 26, fontWeight: 700, color: neutral[900], margin: "4px 0 2px" },
  status: { color: semantic.accent, fontWeight: 700, fontSize: 15, marginBottom: 20 },

  block: rider.block,
  label: rider.label,
  address: rider.address,

  // Door instructions are the one thing a rider must not skim past.
  instructions: { background: semantic.attentionSoft,
                  border: `1px solid ${semantic.attentionEdge}`,
                  borderRadius: radius.md, padding: "10px 13px",
                  fontSize: 14.5, marginTop: 12, color: neutral[900] },

  row: { display: "flex", gap: 10, marginTop: 14 },
  items: { listStyle: "none", padding: 0, margin: 0 },
  item: { padding: "9px 0", borderBottom: `1px solid ${neutral[100]}`, fontSize: 16 },
  collect: { marginTop: 14, fontWeight: 700, fontSize: 17, color: semantic.attention },

  secondary: rider.secondary,
  secondaryMuted: rider.quiet,

  done: { background: semantic.successSoft, border: `1px solid ${semantic.successEdge}`,
          borderRadius: radius.lg, padding: 18, textAlign: "center",
          fontWeight: 700, fontSize: 16, color: semantic.success },

  returning: { padding: 16, border: `1px solid ${semantic.attentionEdge}`,
               background: semantic.attentionSoft, borderRadius: radius.lg,
               marginBottom: 14 },
  returningText: { fontSize: 16.5, lineHeight: 1.5, margin: "4px 0 0", color: neutral[900] },
};
