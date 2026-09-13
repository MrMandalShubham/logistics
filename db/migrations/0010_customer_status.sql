-- ============================================================
-- 0010 — Telling the customer
--
-- Phases 1-4 built a delivery system nobody outside it could see.
-- A customer placed an order and then watched a page that said
-- "Delivered" from the moment it was paid for, because Grocery's
-- order view had no third state to show.
--
-- This migration is the logistics half of fixing that: a mapping
-- from fifteen internal statuses to the six a customer's order can
-- be in, a rule about when that is worth sending, and a record of
-- what was sent.
--
-- ── The rule that shapes everything here ──
--
-- Logistics has fifteen statuses. The customer's view has four
-- meaningful states. Five internal transitions in a row can leave
-- the customer's view completely unchanged -- ASSIGNED, ACCEPTED and
-- PICKUP_PENDING all mean "we are packing it".
--
-- Sending an event for each would cost five HTTP requests, five
-- retry budgets and five rows, to tell somebody something they
-- already knew. Worse, it buries the two events that matter -- "on
-- its way" and "we could not deliver it" -- in noise.
--
-- So an event is enqueued ONLY when what the customer would see
-- actually changes. That comparison is `delivery.notified_key`.
-- ============================================================

-- ─────────────── the mapping ───────────────

/**
 * What a customer should see, given what logistics knows.
 *
 * A lookup rather than a chain of branches, so that this reads as
 * the mapping table it is and a missing status is visibly missing.
 * Column 2 is what Grocery's orders.status should become; column 3
 * is which step of its four-step progress bar to light.
 *
 * Immutable and total: every one of the fifteen statuses has an
 * answer, and a NULL external_status is a real answer meaning "this
 * changes nothing the customer can see".
 *
 * ── Why some statuses deliberately say nothing ──
 *
 *   RECEIVED            Grocery created the order as PAID itself and
 *                       already shows "placed". Echoing it back is a
 *                       round trip to tell somebody their own news.
 *
 *   RETURN_REQUIRED     The customer already knows we could not
 *   RETURN_IN_TRANSIT   deliver. Where the parcel goes next is our
 *                       logistics, not their order status.
 *
 * ── The one that is wrong, and knowingly so ──
 *
 *   RETURNED -> CANCELLED. Grocery's orders.status CHECK constraint
 *   has no RETURNED. A completed return therefore collapses into
 *   "cancelled", which is not the same thing to an accountant.
 *   Widening that CHECK is a Grocery schema change (C-02) and is not
 *   in this phase; the true status stays accurate in the logistics
 *   timeline, and travels in reason_code.
 */
create or replace function delivery.customer_view(p_status text)
returns table (external_status text, pipeline_step text)
language sql immutable as $$
  select m.external_status, m.pipeline_step
    from (values
      -- Nothing the customer can see has changed.
      ('RECEIVED',             null::text, null::text),
      ('RETURN_REQUIRED',      null,       null),
      ('RETURN_IN_TRANSIT',    null,       null),

      -- Being prepared. Four internal states, one customer-visible one.
      ('READY_FOR_ASSIGNMENT', 'PAID',     'packed'),
      ('ASSIGNED',             'PAID',     'packed'),
      ('ACCEPTED',             'PAID',     'packed'),
      ('PICKUP_PENDING',       'PAID',     'packed'),

      -- On the move. ARRIVED deserves its own step one day; adding a
      -- fifth step is a Grocery UI change, so it shares this one.
      ('PICKED_UP',            'SHIPPED',  'out_for_delivery'),
      ('OUT_FOR_DELIVERY',     'SHIPPED',  'out_for_delivery'),
      ('ARRIVED',              'SHIPPED',  'out_for_delivery'),

      -- Did not happen today. Still "out for delivery" as far as
      -- Grocery's CHECK allows; the reason carries the truth.
      ('DELIVERY_FAILED',      'SHIPPED',  'out_for_delivery'),
      ('RESCHEDULE_REQUIRED',  'SHIPPED',  'out_for_delivery'),

      ('DELIVERED',            'DELIVERED','delivered'),
      ('RETURNED',             'CANCELLED', null),
      ('CANCELLED',            'CANCELLED', null)
    ) as m(status, external_status, pipeline_step)
   where m.status = p_status;
$$;

comment on function delivery.customer_view(text) is
  'Total map from the 15 logistics statuses to what a customer sees. NULL external_status means "nothing visible changed" and is a deliberate answer, not a gap.';

/**
 * The words a customer reads.
 *
 * Kept in one function rather than scattered through the application
 * so that changing the tone is one diff and one review, and so the
 * same sentence cannot drift between the email that does not exist
 * yet and the order page that does.
 *
 * Plain and not apologetic: somebody checking where their shopping is
 * wants to know where their shopping is.
 */
