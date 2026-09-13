import SignInForm from "./SignInForm";
import { neutral } from "@/lib/ui/theme";

export const dynamic = "force-dynamic";

/**
 * The way in.
 *
 * ── Why this did not exist until now ──
 *
 * `POST /api/v1/auth/sign-in` has worked since Phase 1 and every
 * screen since Phase 3 has been behind it, but nothing in a browser
 * could reach it — so eleven working screens were usable only with
 * curl and a hand-pasted cookie. An API without a door is not a
 * feature anybody has.
 *
 * The form is deliberately thin: it posts to the same endpoint an
 * integrator would, gets the same httpOnly cookie, and the server
 * decides everything. No token in localStorage, no client-side
 * session state to drift out of step with the database.
 */
export default function SignInPage() {
  return (
    <main style={S.page}>
      <h1 style={S.h1}>Logistics Core</h1>
      <p style={S.sub}>Sign in to continue.</p>
      <SignInForm />
      <p style={S.foot}>
        No account? An admin creates one — or run{" "}
        <code style={S.code}>npm run admin:create</code> for the first.
      </p>
    </main>
  );
}

const S: Record<string, React.CSSProperties> = {
  page: { maxWidth: 380, margin: "72px auto", padding: "0 24px",
          fontSize: 14, lineHeight: 1.6 },
  h1: { fontSize: 26, margin: "0 0 2px" },
  sub: { color: neutral[500], margin: "0 0 24px" },
  foot: { marginTop: 28, color: neutral[500], fontSize: 12 },
  code: { background: neutral[100], padding: "1px 5px", borderRadius: 4 },
};
