-- ============================================================
-- 0005 - Deliveries: the record, its snapshot, and its timeline
--
-- ── What a delivery IS ──
--
-- A parcel with a destination, and the history of what happened to
-- it. Not an order: Grocery owns that. Not stock: Inventory owns
-- that. We hold external identifiers and a SNAPSHOT of what a rider
-- needs to carry the thing to a door.
--
-- ── Why the address and items are snapshots ──
--
-- They are facts about a parcel at the moment it was dispatched, not
-- a view onto someone else's current data. If a customer edits their
-- address in Grocery after the rider has left, the rider must still
-- go where the parcel was addressed. A live lookup would silently
-- redirect a bag that is already on a bicycle.
--
-- This is also why logistics never EDITS an address. Two systems
-- holding an editable address means two answers to "where does this
-- customer live", and the stale one wins whenever it is asked last.
-- ============================================================

create schema if not exists delivery;

-- ─────────────── tracking ids ───────────────

create table delivery.tracking_counter (
  year       integer primary key,
  last_value integer not null default 0
);

/**
 * DLV-2026-000001.
 *
 * Readable over a telephone, which is the whole requirement: a
 * customer rings up and reads it out. A uuid is not that.
 *
 * ON CONFLICT DO UPDATE locks the year's row, so concurrent ingests
 * serialise here rather than racing for a number.
 */
create or replace function delivery.next_tracking_id() returns text
language plpgsql security definer
set search_path = delivery, public, extensions
as $$
declare v_year integer := extract(year from now()); v_next integer;
begin
  insert into delivery.tracking_counter (year, last_value)
  values (v_year, 1)
  on conflict (year) do update
    set last_value = delivery.tracking_counter.last_value + 1
  returning last_value into v_next;

  return 'DLV-' || v_year || '-' || lpad(v_next::text, 6, '0');
end $$;

-- ─────────────── the delivery ───────────────