create or replace function delivery.customer_message(
  p_status text, p_reason text default null
) returns text
language sql immutable as $$
  select case
    when p_status = 'DELIVERED' then 'Delivered. Thank you.'
    when p_status = 'RETURNED'  then 'Your order has been returned to the shop.'
    when p_status = 'CANCELLED' then 'Your order has been cancelled.'

    when p_status in ('DELIVERY_FAILED','RESCHEDULE_REQUIRED') then
      case p_reason
        when 'CUSTOMER_UNREACHABLE' then 'We could not reach you at the address. We will try again.'
        when 'ADDRESS_WRONG'        then 'We could not find the address. Please check it and contact support.'
        when 'CUSTOMER_REFUSED'     then 'The order was refused at the door.'
        when 'NO_ACCESS'            then 'The rider could not get into the building. We will try again.'
        when 'PACKAGE_DAMAGED'      then 'The parcel was damaged, so we did not hand it over. Contact support.'
        else 'We could not deliver your order today. We will try again.'
      end

    when p_status in ('PICKED_UP','OUT_FOR_DELIVERY','ARRIVED') then
      'Your order is on its way.'

    when p_status in ('READY_FOR_ASSIGNMENT','ASSIGNED','ACCEPTED','PICKUP_PENDING') then
      'We have your order and it is being packed.'
  end;
$$;

-- ─────────────── change detection ───────────────
--
-- What Grocery was last TOLD, which is not the same as what
-- logistics last knew. Held on the delivery so the comparison is a
-- single row read inside the same transaction as the transition --
-- no second table, no race between two status changes a second
-- apart.

alter table delivery.delivery
  add column if not exists notified_key text,
  add column if not exists notified_at  timestamptz;

comment on column delivery.delivery.notified_key is
  'customer_status|pipeline_step|reason of the last event enqueued for Grocery. Equal means the customer would see no change, so nothing is sent.';

-- ─────────────── what was sent, to whom, and whether it worked ───────────────

