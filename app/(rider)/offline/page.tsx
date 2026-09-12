/**
 * What the service worker serves when a page is not cached and there
 * is no signal.
 *
 * It exists so a rider who taps something unreachable gets a sentence
 * that tells them what is true — their work is saved — rather than a
 * browser error page that implies it is not.
 */
export default function OfflinePage() {
  return (
    <main style={S.page}>
      <h1 style={S.h1}>No signal</h1>
      <p style={S.p}>
        This page needs a connection. Your jobs and anything you have already
        done are saved on this phone and will send themselves when you are back.
      </p>
      <a href="/me" style={S.button}>My jobs</a>
    </main>
  );
}

const S: Record<string, React.CSSProperties> = {
  page: { maxWidth: 480, margin: "60px auto", padding: "0 24px",
          textAlign: "center", lineHeight: 1.6 },
  h1: { fontSize: 26 },
  p: { color: "#555" },
  button: { display: "inline-block", marginTop: 20, padding: "14px 28px",
            background: "#0b5fff", color: "white", borderRadius: 12,
            textDecoration: "none", fontWeight: 700 },
};
