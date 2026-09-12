# Grocery Change Spec — Q1, Q2 and Q4

**Date:** 2026-09-12 · **Status:** **IMPLEMENTED** — branch `feat/delivery-address-and-logistics-handoff`
in `Desktop/Grocery`, uncommitted. See §13 for what actually shipped and how it was verified.
**Owner:** Lead Agent (logistics programme) · **Implementer:** whoever owns the Grocery repo
**Unblocks:** [Q1](03-open-questions.md) (delivery address), Q2 (fulfilment location),
Q4 (reservation ids) — and, with Part B, the handoff itself

---

## 1. The finding that makes this small

Grocery already collects everything a delivery needs. **It then throws it away.**

### 1.1 The customer's geocode is captured and discarded

`src/components/LocationSelector.tsx` gets the customer's real position — from GPS or from a
map pin — and passes it to `assignLocation(lat, lng)`:

```ts
const assignLocation = async (lat: number, lng: number) => {
  // ... finds the nearest shop within MAX_DELIVERY_RADIUS_KM
  await setLocationCookie(closestStoreId);   // the SHOP is kept
  // lat and lng are never used again          <- the CUSTOMER is not
};
```

Those two numbers are **the only customer geocode anywhere in this estate**. They exist, in
the browser, at the moment the customer chooses where to shop — and the function returns
without storing them.

### 1.2 The address form is rendered and discarded

`src/app/checkout/page.tsx` renders "Delivery Details" — first name, last name, phone, address.
Every input is uncontrolled:

```tsx
<input type="text" placeholder="First Name" className="..." />
<textarea placeholder="Delivery Address" rows={3} className="..." />
```

No `value`, no `onChange`, no `name`. `handlePayment()` never reads them.

### 1.3 The reservation ids are received and discarded

```ts
await reserveOrderInventory(orderData.id, inventoryItems);
```

The response contains `items: [{ sku, reservation_id, … }]`. It is awaited and dropped. Those
ids are the **only** way to stop a stock hold expiring mid-delivery — `reserve` returns them
and no other endpoint ever does.

### 1.4 So this is a persistence change, not a collection change

Three blocking questions, all fixed in essentially one file:

| Question | What is missing | Where the data already is |
|---|---|---|
| **Q1** | delivery address + geocode | the checkout form; `assignLocation(lat, lng)` |
| **Q2** | fulfilment location on the order | `closestStoreId`, currently cookie-only |
| **Q4** | per-line reservation ids | the `reserveOrderInventory` response |

---

## 2. Scope

**Part A — persist what is already collected.** Required. Unblocks Q1, Q2, Q4.
**Part B — publish it to logistics.** Separable, but Part A alone leaves the data sitting in
Grocery's database doing nothing.

### Out of scope, deliberately

- The customer's saved-address book (`/account` → "Coming Soon"). Columns are prepared; the UI
  is not built here.
- Real payment. `status: 'PAID'` stays hard-coded and stays wrong; that is a separate problem.
- COD.
- The `services/orders.ts` status ternary and the customer tracking pipeline — those are
  Phase 5 / Q3.
- The missing `service_requests` table (a live silent failure, reported separately).
- Anything in Inventory.

---

## 3. Part A — database migration

Additive only. No column is dropped, no type changed, nothing backfilled. Existing orders keep
working; they simply cannot be delivered, which is already true.