create table ops.notification (
  id bigint generated always as identity primary key,

  delivery_id uuid references delivery.delivery(id) on delete cascade,

  -- customer_app is the only channel that is real. email and sms
  -- exist so that the day a provider is chosen, this table already
  -- has the rows and the callers -- see the `log` driver in
  -- lib/notify.ts, which records intent and sends nothing.
  channel text not null check (channel in ('customer_app','email','sms')),

  event text not null,

  -- An opaque id from the other system. Never a name, an email
  -- address or a phone number: logistics has no business holding a
  -- customer's contact details, and this table is read by staff.
  recipient_ref text,

  payload jsonb not null,

  status text not null default 'QUEUED'
           check (status in ('QUEUED','SENT','FAILED','SUPPRESSED')),

  -- The queue row that carries it. Null for a channel that never
  -- queues, such as the log driver.
  outbound_event_id bigint references integration.outbound_event(id) on delete set null,

  detail text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index notification_delivery_idx on ops.notification (delivery_id, created_at desc);
create index notification_outbound_idx on ops.notification (outbound_event_id)
  where outbound_event_id is not null;
create index notification_failed_idx   on ops.notification (created_at desc)
  where status = 'FAILED';

comment on table ops.notification is
  'One row per attempt to tell somebody something. A customer_app row IS the notification -- pushing the status to Grocery is what the customer sees.';

-- ─────────────── the enqueue ───────────────

/**
 * Turn a status change into a customer-visible event -- or decide it
 * is not one.
 *
 * ── Why this is a trigger on the timeline ──
 *
 * Status reaches the customer by five different routes: transition,
 * rider_step, complete_delivery, fail_delivery and the offline
 * replay in apply_rider_event. Hooking each one means five places to
 * forget.
 *
 * Every one of them writes exactly one row to
 * delivery_status_history -- that table is insert-only and enforced
 * so by trigger -- which makes it the one place a status change
 * cannot hide from. Hooking here is not a shortcut; it is the only
 * position that cannot be bypassed by a route added in Phase 6.
 *
 * ── Why it can never fail a delivery ──
 *
 * The whole body is wrapped. A rider standing at a door must not
 * have their delivery rolled back because Grocery's queue had a bad
 * moment. An event that is not queued is a stale order page; a
 * failed transition is a parcel nobody can account for.
 */
create or replace function delivery.notify_customer()
returns trigger
language plpgsql security definer
set search_path = delivery, ops, integration, fleet, public, extensions
as $$
declare
  d          delivery.delivery%rowtype;
  v_view     record;
  v_reason   text;
  v_key      text;
  v_rider    text;
  v_event_id bigint;
  v_payload  jsonb;
begin
  select * into v_view from delivery.customer_view(new.to_status);

  -- Nothing the customer can see changed. RECEIVED and the two
  -- return-transit states land here by design; `not found` means a
  -- status nobody has mapped, which is also not something to guess
  -- at in front of a customer.
  if not found or v_view.external_status is null then
    return new;
  end if;

  select * into d from delivery.delivery where id = new.delivery_id;
  if d.id is null then return new; end if;

  -- ── Only a reason the CUSTOMER is being told counts ──
  --
  -- Every transition carries a reason_code, but almost all of them
  -- are internal bookkeeping: 'admitted', 'assigned', 'accepted',
  -- 'pickup'. Putting those in the comparison key makes every key
  -- unique, which defeats the suppression entirely and sends four
  -- identical "being packed" events -- the exact noise this
  -- migration exists to prevent.
  --
  -- A failure is the opposite case. DELIVERY_FAILED maps to the same
  -- pair as OUT_FOR_DELIVERY, so without its reason in the key the
  -- customer would never be told the delivery failed at all. There
  -- the reason is the whole message, and if one ever arrives without
  -- one the raw status stands in rather than being swallowed.
  v_reason := case
    when new.to_status in ('DELIVERY_FAILED','RESCHEDULE_REQUIRED')
      then coalesce(new.reason_code, new.to_status)
  end;

  v_key := coalesce(v_view.external_status, '-') || '|' ||
           coalesce(v_view.pipeline_step,   '-') || '|' ||
           coalesce(v_reason,               '-');

  -- The whole point of this migration.
  if d.notified_key is not distinct from v_key then
    return new;
  end if;

  -- Q34: a first name, and nothing else. A customer who needs to
  -- speak to a rider rings support -- there is no number-masking
  -- provider in this estate (Q9), and publishing a worker's real
  -- mobile to every customer is not a thing to do by default.
  select split_part(r.display_name, ' ', 1)
    into v_rider
    from fleet.assignment a
    join fleet.rider r on r.id = a.rider_id
   where a.delivery_id = new.delivery_id
     and a.status = 'ACCEPTED'
   order by a.created_at desc
   limit 1;

  v_payload := jsonb_build_object(
    -- Deterministic, so a re-send of the same timeline row is
    -- recognisable as a duplicate by the receiver as well as by us.
    'event_id',          'evt_' || new.id,
    -- P5-03: at-least-once delivery says nothing about order. A
    -- monotonic sequence lets Grocery reject an event older than
    -- what it already applied without trusting two clocks to agree.
    'sequence',          new.id,
    'occurred_at',       new.occurred_at,
    'tracking_id',       d.tracking_id,
    'external_order_id', d.external_order_id,
    'status',            new.to_status,
    'customer_status',   v_view.external_status,
    'pipeline_step',     v_view.pipeline_step,
    -- v_reason, not new.reason_code: 'admitted' and 'assigned' are
    -- this system's vocabulary, and shipping them into a customer's
    -- order record would be leaking our internals into their history.
    'reason_code',       v_reason,
    'message',           delivery.customer_message(new.to_status, v_reason),
    'rider_first_name',  v_rider,
    'promised_to',       d.promised_to
  );

  v_event_id := integration.enqueue_outbound(
    'GROCERY', 'delivery.status_changed', v_payload,
    'dsc:' || new.id,          -- one timeline row, one event, ever
    new.delivery_id);

  update delivery.delivery
     set notified_key = v_key, notified_at = now()
   where id = new.delivery_id;

  insert into ops.notification
    (delivery_id, channel, event, recipient_ref, payload, status, outbound_event_id)
  values
    (new.delivery_id, 'customer_app', 'delivery.status_changed',
     d.external_customer_id, v_payload,
     case when v_event_id is null then 'FAILED' else 'QUEUED' end,
     v_event_id);

  return new;
exception when others then
  -- Deliberately swallowed. See the header.
  begin
    perform ops.audit('notification.enqueue_failed', 'delivery',
                      new.delivery_id::text, null,
                      jsonb_build_object('to_status', new.to_status),
                      sqlerrm);
  exception when others then null;
  end;
  return new;
end $$;

create trigger delivery_history_notifies_customer
  after insert on delivery.delivery_status_history
  for each row execute function delivery.notify_customer();

-- ─────────────── the worker's way back in ───────────────

/**
 * Mark what actually happened to a queued notification.
 *
 * A definer function rather than an UPDATE from the worker, for the
 * reason this codebase keeps rediscovering: under RLS, an UPDATE
 * with no matching policy affects zero rows and reports success. A
 * notification log that silently stops being written is worse than
 * no log, because it is believed.
 */
create or replace function ops.record_notification_result(
  p_outbound_event_id bigint, p_ok boolean, p_detail text default null
) returns integer
language plpgsql security definer
set search_path = ops, public, extensions
as $$
declare v_n integer;
begin
  update ops.notification
     set status = case when p_ok then 'SENT' else 'FAILED' end,
         detail = p_detail,
         updated_at = now()
   where outbound_event_id = p_outbound_event_id;

  get diagnostics v_n = row_count;
  return v_n;
end $$;

/**
 * Record an intent that no provider exists to fulfil.
 *
 * Phase 5 was asked for "notification integration". There is no
 * email or SMS provider anywhere in this estate, so rather than
 * invent a sender that cannot be tested, this records that we would
 * have sent something and marks it SUPPRESSED. The day a provider is
 * chosen it becomes a driver behind a call site that already exists.
 */
create or replace function ops.log_notification(
  p_delivery_id uuid, p_channel text, p_event text, p_payload jsonb
) returns bigint
language plpgsql security definer
set search_path = ops, public, extensions
as $$
declare v_id bigint;
begin
  insert into ops.notification
    (delivery_id, channel, event, payload, status, detail)
  values
    (p_delivery_id, p_channel, p_event, p_payload, 'SUPPRESSED',
     'no ' || p_channel || ' provider is configured')
  returning id into v_id;
  return v_id;
end $$;

-- ─────────────── what the admin screen reads ───────────────

/**
 * Queue health.
 *
 * A definer function, and for the third time in this codebase the
 * reason is worth writing down: a plain SELECT under RLS as a role
 * with no matching policy returns nothing and reports success. An
 * empty health screen would then mean "all clear" and "you cannot
 * see anything" at the same time. Those must not look alike.
 */
create or replace function integration.outbound_health()
returns table (
  target text, status text, n bigint, oldest timestamptz, next_due timestamptz)
language sql security definer
set search_path = integration, public, extensions
as $$
  select e.target, e.status, count(*)::bigint,
         min(e.created_at), min(e.next_attempt_at)
    from integration.outbound_event e
   group by e.target, e.status
   order by e.target, e.status;
$$;

/** The ones a person has to do something about. */
create or replace function integration.dead_outbound(p_limit integer default 50)
returns table (
  id bigint, target text, event text, attempts integer,
  last_error text, created_at timestamptz, delivery_id uuid, tracking_id text)
language sql security definer
set search_path = integration, delivery, public, extensions
as $$
  select e.id, e.target, e.event, e.attempts, e.last_error, e.created_at,
         e.delivery_id, d.tracking_id
    from integration.outbound_event e
    left join delivery.delivery d on d.id = e.delivery_id
   where e.status = 'DEAD'
   order by e.created_at desc
   limit p_limit;
$$;

/** Recent notifications, newest first, for one delivery or for all. */
create or replace function ops.recent_notifications(
  p_delivery_id uuid default null, p_limit integer default 100)
returns table (
  id bigint, delivery_id uuid, tracking_id text, channel text, event text,
  status text, detail text, created_at timestamptz, payload jsonb)
language sql security definer
set search_path = ops, delivery, public, extensions
as $$
  select n.id, n.delivery_id, d.tracking_id, n.channel, n.event,
         n.status, n.detail, n.created_at, n.payload
    from ops.notification n
    left join delivery.delivery d on d.id = n.delivery_id
   where p_delivery_id is null or n.delivery_id = p_delivery_id
   order by n.created_at desc
   limit p_limit;
$$;

-- ─────────────── permissions ───────────────

insert into identity.role_permission (role, permission) values
  ('admin',      'notifications:read'),
  ('dispatcher', 'notifications:read')
on conflict do nothing;

-- ─────────────── row-level security ───────────────

alter table ops.notification enable row level security;

create policy notification_read on ops.notification
  for select using (identity.has_permission('notifications:read'));

grant select on ops.notification to authenticated;
grant execute on function ops.record_notification_result(bigint, boolean, text) to authenticated;
grant execute on function ops.log_notification(uuid, text, text, jsonb) to authenticated;
grant execute on function ops.recent_notifications(uuid, integer) to authenticated;
grant execute on function integration.outbound_health() to authenticated;
grant execute on function integration.dead_outbound(integer) to authenticated;
grant execute on function delivery.customer_view(text) to authenticated;
grant execute on function delivery.customer_message(text, text) to authenticated;

-- The trigger function is called by Postgres, never by a client.
revoke all on function delivery.notify_customer() from public;
revoke all on function delivery.notify_customer() from authenticated;
