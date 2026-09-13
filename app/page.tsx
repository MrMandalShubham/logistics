import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { pool } from "@/lib/db";
import { COOKIE_NAME, hashToken } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/**
 * The front door.
 *
 * ── What was here before ──
 *
 * A Phase 1 stub listing six API endpoints and saying "delivery
 * intake arrives in Phase 2". It said that through Phases 2 to 8,
 * while eleven working screens sat at URLs it never mentioned and
 * nothing linked to. A landing page that describes a system two
 * releases old is worse than no landing page: it is read and
 * believed.
 *
 * ── What it does now ──
 *
 * Signed out, it sends you to sign in. Signed in, it shows what your
 * role can actually reach — a dispatcher is not offered the admin
 * screens they would be refused, and a rider is sent straight to
 * their jobs, because a rider on a doorstep opening a menu is a rider
 * not delivering anything.
 */
type Tile = { href: string; title: string; blurb: string; perm?: string };

const ADMIN_TILES: Tile[] = [
  { href: "/dispatch", title: "Dispatch",
    blurb: "What is waiting, who is free, and who to give it to.",
    perm: "deliveries:read" },
  { href: "/deliveries", title: "Deliveries",
    blurb: "Everything in flight, and the timeline behind each one.",
    perm: "deliveries:read" },
  { href: "/exceptions", title: "Exceptions",
    blurb: "What the system could not decide on its own.",
    perm: "deliveries:read" },
  { href: "/riders", title: "Riders",
    blurb: "Who is on shift, who is carrying what.",
    perm: "riders:read" },
  { href: "/reports", title: "Reports",
    blurb: "Stuck deliveries, latencies, commit health.",
    perm: "reports:read" },
  { href: "/integration", title: "Integration",
    blurb: "The outbound queue: waiting, retrying, dead.",
    perm: "integration:read" },
  { href: "/locations", title: "Locations",
    blurb: "Where each shop is, and how far it delivers.",
    perm: "locations:read" },
];

export default async function Home() {
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  if (!token) redirect("/sign-in");

  const db = await pool.connect();
  let claims: Record<string, unknown> | null = null;
  try {
    const { rows: [c] } = await db.query(
      "select identity.resolve_session($1) as claims", [hashToken(token)]);
    claims = c?.claims ?? null;
  } catch {
    claims = null;
  } finally {
    db.release();
  }

  if (!claims) redirect("/sign-in");
  if (claims.must_change_password) redirect("/change-password");

  // A rider has one job and it is not choosing from a menu.
  if (claims.role === "rider") redirect("/me");

  const perms = (claims.permissions as string[]) ?? [];
  const tiles = ADMIN_TILES.filter((t) => !t.perm || perms.includes(t.perm));

  return (
    <main style={S.page}>
      <div style={S.head}>
        <div>
          <h1 style={S.h1}>Logistics Core</h1>
          <p style={S.sub}>
            Signed in as <strong>{String(claims.full_name ?? claims.email)}</strong>
            {" · "}{String(claims.role)}
            {Array.isArray(claims.location_codes) && claims.location_codes.length > 0
              ? ` · ${(claims.location_codes as string[]).join(", ")}`
              : " · all locations"}
          </p>
        </div>
      </div>

      <div style={S.grid}>
        {tiles.map((t) => (
          <Link key={t.href} href={t.href} style={S.tile}>
            <strong style={S.tileTitle}>{t.title}</strong>
            <span style={S.tileBlurb}>{t.blurb}</span>
          </Link>
        ))}
      </div>

      {tiles.length === 0 && (
        <p style={S.empty}>
          Your role has no screens. That is a permissions problem, not an empty system.
        </p>
      )}

      <p style={S.foot}>
        <Link href="/change-password" style={S.link}>Change password</Link>
        {" · "}
        <a href="/api/health?deep=1" style={S.link}>Health</a>
        {" · "}
        <span style={S.quiet}>
          The worker is a separate process — <code style={S.code}>npm run worker</code>.
          Nothing is sent to Grocery or Inventory without it.
        </span>
      </p>
    </main>
  );
}

const S: Record<string, React.CSSProperties> = {
  page: { maxWidth: 820, margin: "56px auto", padding: "0 24px",
          fontSize: 14, lineHeight: 1.6 },
  head: { display: "flex", justifyContent: "space-between", alignItems: "flex-start",
          marginBottom: 28 },
  h1: { fontSize: 27, margin: "0 0 2px" },
  sub: { color: "#666", margin: 0 },
  grid: { display: "grid", gap: 12,
          gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))" },
  tile: { display: "flex", flexDirection: "column", gap: 4, padding: 16,
          border: "1px solid #e5e5e5", borderRadius: 14, background: "#fff",
          textDecoration: "none", color: "inherit" },
  tileTitle: { fontSize: 16, color: "#0b5fff" },
  tileBlurb: { color: "#666", fontSize: 13 },
  empty: { color: "#8a1c10" },
  foot: { marginTop: 32, color: "#888", fontSize: 12 },
  link: { color: "#0b5fff", textDecoration: "none" },
  quiet: { color: "#999" },
  code: { background: "#f2f2f2", padding: "1px 5px", borderRadius: 4 },
};
