import Link from "next/link";
import { cookies } from "next/headers";
import { pool } from "@/lib/db";
import { COOKIE_NAME, hashToken } from "@/lib/auth/session";
import { LABELS, allowedNext } from "@/lib/delivery/states";
import { assignmentHistory, ridersForDispatch } from "@/lib/fleet/dispatch";
import { assignDelivery, admitDelivery } from "@/app/actions/dispatch";
import { neutral, semantic } from "@/lib/ui/theme";

export const dynamic = "force-dynamic";

/**
 * One delivery: what is in the bag, where it is going, and everything
 * that has happened to it.
 *
 * The timeline is the point of this screen. Because every transition
 * is recorded with its actor and reason, "what happened to this
 * order" is answerable here — which is something nobody in this
 * estate could do before.
 *
 * Actions are rendered from the state machine rather than hard-coded,
 * so a button never offers a move the database will refuse.
 */
async function load(id: string) {
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

    const { rows: [d] } = await db.query(
      `select * from delivery.delivery where id = $1`, [id]);

    // One shape on every path. An early return with fewer fields makes
    // the caller's narrowing depend on a branch it cannot see.
    if (!d) {
      await db.query("commit");
      return { claims: c.claims, delivery: null, address: null, items: [],
               timeline: [], attempts: [], riders: [] };
    }

    const [addr, items, timeline, attempts, riders] = await Promise.all([
      db.query(`select * from delivery.delivery_address where delivery_id = $1`, [id]),
      db.query(`select sku, name, quantity, reservation_id
                  from delivery.delivery_item where delivery_id = $1 order by name`, [id]),
      db.query(`select from_status, to_status, actor_role, actor_kind, reason_code,
                       note, occurred_at
                  from delivery.delivery_status_history
                 where delivery_id = $1 order by occurred_at, id`, [id]),
      assignmentHistory(db, id),
      ridersForDispatch(db),
    ]);

    await db.query("commit");
    return {
      claims: c.claims, delivery: d,
      address: addr.rows[0] ?? null, items: items.rows, timeline: timeline.rows,
      attempts, riders,
    };
  } catch {
    await db.query("rollback").catch(() => {});
    return null;
  } finally {
    db.release();
  }
}

