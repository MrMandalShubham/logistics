import Link from "next/link";
import { redirect } from "next/navigation";
import { currentClaims } from "@/lib/auth/current";
import { neutral, semantic, font } from "@/lib/ui/theme";
import SignOut from "./SignOut";

export const dynamic = "force-dynamic";

/**
 * The shell every staff screen sits inside.
 *
 * ── Why this had to exist ──
 *
 * Five screens — reports, exceptions, integration, locations and the
 * delivery list — had no outbound links at all. Once you were on one,
 * the only ways out were the browser's back button and typing a URL.
 * Dispatch linked to two of its neighbours and the others linked
 * nowhere. There was no sign-out anywhere in the staff app.
 *
 * A persistent bar fixes all of it in one place, and means a screen
 * added later is one array entry away from being reachable.
 *
 * ── Why the session is resolved here ──
 *
 * Every page did its own cookie lookup and its own "you are not
 * signed in" branch. Doing it once means an expired session sends you
 * to sign in rather than rendering a shell around an error, and the
 * pages below can assume they have a reader.
 */
const NAV = [
  { href: "/dispatch",    label: "Dispatch",    perm: "deliveries:read" },
  { href: "/deliveries",  label: "Deliveries",  perm: "deliveries:read" },
  { href: "/exceptions",  label: "Exceptions",  perm: "deliveries:read" },
  { href: "/riders",      label: "Riders",      perm: "riders:read" },
  { href: "/reports",     label: "Reports",     perm: "reports:read" },
  { href: "/integration", label: "Integration", perm: "integration:read" },
  { href: "/locations",   label: "Locations",   perm: "locations:read" },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // Through currentClaims() so the page inside this layout shares the
  // lookup rather than repeating it — one session query per request,
  // not two.
  const claims = await currentClaims();

  if (!claims) redirect("/sign-in");
  if (claims.must_change_password) redirect("/change-password");
  if (claims.role === "rider") redirect("/me");

  const perms = (claims.permissions as string[]) ?? [];
  const items = NAV.filter((n) => perms.includes(n.perm));
  const where = Array.isArray(claims.location_codes) && claims.location_codes.length
    ? (claims.location_codes as string[]).join(", ")
    : "all locations";

  return (
    <div style={{ minHeight: "100vh", background: neutral[25], fontFamily: font }}>
      <header style={{
        background: neutral[900], position: "sticky", top: 0, zIndex: 20,
      }}>
        <div style={{
          maxWidth: 1240, margin: "0 auto", padding: "0 20px",
          display: "flex", alignItems: "center", gap: 20, minHeight: 54,
          flexWrap: "wrap",
        }}>
          <Link href="/" style={{
            color: neutral[0], textDecoration: "none", fontWeight: 700,
            fontSize: 15, whiteSpace: "nowrap", letterSpacing: -0.2,
          }}>
            Logistics<span style={{ color: semantic.accent }}>.</span>
          </Link>

          {/* Wraps rather than scrolls: on a narrow window a second row
              of links is readable, a horizontal scrollbar is not. */}
          <nav style={{ display: "flex", gap: 2, flexWrap: "wrap", flex: 1 }}>
            {items.map((n) => (
              <Link key={n.href} href={n.href} style={{
                color: neutral[300], textDecoration: "none", fontSize: 13.5,
                padding: "7px 11px", borderRadius: 7, whiteSpace: "nowrap",
              }}>
                {n.label}
              </Link>
            ))}
          </nav>

          <div style={{ display: "flex", alignItems: "center", gap: 12, marginLeft: "auto" }}>
            <div style={{ textAlign: "right", lineHeight: 1.25 }}>
              <div style={{ color: neutral[0], fontSize: 13, fontWeight: 600 }}>
                {String(claims.full_name ?? claims.email)}
              </div>
              <div style={{ color: neutral[500], fontSize: 11 }}>
                {String(claims.role)} · {where}
              </div>
            </div>
            <SignOut />
          </div>
        </div>
      </header>

      {children}
    </div>
  );
}

