import Link from "next/link";
import { cookies } from "next/headers";
import { pool } from "@/lib/db";
import { COOKIE_NAME, hashToken } from "@/lib/auth/session";
import ExceptionActions from "./ExceptionActions";

export const dynamic = "force-dynamic";

/**
 * The work queue for when things go wrong.
 *
 * Phases 4a, 4b and 5 all raise exceptions. Until now nothing closed
 * them, and `open_conflicts()` listed disagreements that nobody could
 * decide. This is where a person does both.
 *
 * ── Ordering ──
 *
 * CRITICAL first, then oldest. A conflict between two riders about
 * one doorstep is worth more of somebody's attention than a delivery
 * that failed because nobody was home, and the age column is there
 * because the second one still matters after four hours.
 *
 * ── Why the counts come from a definer function ──
 *
 * The fifth time this codebase has met the same trap: under RLS, a
 * plain SELECT as a role with no matching policy returns zero rows
 * and reports success. On a queue of things needing attention,
 * "nothing to do" and "you cannot see anything" would look identical.
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

    const [open, conflicts] = await Promise.all([
      db.query("select * from delivery.open_exceptions(200)"),
      db.query("select * from integration.open_conflicts()"),
    ]);

    await db.query("commit");
    return {
      claims: c.claims,
      open: open.rows,
      conflicts: conflicts.rows.filter((r) => !r.resolved),
    };
  } catch (e) {
    await db.query("rollback").catch(() => {});
    return { error: (e as Error).message };
  } finally {
    db.release();
  }
}

export default async function ExceptionsPage() {
  const data = await load();

  if (!data) {
    return <main style={S.page}><h1 style={S.h1}>Exceptions</h1>
      <p>You are not signed in, or your session has expired.</p></main>;
  }
  if ("error" in data) {
    return <main style={S.page}><h1 style={S.h1}>Exceptions</h1>
      <p style={S.err}>Could not read the queue: {data.error}</p></main>;
  }

  const { claims, open, conflicts } = data;
  const perms = (claims.permissions as string[]) ?? [];
  const mayResolve = perms.includes("exceptions:resolve");
  const critical = open.filter((x) => x.severity === "CRITICAL").length;

  return (
    <main style={S.page}>
      <h1 style={S.h1}>Exceptions</h1>
      <p style={S.sub}>
        Things the system could not decide on its own. Each one closes with a name and a
        reason against it — nothing here is resolved by a timer.
      </p>

      {!mayResolve && (
        <p style={S.notice}>
          You can see these but not resolve them. That needs <code>exceptions:resolve</code>.
        </p>
      )}

      <div style={S.cards}>
        <div style={{ ...S.card, ...(critical > 0 ? S.cardBad : {}) }}>
          <div style={S.n}>{critical}</div><div style={S.cap}>critical</div>
        </div>
        <div style={S.card}>
          <div style={S.n}>{open.length}</div><div style={S.cap}>open</div>
        </div>
        <div style={{ ...S.card, ...(conflicts.length > 0 ? S.cardBad : {}) }}>
          <div style={S.n}>{conflicts.length}</div><div style={S.cap}>conflicts to decide</div>
        </div>
      </div>

      {/* ── Conflicts first: two people disagree and both are waiting ── */}
      <h2 style={S.h2}>Conflicts</h2>
      {conflicts.length === 0 ? (
        <p style={S.empty}>Nobody is disagreeing about a doorstep.</p>
      ) : (
        <div style={S.list}>
          {conflicts.map((c) => (
            <div key={String(c.event_id)} style={S.item}>
              <div style={S.itemHead}>
                <Link href={`/deliveries/${c.delivery_id}`} style={S.link}>
                  {c.tracking_id}
                </Link>
                <span style={S.code}>{c.conflict_code}</span>
              </div>
              <p style={S.what}>
                <strong>{c.rider_code}</strong> reported <strong>{c.action}</strong> at{" "}
                {when(c.captured_at)}, and we heard at {when(c.received_at)}.
              </p>
              {mayResolve && (
                <ExceptionActions kind="conflict" eventId={String(c.event_id)} />
              )}
            </div>
          ))}
        </div>
      )}

      <h2 style={S.h2}>Open exceptions</h2>
      {open.length === 0 ? (
        <p style={S.empty}>Nothing is waiting.</p>
      ) : (
        <div style={S.list}>
          {open.map((x) => (
            <div key={String(x.id)}
                 style={{ ...S.item, ...(x.severity === "CRITICAL" ? S.itemBad : {}) }}>
              <div style={S.itemHead}>
                <Link href={`/deliveries/${x.delivery_id}`} style={S.link}>
                  {x.tracking_id}
                </Link>
                <span style={S.code}>{x.code}</span>
                <span style={x.severity === "CRITICAL" ? S.sevBad : S.sev}>{x.severity}</span>
                <span style={S.age}>{age(x.age_minutes)}</span>
              </div>

              <p style={S.what}>
                Delivery is <strong>{x.status}</strong> at {x.location_code}.
                {x.parcel_with_rider
                  ? <> The parcel is with <strong>{x.parcel_with_rider}</strong>.</>
                  : <> The parcel is at the shop.</>}
              </p>
              {x.note && <p style={S.note}>{x.note}</p>}

              {mayResolve && (
                <ExceptionActions
                  kind={x.code === "PROOF_DISPUTED" ? "dispute" : "exception"}
                  exceptionId={String(x.id)}
                  deliveryId={String(x.delivery_id)}
                  status={String(x.status)}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </main>
  );
}

function when(v: unknown): string {
  if (!v) return "—";
  return new Date(String(v)).toISOString().replace("T", " ").slice(11, 16);
}

function age(minutes: number): string {
  const m = Number(minutes);
  if (m < 60) return `${m}m`;
  if (m < 60 * 24) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / (60 * 24))}d`;
}

const S: Record<string, React.CSSProperties> = {
  page: { maxWidth: 900, margin: "0 auto", padding: 24, fontSize: 14 },
  h1: { fontSize: 26, margin: "0 0 4px" },
  h2: { fontSize: 16, margin: "30px 0 10px" },
  sub: { color: "#666", margin: "0 0 18px" },
  notice: { background: "#f5f5f5", border: "1px solid #e5e5e5", borderRadius: 10,
            padding: "10px 14px", color: "#555" },
  cards: { display: "flex", gap: 12, flexWrap: "wrap" },
  card: { flex: "1 1 150px", padding: 16, border: "1px solid #e5e5e5",
          borderRadius: 12, background: "#fff" },
  cardBad: { borderColor: "#f5b5ad", background: "#fff6f4" },
  n: { fontSize: 30, fontWeight: 700 },
  cap: { color: "#777", fontSize: 12, marginTop: 2 },
  list: { display: "flex", flexDirection: "column", gap: 10 },
  item: { padding: 16, border: "1px solid #e5e5e5", borderRadius: 12, background: "#fff" },
  itemBad: { borderColor: "#f5b5ad" },
  itemHead: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" },
  link: { color: "#0b5fff", textDecoration: "none", fontWeight: 700 },
  code: { fontFamily: "ui-monospace, monospace", fontSize: 12, background: "#f2f2f2",
          padding: "2px 8px", borderRadius: 6 },
  sev: { fontSize: 11, color: "#888", letterSpacing: 0.5 },
  sevBad: { fontSize: 11, color: "#8a1c10", fontWeight: 700, letterSpacing: 0.5 },
  age: { marginLeft: "auto", color: "#999", fontSize: 12 },
  what: { margin: "10px 0 0", color: "#444" },
  note: { margin: "6px 0 0", color: "#777", fontStyle: "italic" },
  empty: { color: "#888" },
  err: { color: "#8a1c10" },
};
