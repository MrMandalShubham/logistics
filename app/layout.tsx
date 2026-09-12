export const metadata = {
  title: "Logistics Core",
  description: "Delivery operations for the Grocery + Inventory estate.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", background: "#fafaf8" }}>
        {children}
      </body>
    </html>
  );
}
