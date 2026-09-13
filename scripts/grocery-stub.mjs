import http from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * A stand-in for Grocery's POST /api/logistics/status.
 *
 * It implements the receiver exactly as the real route will: verify
 * the signature over `t.body`, reject a stale timestamp, reject an
 * event older than the one already applied, and be idempotent by
 * event_id. If logistics can satisfy this, it can satisfy Grocery.
 */
const SECRET = process.env.SECRET ?? "stub-secret";
const PORT = Number(process.env.PORT ?? 3399);

// Stands in for Grocery's orders table.
const orders = new Map();   // external_order_id -> { status, step, sequence }
const seen = new Set();     // event_id, for idempotency
const received = [];

function verify(body, header) {
  if (!header) return "signature header missing";
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  const t = Number(parts.t);
  if (!t || !parts.v1) return "signature header malformed";
  if (Math.abs(Date.now() / 1000 - t) > 300) return "timestamp outside tolerance";

  const want = createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex");
  const a = Buffer.from(want, "hex");
  const b = Buffer.from(parts.v1, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return "bad signature";
  return null;
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const send = (code, obj) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };

    if (req.url === "/__received") return send(200, { received, orders: [...orders] });
    if (req.url !== "/api/logistics/status") return send(404, { error: "not found" });

    const bad = verify(body, req.headers["x-logistics-signature"]);
    if (bad) return send(401, { error: bad });

    const e = JSON.parse(body);
    received.push({ event_id: e.event_id, status: e.customer_status,
                    step: e.pipeline_step, seq: e.sequence, message: e.message,
                    reason: e.reason_code });

    if (seen.has(e.event_id)) return send(200, { ok: true, duplicate: true });
    seen.add(e.event_id);

    const cur = orders.get(e.external_order_id);
    if (cur && Number(e.sequence) <= cur.sequence) {
      // P5-03: at-least-once says nothing about order.
      return send(200, { ok: true, ignored: "stale", held: cur.sequence });
    }

    orders.set(e.external_order_id, {
      status: e.customer_status, step: e.pipeline_step, sequence: Number(e.sequence) });
    send(200, { ok: true, applied: e.customer_status });
  });
});

server.listen(PORT, () => console.log(`grocery stub on :${PORT}`));
