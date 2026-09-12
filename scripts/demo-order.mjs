// Post a signed delivery-ready order, the way Grocery will.
//
//   npm run demo:order                       a complete, valid order
//   npm run demo:order -- --no-address       what a real Grocery order looks like today
//   npm run demo:order -- --order ORD-123    a specific order id
//   npm run demo:order -- --location SH2
//
// ── Why this exists instead of a Grocery poller ──
//
// The integration contract proposed polling Grocery's database as an
// interim scaffold. It was dropped: it needs Supabase credentials
// that do not exist, it tests nothing the real endpoint does not, and
// it was always meant to be deleted. This exercises the ACTUAL path a
// signed webhook takes, including the signature and the idempotency
// key, which a poller would have bypassed entirely.
//
// ── --no-address ──
//
// Reproduces the state of every real order in the estate today: no
// delivery address, because Grocery's checkout form discards its
// inputs and `orders` has no address_id (open question Q1). Use it to
// see the rejection and the replay path.

import { randomUUID, createHmac, createHash } from "node:crypto";
import { loadEnv } from "./db-config.mjs";

loadEnv();

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const BASE = process.env.LOGISTICS_BASE_URL ?? "http://127.0.0.1:3200";
const KEY = process.env.DEMO_API_KEY;
const SECRET = process.env.INBOUND_WEBHOOK_SECRET;

if (!KEY) {
  console.error(`
  DEMO_API_KEY is not set.

  Mint one with the orders:ingest scope, then put it in .env:

    npm run key:mint -- "Grocery storefront" orders:ingest,deliveries:read
`);
  process.exit(1);
}

if (!SECRET) {
  console.error("  INBOUND_WEBHOOK_SECRET is not set. It must match what the sender signs with.");
  process.exit(1);
}

const orderId = value("order", `ORD-DEMO-${randomUUID().slice(0, 8)}`);
const location = value("location", "SH1").toUpperCase();
const sku = value("sku", "PRD-2026-000001");

const address = {
  recipient_name: "A. Sharma",
  phone: "+919876543210",
  line1: "402, Sunview Apartments",
  line2: "Near Andheri Station",
  city: "Mumbai",
  state: "Maharashtra",
  pincode: "400058",
  lat: 19.1204,
  lng: 72.8501,
  instructions: "Call on arrival, the lift is out of service",
};

// Derived from the order id, not random, so re-running this command
// with the same --order sends a BYTE-IDENTICAL body. That is what a
// real sender's retry looks like, and it is the only way this script
// can demonstrate idempotent replay rather than tripping the
// same-key-different-body guard.
const stableId = createHash("sha256").update(orderId).digest("hex");
const stableEventId = [
  stableId.slice(0, 8), stableId.slice(8, 12), "4" + stableId.slice(13, 16),
  "8" + stableId.slice(17, 20), stableId.slice(20, 32),
].join("-");

const envelope = {
  event: "order.delivery_ready",
  event_id: stableEventId,
  occurred_at: new Date(0).toISOString(),
  version: "1.0",
  data: {
    external_order_id: orderId,
    external_customer_id: stableEventId,
    placed_at: new Date(0).toISOString(),
    pickup: { location_code: location },
    // Omitted entirely with --no-address, which is the shape every
    // real order in this estate currently has.
    ...(flag("no-address") ? {} : { delivery_address: address }),
    items: [
      { external_product_id: "prd_demo_1", sku, name: "Basmati Rice 5kg", quantity: 1 },
    ],
    payment: {
      method: "RAZORPAY",
      is_prepaid: true,
      amount_to_collect_paise: 0,
      order_total_paise: 74900,
    },
  },
};

const body = JSON.stringify(envelope);

// The same scheme Inventory uses: the timestamp is INSIDE the MAC, so
// a captured request cannot be replayed once it is older than the
// receiver's tolerance.
const t = Math.floor(Date.now() / 1000);
const mac = createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex");

const url = `${BASE}/api/v1/integration/orders.delivery-ready`;

console.log(`\n  POST ${url}`);
console.log(`  order    ${orderId}`);
console.log(`  pickup   ${location}`);
console.log(`  address  ${flag("no-address") ? "OMITTED (--no-address)" : "included"}\n`);

let res;
try {
  res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${KEY}`,
      "x-logistics-signature": `t=${t},v1=${mac}`,
      // The order id IS the idempotency key. Re-running this command
      // with --order <same id> should return the first answer, not
      // create a second delivery.
      "idempotency-key": orderId,
      "x-correlation-id": `demo-${randomUUID().slice(0, 8)}`,
    },
    body,
  });
} catch (e) {
  console.error(`  Could not reach ${BASE} - is the server running? (npm run dev)`);
  console.error(`  ${e.message}\n`);
  process.exit(1);
}

const out = await res.json().catch(() => null);
console.log(`  HTTP ${res.status}`);
console.log(`  ${JSON.stringify(out, null, 2).split("\n").join("\n  ")}\n`);

process.exit(res.ok ? 0 : 1);