export default async function DeliveryDetail({
  params,
}: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await load(id);

  if (!data) {
    return <main style={S.page}><h1>Delivery</h1><p>Not signed in.</p></main>;
  }
  if (!data.delivery) {
    // Deliberately the same answer whether it does not exist or is at
    // a shop this dispatcher cannot see.
    return (
      <main style={S.page}>
        <h1>Delivery</h1>
        <p>No such delivery.</p>
        <Link href="/deliveries" style={S.link}>← Back to the queue</Link>
      </main>
    );
  }

  const { delivery: d, address: a, items, timeline, attempts, riders, claims } = data;
  const perms = (claims.permissions as string[]) ?? [];
  const next = allowedNext(d.status);

  const current = attempts.find(
    (x: { status: string }) => x.status === "OFFERED" || x.status === "ACCEPTED") ?? null;
  const available = riders.filter((r) => r.unavailable_reason === null);
  const mayAssign = perms.includes("deliveries:assign");
  const mayAdmit = perms.includes("deliveries:admit");

  async function assign(formData: FormData) {
    "use server";
    await assignDelivery(String(formData.get("delivery_id")), String(formData.get("rider_id")));
  }

  async function admit(formData: FormData) {
    "use server";
    await admitDelivery(String(formData.get("delivery_id")));
  }

  const holdBad = d.hold_status !== "held";

  return (
    <main style={S.page}>
      <Link href="/deliveries" style={S.link}>← Queue</Link>

      <div style={S.head}>
        <h1 style={{ margin: 0 }}>{d.tracking_id}</h1>
        <span style={S.badge}>{LABELS[d.status] ?? d.status}</span>
      </div>

      {holdBad && (
        <p style={S.warn}>
          Inventory hold is <strong>{d.hold_status}</strong>, not <strong>held</strong>.
          {d.hold_status === "unknown"
            ? " Inventory could not be reached at ingest, so the stock was never verified."
            : " The stock may not be allocated."}
        </p>
      )}

      <section style={S.grid}>
        <Field label="Order">{d.external_order_id}</Field>
        <Field label="Pickup">{d.pickup_location_code}</Field>
        <Field label="Payment">
          {d.payment_method ?? "—"} {d.is_prepaid ? "(prepaid)" : "(collect on delivery)"}
        </Field>
        <Field label="To collect">
          {d.amount_to_collect_paise > 0
            ? `₹${(d.amount_to_collect_paise / 100).toFixed(2)}`
            : "nothing"}
        </Field>
        <Field label="Hold expires">
          {d.hold_expires_at ? new Date(d.hold_expires_at).toLocaleString() : "—"}
        </Field>
        <Field label="Received">{new Date(d.created_at).toLocaleString()}</Field>
      </section>

      <h2 style={S.h2}>Deliver to</h2>
      {a ? (
        <address style={S.addr}>
          <strong>{a.recipient_name}</strong><br />
          {a.phone}<br />
          {a.line1}{a.line2 ? <>, {a.line2}</> : null}<br />
          {a.city} {a.pincode}<br />
          <span style={S.muted}>{a.lat}, {a.lng}</span>
          {a.instructions ? <><br /><em>{a.instructions}</em></> : null}
        </address>
      ) : <p style={S.muted}>No address — this delivery should not exist.</p>}

      <h2 style={S.h2}>In the bag</h2>
      <table style={S.table}>
        <tbody>
          {items.map((i: any) => (
            <tr key={i.sku}>
              <td style={{ ...S.td, width: 60 }}>{i.quantity}×</td>
              <td style={S.td}>{i.name}</td>
              <td style={{ ...S.td, color: neutral[500] }}>{i.sku}</td>
              <td style={{ ...S.td, color: neutral[400], fontSize: 12 }}>
                {i.reservation_id ? "hold id known" : "no hold id (Q4)"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 style={S.h2}>Timeline</h2>
      <ol style={S.timeline}>
        {timeline.map((t: any, n: number) => (
          <li key={n} style={S.event}>
            <span style={S.when}>{new Date(t.occurred_at).toLocaleString()}</span>
            <strong>{LABELS[t.to_status] ?? t.to_status}</strong>
            {t.from_status ? <span style={S.muted}> from {LABELS[t.from_status]}</span> : null}
            <span style={S.muted}>
              {" · "}{t.actor_role ?? "system"}
              {t.reason_code ? ` · ${t.reason_code}` : ""}
            </span>
            {t.note ? <div style={S.note}>{t.note}</div> : null}
          </li>
        ))}
      </ol>

      <h2 style={S.h2}>Rider</h2>
      {current ? (
        <p>
          <strong>{current.rider_code}</strong> · {current.rider_name}
          {" — "}
          {current.status === "OFFERED"
            ? <span style={S.pending}>
                awaiting a reply, offer expires {new Date(current.expires_at).toLocaleTimeString()}
              </span>
            : <span style={S.ok}>accepted</span>}
        </p>
      ) : (
        <p style={S.muted}>Nobody is carrying this.</p>
      )}

      {attempts.length > 0 && (
        <table style={S.table}>
          <thead>
            <tr>{["Rider", "Offered", "Outcome", "Reason"].map((h) =>
              <th key={h} style={S.th}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {/* Superseded attempts are included on purpose: "who was asked
                first" is the question a complaint turns on. */}
            {attempts.map((x: Record<string, unknown>) => (
              <tr key={String(x.id)}>
                <td style={S.td}>{String(x.rider_code)} · {String(x.rider_name)}</td>
                <td style={S.td}>{new Date(String(x.assigned_at)).toLocaleString()}</td>
                <td style={S.td}>{String(x.status).toLowerCase()}</td>
                <td style={{ ...S.td, ...S.muted }}>
                  {x.decline_reason ? String(x.decline_reason) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 style={S.h2}>Actions</h2>
      {next.length === 0 ? (
        <p style={S.muted}>This delivery has reached a terminal state.</p>
      ) : (
        <div style={S.actionRow}>
          {/* Rendered from the state machine, so a button never offers a
              move the database will refuse. */}
          {next.includes("READY_FOR_ASSIGNMENT") && d.status === "RECEIVED" && mayAdmit && (
            <form action={admit}>
              <input type="hidden" name="delivery_id" value={d.id} />
              <button type="submit" style={S.button}>Admit to dispatch</button>
            </form>
          )}

          {next.includes("ASSIGNED") && mayAssign && (
            available.length > 0 ? (
              <form action={assign} style={S.form}>
                <input type="hidden" name="delivery_id" value={d.id} />
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
                No rider is available. See <Link href="/riders" style={S.link}>Riders</Link>.
              </span>
            )
          )}

          {next.includes("CANCELLED") && (
            <span style={S.muted}>
              Cancel: <code>POST /api/v1/deliveries/{d.id}/cancel</code>
              {perms.includes("deliveries:cancel") ? "" : " — needs deliveries:cancel"}
            </span>
          )}
        </div>
      )}
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={S.fieldLabel}>{label}</div>
      <div>{children}</div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  page: { maxWidth: 860, margin: "40px auto", padding: "0 24px", lineHeight: 1.55 },
  head: { display: "flex", justifyContent: "space-between", alignItems: "center",
          borderBottom: "1px solid #ddd", paddingBottom: 12, margin: "12px 0 20px" },
  badge: { background: "#eef2ff", color: "#2540b3", padding: "4px 12px",
           borderRadius: 999, fontSize: 13, fontWeight: 600 },
  warn: { background: "#fff5e6", border: "1px solid #ffd699", borderRadius: 8,
          padding: "10px 14px", fontSize: 14 },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))",
          gap: 16, margin: "20px 0" },
  fieldLabel: { fontSize: 11, textTransform: "uppercase", color: neutral[500], letterSpacing: 0.5 },
  h2: { fontSize: 15, textTransform: "uppercase", color: neutral[500], letterSpacing: 0.5,
        marginTop: 32, borderBottom: "1px solid #eee", paddingBottom: 6 },
  addr: { fontStyle: "normal", lineHeight: 1.7 },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 14 },
  td: { padding: "6px 8px", borderBottom: "1px solid #eee" },
  timeline: { listStyle: "none", padding: 0, margin: 0 },
  event: { padding: "10px 0 10px 16px", borderLeft: "2px solid #dde",
           marginLeft: 4, fontSize: 14 },
  when: { display: "block", fontSize: 12, color: neutral[400] },
  note: { fontSize: 13, color: neutral[700], marginTop: 4 },
  actionRow: { display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" },
  form: { display: "flex", gap: 6, alignItems: "center" },
  select: { padding: "5px 8px", border: "1px solid #ccc", borderRadius: 6, fontSize: 13 },
  button: { padding: "6px 14px", background: semantic.accent, color: "white", border: 0,
            borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: "pointer" },
  th: { textAlign: "left", padding: "6px 8px", borderBottom: "2px solid #ddd",
        fontSize: 11, textTransform: "uppercase", color: neutral[500], letterSpacing: 0.4 },
  pending: { color: semantic.attention, fontWeight: 600 },
  ok: { color: semantic.success, fontWeight: 600 },
  muted: { color: neutral[500], fontSize: 13 },
  link: { color: semantic.accent, textDecoration: "none", fontSize: 14 },
};