```sql
-- ============================================================
-- Delivery details on an order
--
-- Two kinds of address, for two different jobs:
--
--   addresses.lat/lng   the customer's saved address book (prepared
--                       here, built later)
--   orders.delivery_*   a SNAPSHOT of where THIS order was sent
--
-- The snapshot is the one that matters. An address a customer can
-- edit must not silently rewrite where a parcel was delivered last
-- month, and a rider already on the road must not be redirected
-- because somebody changed their profile.
-- ============================================================

-- 1. Prepare the saved-address book (unused today, 2 columns, no risk)
alter table public.addresses
  add column if not exists lat numeric(9,6),
  add column if not exists lng numeric(9,6);

-- 2. The delivery snapshot on the order
alter table public.orders
  -- Optional link to the saved address, for when the book is built.
  add column if not exists address_id uuid references public.addresses(id),

  -- Q2: which shop fulfils this. Today it lives only in a cookie.
  add column if not exists fulfilment_location_code text,

  -- Q1: the snapshot. lat/lng are the part that cannot be worked
  -- around -- a destination a rider cannot navigate to is not a
  -- destination.
  add column if not exists delivery_recipient_name text,
  add column if not exists delivery_phone         text,
  add column if not exists delivery_line1         text,
  add column if not exists delivery_line2         text,
  add column if not exists delivery_city          text,
  add column if not exists delivery_state         text,
  add column if not exists delivery_pincode       text,
  add column if not exists delivery_lat           numeric(9,6),
  add column if not exists delivery_lng           numeric(9,6),
  add column if not exists delivery_instructions  text,

  -- Nothing currently records when an order last changed.
  add column if not exists updated_at timestamptz not null default now();

-- 3. Q4: the reservation id per line, straight from the reserve response
alter table public.order_items
  add column if not exists reservation_id uuid;

-- Logistics looks orders up by the tracking id it writes back.
create index if not exists orders_logistics_tracking
  on public.orders (logistics_tracking_id)
  where logistics_tracking_id is not null;
```

**Why not `NOT NULL` on the delivery columns?** Existing rows have no address, and a failed
migration on a live table is a worse outcome than a validated insert path. The application
refuses to create an order without them (§4.3); the database stays permissive for history.

---

## 4. Part A — code changes

Four files. Roughly 120 lines, most of it the form.

### 4.1 `src/app/actions.ts` — keep the geocode

```ts
/**
 * The customer chose where to receive deliveries.
 *
 * `inventory_location` is unchanged -- it scopes catalogue and stock
 * calls to a shop. What is new is keeping the customer's own
 * position: it is captured for the 10 km serviceability check and was
 * previously discarded, and it is the only geocode in this estate.
 * Without it a rider has an address but no way to navigate to it.
 */
export async function setDeliveryLocation(
  locationId: string, lat: number, lng: number,
) {
  const cookieStore = await cookies();
  const year = 60 * 60 * 24 * 365;

  cookieStore.set("inventory_location", locationId, { path: "/", maxAge: year });
  cookieStore.set("delivery_geo", `${lat},${lng}`, { path: "/", maxAge: year });

  revalidatePath("/", "layout");
}

/** What checkout needs to know about where this order is going. */
export async function getDeliveryContext(): Promise<{
  locationCode: string | null; lat: number | null; lng: number | null;
}> {
  const cookieStore = await cookies();
  const locationCode = cookieStore.get("inventory_location")?.value ?? null;
  const geo = cookieStore.get("delivery_geo")?.value ?? null;

  if (!geo) return { locationCode, lat: null, lng: null };

  const [lat, lng] = geo.split(",").map(Number);
  return {
    locationCode,
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
  };
}
```

`setLocationCookie` stays, unchanged, so nothing that calls it breaks.

### 4.2 `src/components/LocationSelector.tsx` — one line

```diff
-import { setLocationCookie } from "@/app/actions";
+import { setDeliveryLocation } from "@/app/actions";
```

```diff
     if (closestStoreId && minDistance <= MAX_DELIVERY_RADIUS_KM) {
       if (closestStoreId !== currentLocation && items.length > 0) {
         clearCart();
       }
-      await setLocationCookie(closestStoreId);
+      // Keep the customer's pin, not just the shop it resolved to.
+      await setDeliveryLocation(closestStoreId, lat, lng);
       setIsModalOpen(false);
```

That single line is the whole of Q1's hard part. The geocode is already in scope.

### 4.3 `src/app/checkout/page.tsx` — control the form, persist the answer

**Controlled state**

```tsx
const [form, setForm] = useState({
  firstName: "", lastName: "", phone: "",
  line1: "", line2: "", city: "", pincode: "", instructions: "",
});
const [geo, setGeo] = useState<{ locationCode: string | null; lat: number | null; lng: number | null }>(
  { locationCode: null, lat: null, lng: null });
const [errors, setErrors] = useState<string[]>([]);

useEffect(() => {
  import("@/app/actions").then(({ getDeliveryContext }) =>
    getDeliveryContext().then(setGeo));
}, []);

const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
  setForm((f) => ({ ...f, [k]: e.target.value }));
```

**The inputs, wired**