create table delivery.delivery (
  id                uuid primary key default gen_random_uuid(),

  -- The idempotency guarantee at the DATA layer, not merely in the
  -- request wrapper. Two concurrent ingests of one order cannot both
  -- insert, whatever the application believes about its own locking.
  external_order_id text not null unique,
  tracking_id       text not null unique,

  external_customer_id text,

  status text not null default 'RECEIVED' check (status in (
    'RECEIVED','READY_FOR_ASSIGNMENT','ASSIGNED','ACCEPTED',
    'PICKUP_PENDING','PICKED_UP','OUT_FOR_DELIVERY','ARRIVED',
    'DELIVERED','DELIVERY_FAILED','RESCHEDULE_REQUIRED',
    'RETURN_REQUIRED','RETURN_IN_TRANSIT','RETURNED','CANCELLED')),

  pickup_location_code text not null references integration.location_ref(code),

  -- Reference only. Logistics never computes or reconciles an amount;
  -- it carries what it was told so a rider knows whether to collect.
  payment_method          text,
  is_prepaid              boolean not null default true,
  amount_to_collect_paise integer not null default 0
                            check (amount_to_collect_paise >= 0),
  order_total_paise       integer,

  promised_from timestamptz,
  promised_to   timestamptz,

  -- What Inventory said about the hold when we took the order in.
  -- 'unknown' means Inventory could not be reached: the delivery is
  -- still created, and flagged, because an Inventory blip must not
  -- become a Grocery outage.
  hold_status     text not null default 'unknown'
                    check (hold_status in ('held','delivered','released','unknown')),
  hold_expires_at timestamptz,
  -- Stays false until Q4 is resolved and we can actually call
  -- confirm. Not aspirational: the expiry report reads this.
  hold_confirmed  boolean not null default false,

  placed_at  timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index delivery_status_idx   on delivery.delivery (status, created_at desc);
create index delivery_location_idx on delivery.delivery (pickup_location_code, status);
-- The expiry monitor's query: live holds, soonest first.
create index delivery_hold_idx     on delivery.delivery (hold_expires_at)
  where hold_status = 'held' and not hold_confirmed;

comment on column delivery.delivery.hold_status is
  'From GET /api/inventory/order/:id at ingest. "unknown" means Inventory was unreachable, not that the hold is bad.';

-- ─────────────── the snapshot ───────────────

create table delivery.delivery_address (
  delivery_id    uuid primary key references delivery.delivery(id) on delete cascade,
  recipient_name text not null,
  phone          text not null,
  line1          text not null,
  line2          text,
  city           text not null,
  state          text,
  pincode        text not null,
  -- Required, not optional. A destination a rider cannot navigate to
  -- is not a destination.
  lat            numeric(9,6) not null,
  lng            numeric(9,6) not null,
  instructions   text
);

comment on table delivery.delivery_address is
  'A SNAPSHOT at dispatch. Never edited: Grocery owns the customer address, and two editable copies means the stale one eventually wins.';

create table delivery.delivery_item (
  id                  uuid primary key default gen_random_uuid(),
  delivery_id         uuid not null references delivery.delivery(id) on delete cascade,
  external_product_id text,
  sku                 text not null,
  name                text not null,
  quantity            integer not null check (quantity > 0),
  -- Nullable by necessity: reserve returns reservation ids and
  -- GET /api/inventory/order/:id does not, so unless the sender
  -- forwards them we never see them (open question Q4).
  reservation_id      uuid
);

create index delivery_item_delivery on delivery.delivery_item (delivery_id);

-- ─────────────── the timeline ───────────────

create table delivery.delivery_status_history (
  id             bigint generated always as identity primary key,
  delivery_id    uuid not null references delivery.delivery(id) on delete cascade,
  from_status    text,
  to_status      text not null,
  actor_id       uuid,
  actor_role     text,
  actor_kind     text,
  reason_code    text,
  note           text,
  correlation_id text,
  occurred_at    timestamptz not null default now()
);

create index delivery_history_idx on delivery.delivery_status_history
  (delivery_id, occurred_at, id);

-- Insert-only, for the same reason the audit log is. A timeline you
-- can edit answers whatever question you like.
create trigger delivery_history_no_update
  before update on delivery.delivery_status_history
  for each row execute function ops.refuse_mutation();

create trigger delivery_history_no_delete
  before delete on delivery.delivery_status_history
  for each row execute function ops.refuse_mutation();

-- ─────────────── the state machine ───────────────

/**
 * Where a delivery may go from here.
 *
 * Phase 2 only reaches the first two states; the rest of the enum
 * exists so later phases widen THIS function rather than adding a
 * second place where status changes. An empty array means terminal.
 *
 * Later phases replace this function. They do not add another one.
 */
create or replace function delivery.allowed_next(p_from text) returns text[]
language sql immutable as $$
  select case p_from
    when 'RECEIVED'             then array['READY_FOR_ASSIGNMENT','CANCELLED']
    when 'READY_FOR_ASSIGNMENT' then array['CANCELLED']
    else array[]::text[]
  end;
$$;

/**
 * The ONLY way a delivery's status changes.
 *
 * Refuses an illegal move, writes the history row and the audit row,
 * and touches updated_at -- all in one transaction, so a status that
 * moved without a timeline entry is not representable.
 */
create or replace function delivery.transition(
  p_delivery_id uuid,
  p_to          text,
  p_reason      text default null,
  p_note        text default null
) returns text
language plpgsql security definer
set search_path = delivery, ops, public, extensions
as $$
declare
  d       delivery.delivery%rowtype;
  v_allow text[];
begin
  -- FOR UPDATE: two dispatchers clicking Admit at the same moment
  -- must not both write a history row.
  select * into d from delivery.delivery where id = p_delivery_id for update;
  if d.id is null then
    raise exception 'NO_SUCH_DELIVERY: %', p_delivery_id using errcode = 'P0002';
  end if;

  if not ops.can_access_location(d.pickup_location_code) then
    raise exception 'FORBIDDEN_LOCATION: you may not act on deliveries at %',
      d.pickup_location_code using errcode = '42501';
  end if;

  v_allow := delivery.allowed_next(d.status);

  if not (p_to = any(v_allow)) then
    raise exception 'ILLEGAL_TRANSITION: % cannot become %. Allowed: %',
      d.status, p_to,
      case when cardinality(v_allow) = 0 then 'nothing (terminal)'
           else array_to_string(v_allow, ', ') end
      using errcode = '23514';
  end if;

  update delivery.delivery
     set status = p_to, updated_at = now()
   where id = p_delivery_id;

  insert into delivery.delivery_status_history
    (delivery_id, from_status, to_status, actor_id, actor_role, actor_kind,
     reason_code, note, correlation_id)
  values
    (p_delivery_id, d.status, p_to, ops.current_actor_id(), ops.current_role_name(),
     ops.current_actor_kind(), p_reason, p_note,
     ops.current_claims() ->> 'correlation_id');

  perform ops.audit(
    'delivery.' || lower(p_to), 'delivery', p_delivery_id::text,
    jsonb_build_object('status', d.status),
    jsonb_build_object('status', p_to),
    p_reason);

  return p_to;
end $$;

-- ─────────────── ingest ───────────────

/**
 * Create a delivery from a validated payload.
 *
 * Everything lands in one transaction: the delivery, its address, its
 * items and the first timeline row. A delivery with no address is not
 * a state this system can be in, even briefly.
 *
 * Idempotent by external_order_id. A second call returns the existing
 * delivery rather than raising -- a retry after a timeout is the
 * normal case, not an error.
 */
create or replace function delivery.ingest_order(
  p_external_order_id text,
  p_customer_id       text,
  p_location_code     text,
  p_address           jsonb,
  p_items             jsonb,
  p_payment           jsonb default '{}'::jsonb,
  p_promised_from     timestamptz default null,
  p_promised_to       timestamptz default null,
  p_placed_at         timestamptz default null,
  p_hold_status       text default 'unknown',
  p_hold_expires_at   timestamptz default null
) returns table (delivery_id uuid, tracking_id text, status text, created boolean)
language plpgsql security definer
set search_path = delivery, integration, ops, public, extensions
as $$
declare
  v_id    uuid;
  v_track text;
  item    jsonb;
begin
  -- Already here? Hand back what the first call produced.
  select d.id, d.tracking_id, d.status into v_id, v_track, status
    from delivery.delivery d where d.external_order_id = p_external_order_id;

  if v_id is not null then
    delivery_id := v_id; tracking_id := v_track; created := false;
    return next; return;
  end if;

  if not exists (select 1 from integration.location_ref
                  where code = p_location_code and is_active) then
    raise exception 'UNKNOWN_PICKUP_LOCATION: % is not a known active location',
      p_location_code using errcode = '23503';
  end if;

  v_track := delivery.next_tracking_id();

  insert into delivery.delivery (
    external_order_id, tracking_id, external_customer_id, pickup_location_code,
    payment_method, is_prepaid, amount_to_collect_paise, order_total_paise,
    promised_from, promised_to, placed_at, hold_status, hold_expires_at)
  values (
    p_external_order_id, v_track, p_customer_id, p_location_code,
    p_payment ->> 'method',
    coalesce((p_payment ->> 'is_prepaid')::boolean, true),
    coalesce((p_payment ->> 'amount_to_collect_paise')::integer, 0),
    (p_payment ->> 'order_total_paise')::integer,
    p_promised_from, p_promised_to, p_placed_at, p_hold_status, p_hold_expires_at)
  returning id into v_id;

  insert into delivery.delivery_address (
    delivery_id, recipient_name, phone, line1, line2, city, state, pincode,
    lat, lng, instructions)
  values (
    v_id,
    p_address ->> 'recipient_name', p_address ->> 'phone',
    p_address ->> 'line1', p_address ->> 'line2',
    p_address ->> 'city', p_address ->> 'state', p_address ->> 'pincode',
    (p_address ->> 'lat')::numeric, (p_address ->> 'lng')::numeric,
    p_address ->> 'instructions');

  for item in select * from jsonb_array_elements(p_items) loop
    insert into delivery.delivery_item
      (delivery_id, external_product_id, sku, name, quantity, reservation_id)
    values (
      v_id, item ->> 'external_product_id', item ->> 'sku', item ->> 'name',
      (item ->> 'quantity')::integer,
      nullif(item ->> 'reservation_id', '')::uuid);
  end loop;

  insert into delivery.delivery_status_history
    (delivery_id, from_status, to_status, actor_id, actor_role, actor_kind,
     reason_code, correlation_id)
  values
    (v_id, null, 'RECEIVED', ops.current_actor_id(), ops.current_role_name(),
     ops.current_actor_kind(), 'ingested',
     ops.current_claims() ->> 'correlation_id');

  perform ops.audit('delivery.created', 'delivery', v_id::text, null,
    jsonb_build_object('external_order_id', p_external_order_id,
                       'tracking_id', v_track,
                       'location', p_location_code,
                       'hold_status', p_hold_status));

  delivery_id := v_id; tracking_id := v_track; status := 'RECEIVED'; created := true;
  return next;
end $$;

-- ─────────────── row-level security ───────────────

alter table delivery.delivery                enable row level security;
alter table delivery.delivery_address        enable row level security;
alter table delivery.delivery_item           enable row level security;
alter table delivery.delivery_status_history enable row level security;
alter table delivery.tracking_counter        enable row level security;

-- Location scoping bites here: a dispatcher bound to SH1 sees SH1's
-- queue and nobody else's customers.
create policy delivery_read on delivery.delivery
  for select using (
    identity.has_permission('deliveries:read')
    and ops.can_access_location(pickup_location_code));

-- The child rows inherit the parent's visibility. Written as an
-- EXISTS against the same policy rather than repeated conditions, so
-- there is one rule to change.
create policy delivery_address_read on delivery.delivery_address
  for select using (exists (
    select 1 from delivery.delivery d where d.id = delivery_id));

create policy delivery_item_read on delivery.delivery_item
  for select using (exists (
    select 1 from delivery.delivery d where d.id = delivery_id));

create policy delivery_history_read on delivery.delivery_status_history
  for select using (exists (
    select 1 from delivery.delivery d where d.id = delivery_id));

-- Nobody reads the counter; it is an implementation detail of the
-- tracking id and is only touched by a definer function.
create policy tracking_counter_none on delivery.tracking_counter
  for select using (false);

-- ─────────────── grants ───────────────
--
-- No DELETE, as everywhere else. A delivery that did not happen is a
-- delivery with a terminal status.

grant usage on schema delivery to authenticated;
grant select, insert, update on all tables in schema delivery to authenticated;
grant usage on all sequences in schema delivery to authenticated;
grant execute on all functions in schema delivery to authenticated;

alter default privileges in schema delivery
  grant select, insert, update on tables to authenticated;
alter default privileges in schema delivery
  grant execute on functions to authenticated;
