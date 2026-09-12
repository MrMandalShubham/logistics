/**
 * Phase 1 ships a shell, deliberately.
 *
 * The dispatch board, delivery queue and rider app arrive in Phases
 * 3 and 4. Putting placeholder screens here now would mean building
 * them twice, and would make the system look further along than it is.
 */
export default function Home() {
  return (
    <main style={{ maxWidth: 640, margin: "80px auto", padding: "0 24px", lineHeight: 1.6 }}>
      <h1 style={{ marginBottom: 4 }}>Logistics Core</h1>
      <p style={{ color: "#666", marginTop: 0 }}>Phase 1 — foundation</p>

      <p>
        Authentication, roles, audit, idempotency and health are in place.
        Delivery intake arrives in Phase 2.
      </p>

      <ul>
        <li><code>GET /api/health</code> — liveness</li>
        <li><code>GET /api/health?deep=1</code> — readiness, incl. Grocery and Inventory</li>
        <li><code>POST /api/v1/auth/sign-in</code></li>
        <li><code>GET /api/v1/auth/me</code></li>
        <li><code>GET /api/v1/whoami</code> — API key check</li>
        <li><code>GET /api/v1/locations</code> — cached pickup points</li>
      </ul>
    </main>
  );
}