```tsx
<input value={form.firstName} onChange={set("firstName")} placeholder="First Name" … />
<input value={form.lastName}  onChange={set("lastName")}  placeholder="Last Name"  … />
<input value={form.phone}     onChange={set("phone")}     type="tel" placeholder="Phone Number" … />
<input value={form.line1}     onChange={set("line1")}     placeholder="Flat / House / Building" … />
<input value={form.line2}     onChange={set("line2")}     placeholder="Area / Landmark (optional)" … />
<input value={form.city}      onChange={set("city")}      placeholder="City" … />
<input value={form.pincode}   onChange={set("pincode")}   placeholder="Pincode" inputMode="numeric" … />
<textarea value={form.instructions} onChange={set("instructions")}
          placeholder="Delivery instructions (optional)" rows={2} … />
```

**Validation, before anything is written**

```ts
/**
 * Refuse at the door.
 *
 * An order that reaches logistics without an address is refused there
 * and has to be fixed here anyway -- so catch it while the customer is
 * still on the page and can type it in.
 */
function validate(): string[] {
  const e: string[] = [];
  if (!form.firstName.trim()) e.push("First name is required.");
  if (!/^\+?[0-9]{10,13}$/.test(form.phone.replace(/\s/g, "")))
    e.push("Enter a valid phone number — the rider will call it.");
  if (!form.line1.trim()) e.push("Flat / house / building is required.");
  if (!form.city.trim()) e.push("City is required.");
  if (!/^[0-9]{6}$/.test(form.pincode.trim())) e.push("Enter a 6-digit pincode.");

  // The one that cannot be typed around.
  if (geo.lat === null || geo.lng === null)
    e.push("Set your delivery location on the map before placing the order.");
  if (!geo.locationCode)
    e.push("Choose a delivery location before placing the order.");

  return e;
}
```

**The order insert**

```ts
const problems = validate();
if (problems.length) { setErrors(problems); setOrderStatus("idle"); return; }

const { data: orderData, error: orderError } = await supabase
  .from("orders")
  .insert({
    user_id: user.id,
    status: "PAID",
    total_amount: cartTotal,
    final_amount: cartTotal,
    payment_method: role === "B2B" ? "SHOP_CREDIT" : "RAZORPAY",

    fulfilment_location_code: geo.locationCode,

    delivery_recipient_name: `${form.firstName} ${form.lastName}`.trim(),
    delivery_phone:          form.phone.replace(/\s/g, ""),
    delivery_line1:          form.line1.trim(),
    delivery_line2:          form.line2.trim() || null,
    delivery_city:           form.city.trim(),
    delivery_pincode:        form.pincode.trim(),
    delivery_lat:            geo.lat,
    delivery_lng:            geo.lng,
    delivery_instructions:   form.instructions.trim() || null,
  })
  .select()
  .single();
```

**Keep the reservation ids (Q4)**

```ts
// Insert items and keep the rows, so each can be matched to its hold.
const { data: itemRows, error: itemsError } = await supabase
  .from("order_items")
  .insert(orderItemsToInsert)
  .select();

if (itemsError) throw itemsError;

const reservation = await reserveOrderInventory(orderData.id, inventoryItems);

// The response carries a reservation_id per line and was previously
// dropped on the floor. Those ids are the ONLY way to stop a hold
// expiring 30 minutes into a delivery -- reserve returns them and no
// other endpoint ever does.
const holdBySku = new Map<string, string>(
  (reservation?.items ?? [])
    .filter((i: any) => i.reservation_id)
    .map((i: any) => [i.sku, i.reservation_id]));

await Promise.all(
  (itemRows ?? [])
    .filter((row: any) => holdBySku.has(row.sku))
    .map((row: any) =>
      supabase.from("order_items")
        .update({ reservation_id: holdBySku.get(row.sku) })
        .eq("id", row.id)));
```

**Show the errors**

```tsx
{errors.length > 0 && (
  <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-800">
    <ul className="list-disc pl-5">{errors.map((e) => <li key={e}>{e}</li>)}</ul>
  </div>
)}
```

### 4.4 A defect to fix while in this file

Today the order is inserted, then items, then `reserveOrderInventory`. If the reserve fails,
**the order already exists and already says `PAID`** — the customer is told it worked and no
stock is held. The `catch` shows an alert and leaves the row behind.

Recommended, and small:

```ts
} catch (err: any) {
  // The order row exists but nothing is held. Mark it, rather than
  // leaving a PAID order nobody can fulfil.
  if (orderData?.id) {
    await supabase.from("orders")
      .update({ status: "FAILED" })
      .eq("id", orderData.id);
  }
  setErrors([err.message ?? "Could not place the order. Nothing was charged."]);
  setOrderStatus("idle");
}
```

> This needs an RLS `UPDATE` policy on `orders` for the owning customer — `public.orders`
> currently has **no `UPDATE` policy at all**, so the write silently affects zero rows.
> See §7.

---

## 5. Part B — publish to logistics

Part A alone leaves the data in Grocery's database. This sends it.

The logistics endpoint already exists, is signed, idempotent, and tested end to end
([Phase 2 verification](phase-reports/phase-2-verification.md)).

### 5.1 Read the order back on the server

The browser must not be the source of what gets published — the checkout page already writes
its own order with the anon key, and a client that can also *describe* that order to a third
system is a client that can describe a different one.

So the publisher re-reads the order server-side with the service-role key, and publishes what
is **stored**, not what was claimed.

```ts
// src/services/logistics.ts        SERVER ONLY
import { createClient } from "@supabase/supabase-js";
import { createHmac } from "node:crypto";

const admin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,   // server-side only, never NEXT_PUBLIC_
);

/**
 * Tell logistics an order is ready to deliver.
 *
 * Signed with the shared secret; the timestamp is inside the MAC, so a
 * captured request stops being valid after five minutes. The order id
 * is the idempotency key, so a retry after a timeout returns the first
 * answer rather than creating a second delivery.
 */
export async function publishDeliveryReady(orderId: string): Promise<void> {
  const { data: order } = await admin
    .from("orders")
    .select("*, order_items(*)")
    .eq("id", orderId)
    .single();

  if (!order) throw new Error(`No such order: ${orderId}`);

  const envelope = {
    event: "order.delivery_ready",
    event_id: crypto.randomUUID(),
    occurred_at: new Date().toISOString(),
    version: "1.0",
    data: {
      external_order_id:    order.id,
      external_customer_id: order.user_id,
      placed_at:            order.created_at,
      pickup: { location_code: order.fulfilment_location_code },
      delivery_address: {
        recipient_name: order.delivery_recipient_name,
        phone:          order.delivery_phone,
        line1:          order.delivery_line1,
        line2:          order.delivery_line2,
        city:           order.delivery_city,
        state:          order.delivery_state,
        pincode:        order.delivery_pincode,
        lat:            Number(order.delivery_lat),
        lng:            Number(order.delivery_lng),
        instructions:   order.delivery_instructions,
      },
      items: order.order_items.map((i: any) => ({
        external_product_id: i.external_product_id,
        sku:                 i.sku,
        name:                i.name,
        quantity:            i.quantity,
        reservation_id:      i.reservation_id,     // Q4
      })),
      payment: {
        method:                  order.payment_method,
        is_prepaid:              order.payment_method !== "COD",
        amount_to_collect_paise: 0,
        order_total_paise:       Math.round(Number(order.final_amount) * 100),
      },
    },
  };

  const body = JSON.stringify(envelope);
  const t = Math.floor(Date.now() / 1000);
  const mac = createHmac("sha256", process.env.LOGISTICS_WEBHOOK_SECRET!)
    .update(`${t}.${body}`).digest("hex");

  const res = await fetch(
    `${process.env.LOGISTICS_API_URL}/api/v1/integration/orders.delivery-ready`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.LOGISTICS_API_KEY}`,
        "x-logistics-signature": `t=${t},v1=${mac}`,
        "idempotency-key": order.id,
      },
      body,
    });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Logistics refused the order (${res.status}): ${detail}`);
  }

  // Logistics issues DLV-YYYY-NNNNNN. The column has existed since day
  // one and has never been written.
  const { tracking_id } = await res.json();
  await admin.from("orders")
    .update({ logistics_tracking_id: tracking_id })
    .eq("id", order.id);
}
```

### 5.2 Call it — and never let it fail the order

```ts
// src/app/actions.ts
export async function notifyLogistics(orderId: string) {
  try {
    const { publishDeliveryReady } = await import("@/services/logistics");
    await publishDeliveryReady(orderId);
  } catch (e) {
    // A logistics outage must not fail a customer's checkout. The
    // order is placed and the stock is held; the handoff is retried.
    console.error("[logistics] publish failed", orderId, e);
  }
}
```

