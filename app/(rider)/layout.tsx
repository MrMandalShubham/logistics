import OfflineBar from "./OfflineBar";

/**
 * The rider shell.
 *
 * One client component sits above every rider page: it registers the
 * service worker, watches connectivity and drains the outbox. The
 * pages themselves stay server components, so the parts that read
 * customer data still go through the same claims-and-RLS path
 * everything else does.
 */
export default function RiderLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <OfflineBar />
      {children}
    </>
  );
}