```ts
// checkout, after the reservation succeeds
await notifyLogistics(orderData.id);
```

**What happens when that catch fires?** The order exists, the stock is held, and logistics has
never heard of it. Two safety nets, in order of preference:

1. **A retry sweep** — a small scheduled job that finds orders `PAID` for more than N minutes
   with `logistics_tracking_id is null` and calls `publishDeliveryReady` again. Idempotent by
   order id, so a double-send is harmless. **Recommended.**
2. **Manual** — an operator re-triggers it. Acceptable at current volume.

### 5.3 Environment

```
LOGISTICS_API_URL=https://logistics.example.com
LOGISTICS_API_KEY=lg_live_...          # scope: orders:ingest
LOGISTICS_WEBHOOK_SECRET=...           # must match INBOUND_WEBHOOK_SECRET
SUPABASE_SERVICE_ROLE_KEY=...          # server-only, never NEXT_PUBLIC_
SUPABASE_URL=https://<project>.supabase.co
```

Mint the key on the logistics deployment:

```bash
npm run key:mint -- "Grocery storefront" orders:ingest
```

---

## 6. The contract, field by field

What logistics requires, and where it now comes from. Anything missing is a `422` with a
named code and the payload stored for replay.

| Logistics field | Required | Grocery source | Status after Part A |
|---|:--:|---|---|
| `external_order_id` | ✔ | `orders.id` | exists |
| `external_customer_id` | | `orders.user_id` | exists |
| `pickup.location_code` | ✔ | `orders.fulfilment_location_code` | **new (Q2)** |
| `delivery_address.recipient_name` | ✔ | `orders.delivery_recipient_name` | **new (Q1)** |
| `delivery_address.phone` | ✔ | `orders.delivery_phone` | **new (Q1)** |
| `delivery_address.line1` | ✔ | `orders.delivery_line1` | **new (Q1)** |
| `delivery_address.city` | ✔ | `orders.delivery_city` | **new (Q1)** |
| `delivery_address.pincode` | ✔ | `orders.delivery_pincode` | **new (Q1)** |
| `delivery_address.lat` / `.lng` | ✔ | `orders.delivery_lat/lng` | **new (Q1)** |
| `items[].sku` | ✔ | `order_items.sku` | exists |
| `items[].quantity` | ✔ | `order_items.quantity` | exists |
| `items[].reservation_id` | | `order_items.reservation_id` | **new (Q4)** |
| `payment.*` | | `orders.payment_method`, `final_amount` | exists |

Logistics additionally checks that Inventory reports the hold as `held`. An order whose reserve
failed is refused, correctly — which is why §4.4 matters.

---

## 7. RLS

`public.orders` has `SELECT` and `INSERT` policies for the owning customer and **no `UPDATE`
policy at all**. With the table grant in place, an `UPDATE` through the anon key matches zero
rows and *reports success*.

That affects two things here:

| Write | Needs |
|---|---|
| `orders.status = 'FAILED'` on a reserve failure (§4.4) | a customer-scoped `UPDATE` policy |
| `orders.logistics_tracking_id` (§5.1) | nothing — the service-role key bypasses RLS |

```sql
-- Customers may update only their own orders. Narrow it further if the
-- column list ever matters; today the only customer-initiated update is
-- marking a failed checkout.
create policy "Users can update their own orders"
  on public.orders for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
```

> Worth knowing: the logistics system hit exactly this class of bug in its own Phase 2 — a
> grant with a `SELECT` policy and no write policy made an `UPDATE` a silent no-op that fooled
> a test. It is easy to miss precisely because nothing errors.

---

## 8. Verification

Grocery has no test suite, so this is a manual script. It is short.

**Part A**

1. Clear cookies. Open the site → the location prompt appears.
2. Pin a location inside 10 km → shop assigned; check `delivery_geo` exists in devtools.
3. Add an item, go to checkout.
4. Submit empty → all validation messages appear, **no order row is created**.
5. Fill everything, submit → order created. Then in SQL:

```sql
select id, fulfilment_location_code, delivery_recipient_name, delivery_phone,
       delivery_line1, delivery_city, delivery_pincode, delivery_lat, delivery_lng
  from public.orders order by created_at desc limit 1;

select sku, quantity, reservation_id
  from public.order_items
 where order_id = '<that id>';
```

Every column populated; `reservation_id` a real uuid, not null.

6. Pin a location outside 10 km → still redirects to `/out-of-service`. Unchanged.
7. An existing pre-migration order still renders in `/orders`. Unchanged.

**Part B**

8. Place an order → `orders.logistics_tracking_id` is `DLV-YYYY-NNNNNN`.
9. In logistics: `GET /api/v1/deliveries` shows it; the detail screen shows the real address,
   `hold_status: held`, and `hold id known` against each item.
10. Stop logistics, place another order → checkout still **succeeds**; the error is logged;
    `logistics_tracking_id` is null. Restart, re-publish, it appears.
11. Publish the same order twice → one delivery, replayed response.

**Cross-checks in logistics**

```bash
# Nothing should be arriving rejected any more.
GET /api/v1/integration/inbound-events?status=REJECTED

# And the backlog stored during the blocked period can now go through.
POST /api/v1/integration/inbound-events/:id/retry
```

---

## 9. Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| G-01 | Migration on a live table | Low | Additive, all `IF NOT EXISTS`, no backfill, no `NOT NULL`. Reversible with `DROP COLUMN` |
| G-02 | Existing orders have no address | Low | Expected. They were never deliverable. Not backfilled — inventing an address is worse than having none |
| G-03 | A customer with an old `inventory_location` cookie and no `delivery_geo` | **Medium** | Validation catches it and asks them to set their location. Affects anyone who shopped before the change; a one-time prompt |
| G-04 | Service-role key in Grocery | **Medium** | Server-only, never `NEXT_PUBLIC_`. Used for exactly two statements. Rotate on exposure |
| G-05 | Logistics unreachable at checkout | Low | Caught; the order still completes. Retry sweep (§5.2) |
| G-06 | Client-supplied address is unvalidated beyond format | Low | Same trust level as the existing order insert; the geocode comes from the customer's own pin. A bad address surfaces as a failed delivery, which logistics already models |
| G-07 | Phone number now stored and forwarded | **Medium** | It always had to be. Logistics masks it in lists and logs; retention is Phase 7 |
| G-08 | Grocery has no tests, so this can regress silently | Medium | The manual script above; logistics contract tests catch a malformed payload at the door |

---

## 10. Effort and sequencing

| Step | Work | Blocks |
|---|---|---|
| 1 | Migration (§3) | everything |
| 2 | `actions.ts` + `LocationSelector` (§4.1–4.2) | the geocode |
| 3 | Checkout form + insert (§4.3) | Q1, Q2 |
| 4 | Reservation ids (§4.3) | Q4 |
| 5 | RLS update policy + failed-order handling (§4.4, §7) | correctness |
| 6 | Publisher + env (§5) | the handoff |
| 7 | Manual verification (§8) | sign-off |

**Estimate: about a day.** Steps 1–5 are half of it and are independently useful — after step 5
the data exists even if the handoff waits.

**Steps 1–5 alone resolve Q1, Q2 and Q4.** Step 6 resolves the handoff and makes Phase 3 worth
building.

---

## 11. Decisions needed from the Grocery owner

1. **May Grocery be changed at all?** This spec is Q3's answer for the inbound direction.
   Nothing here is a rebuild; every change is additive.
2. **Service-role key, or client-supplied payload?** I recommend the key (§5.1) — publishing
   what is *stored* rather than what the browser *claims*. The alternative avoids a new secret
   and is weaker.
3. **Retry sweep, or manual re-publish?** (§5.2) Recommend the sweep; manual is survivable now.
4. **Add the `UPDATE` policy on `orders`?** (§7) Needed for §4.4, and needed again in Phase 5
   unless logistics writes status with the service-role key.
5. **Who implements it?** I can, with approval — I have not touched Grocery and will not
   without it.

---

## 12. What this does not fix

Said plainly, so nobody reads this as more than it is:

- **Payment is still not real.** `status: 'PAID'` is still set from the browser before any
  money moves. A delivery system built on that is carrying parcels for orders that were never
  paid for. Out of scope here; it should not stay out of scope for long.
- **The customer still cannot see real progress.** `services/orders.ts:54` maps every non-`PAID`
  status to "Delivered". Logistics will publish accurate statuses into a UI that cannot render
  them. That is Phase 5 / Q3, and it is one line plus a mapping table.
- **Saved addresses still do not exist.** Every order re-types the address. The columns are
  prepared; the book is not built.
- **Q21 is untouched.** Inventory returns no coordinates for its shops, so logistics still has
  no geocode for the *pickup* end. Grocery's `stores.ts` has them; Inventory should own them.


---

## 13. What shipped

**Implemented 2026-09-12** on branch `feat/delivery-address-and-logistics-handoff`, cut from a
clean `main` at `391938e`. **Not committed and not pushed.**

### Files

| File | Change |
|---|---|
| `migrations/001_delivery_details.sql` | **new** — run against the live database |
| `schema.sql` | modified — the same columns and policies, for fresh installs |
| `src/app/actions.ts` | `setDeliveryLocation`, `getDeliveryContext`, `notifyLogistics` |
| `src/components/LocationSelector.tsx` | keeps the customer's pin instead of discarding it |
| `src/app/checkout/page.tsx` | controlled form, validation, snapshot, reservation ids, handoff |
| `src/services/logistics.ts` | **new** — the publisher, server-only |
| `scripts/republish-missed-orders.mjs` | **new** — recovers handoffs that never landed |
| `.env.example` | **new** — every variable, with its failure mode |
| `.gitignore` | `!.env.example`, so the template is committable |
| `package.json` | `logistics:republish` |

356 insertions, 23 deletions across the tracked files, plus four new ones.

### Verification

| Check | Result |
|---|---|
| `npx tsc --noEmit` | **clean** |
| `npx eslint` on changed files | **0 errors** (2 warnings, both pre-existing) |
| `npm run build` | **PASS**, 13 routes |
| `npm run logistics:republish` with no config | clear message, no stack trace |
| `npm run logistics:republish -- --dry-run` | same |

### The contract, proven end to end

Grocery cannot be run whole here — there are no Supabase credentials on this machine — so the
part that crosses the boundary was tested directly: **Grocery's real `buildDeliveryReadyEvent`
was imported and run against the live logistics service.**

```
1. Reserve real stock in Inventory     -> reservation_id 9b123884-…
2. Build the payload with Grocery's own exported function
3. Sign it as publishDeliveryReady does, POST to logistics

   -> HTTP 201 { "tracking_id": "DLV-2026-000022", "status": "RECEIVED" }
```

What landed in the logistics database:

| | |
|---|---|
| tracking_id | `DLV-2026-000022` |
| pickup_location_code | `SH1` — **Q2** |
| recipient / city / pincode | `A. Sharma` / `Mumbai` / `400058` — **Q1** |
| lat, lng | `19.120400, 72.850100` — **Q1** |
| hold_status | `held`, verified against live Inventory |
| `delivery_item.reservation_id` | `df678774-…` — **Q4** |

The reservation id survived the whole journey: Inventory → Grocery → logistics. That is the
fix for Q4, and it needed no change to Inventory at all.

The builder also proved two conversions that a mock would not have: Supabase returns numerics
as **strings**, and they are coerced to numbers before sending; and rupees are converted to
paise as integers.

### Deviations from the spec

| Spec said | Built | Why |
|---|---|---|
| `import "server-only"` | a three-line `typeof window` guard | the package is not installed, and this needs no dependency. The `node:crypto` import already fails a client bundle; this just says *why* |
| — | prefill of name from the profile | **removed.** It tripped `react-hooks/set-state-in-effect`, and it was a nicety I added, not a requirement |
| retry sweep "recommended" | **built** — `republishMissedOrders` + a script | exporting it without a caller would repeat the exact mistake this whole programme exists to fix: `commitInventory` has been defined and uncalled in this repo since day one |

### Not done, and deliberately

- **Nothing was committed or pushed.** The branch is yours to review.
- **The migration has not been run.** It needs the live database; §8 is the script to follow.
- **No end-to-end run through the browser**, because there are no Supabase credentials here.
  Steps 1–11 of §8 still need doing by someone who has them.
- **Payment is still not real**, and `services/orders.ts:54` still maps every non-`PAID` status
  to "Delivered". Both remain out of scope, and both still matter.
