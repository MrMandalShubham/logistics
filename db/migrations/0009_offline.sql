-- ============================================================
-- 0009 - Offline sync: events captured on a phone, applied later
--
-- ── The shape of the problem ──
--
-- A rider in a basement finishes a delivery at 14:02 and the phone
-- reconnects at 15:30. In between, a dispatcher may have reassigned
-- it, marked it failed, or cancelled it — all in good faith, because
-- from their side the rider had gone silent.
--
-- Two accounts of the same doorstep then arrive. The wrong answer is
-- to let whichever one synced last win; that is how a parcel gets
-- delivered twice, or recorded as never delivered at all. So every
-- irreconcilable case becomes an exception with a person's name on
-- it rather than a row quietly overwritten.
--
-- ── What is NOT weakened ──
--
-- The OTP. The code is captured on the phone and verified HERE, by
-- the same verify_otp every online delivery goes through. Shipping
-- the hash to the device would make a six-digit code a few seconds of
-- offline brute force, which is precisely what Phase 4a withholds.
-- ============================================================

-- ─────────────── where a delivery is, on the happy path ───────────────

/**
 * A rank for the linear part of the journey.
 *
 * Lets an out-of-order replay tell "this already happened" (a no-op,
 * and fine) from "this cannot happen" (a conflict, and not fine).
 * Everything off the happy path returns null and is judged explicitly.
 */
create or replace function delivery.status_rank(p_status text) returns integer
language sql immutable as $$
  select case p_status
    when 'RECEIVED'             then 0
    when 'READY_FOR_ASSIGNMENT' then 1
    when 'ASSIGNED'             then 2
    when 'ACCEPTED'             then 3
    when 'PICKUP_PENDING'       then 4
    when 'PICKED_UP'            then 5
    when 'OUT_FOR_DELIVERY'     then 6
    when 'ARRIVED'              then 7
    when 'DELIVERED'            then 8
    else null
  end;
$$;

-- ─────────────── the journal of what a phone reported ───────────────

create table integration.rider_event (
  id bigint generated always as identity primary key,

  -- Generated ON THE DEVICE, at the moment the rider tapped. The
  -- server never invents it, which is what makes a replay always
  -- recognisable as a replay.
  client_event_id uuid not null unique,

  rider_id    uuid not null references fleet.rider(id),
  delivery_id uuid not null references delivery.delivery(id),

  action  text not null check (action in ('step','complete','fail','location')),
  payload jsonb not null,

  -- When the RIDER did it, and when we heard. The gap between them is
  -- how long the signal was out, and it is worth keeping.
  captured_at timestamptz not null,
  received_at timestamptz not null default now(),

  status text not null default 'APPLIED'
           check (status in ('APPLIED','NOOP','CONFLICT','REJECTED')),

  outcome       jsonb,
  conflict_code text
);

create index rider_event_delivery on integration.rider_event (delivery_id, captured_at);
create index rider_event_conflict on integration.rider_event (status)
  where status = 'CONFLICT';

comment on column integration.rider_event.captured_at is
  'Device time, clamped server-side. A phone clock is a claim, not evidence.';

-- ─────────────── applying one captured event ───────────────

/**
 * Apply a single event a phone reported.
 *
 * Returns a result rather than raising, because a batch of ten events
 * must not lose nine good ones to one bad one — and because a
 * conflict is a normal outcome of being offline, not an exception in
 * the programming sense.
 *
 * Outcomes:
 *   APPLIED   it happened
 *   NOOP      it had already happened (a replay, or an out-of-order step)
 *   CONFLICT  it cannot be reconciled; a person is now involved
 *   REJECTED  it was never this rider's to report
 */
create or replace function integration.apply_rider_event(
  p_client_event_id uuid,
  p_delivery_id     uuid,
  p_action          text,
  p_payload         jsonb,
  p_captured_at     timestamptz
) returns jsonb
language plpgsql security definer
set search_path = integration, delivery, fleet, identity, ops, public, extensions
as $$
declare
  e          integration.rider_event%rowtype;
  d          delivery.delivery%rowtype;
  v_rider    uuid;
  v_assign   fleet.assignment%rowtype;
  v_captured timestamptz;
  v_target   text;
  v_rank_now integer;
  v_rank_to  integer;
  v_otp      jsonb;
  v_result   jsonb;
  v_stale    boolean := false;
begin
  -- ── already seen? ──
  --
  -- The retry case, and the second-device case. Returning the original
  -- outcome is what makes a flaky connection harmless.
  select * into e from integration.rider_event where client_event_id = p_client_event_id;
  if e.id is not null then
    return jsonb_build_object(
      'client_event_id', p_client_event_id,
      'status', e.status,
      'replayed', true,
      'conflict_code', e.conflict_code,
      'outcome', e.outcome);
  end if;

  select * into d from delivery.delivery where id = p_delivery_id;
  if d.id is null then
    return jsonb_build_object('client_event_id', p_client_event_id,
      'status', 'REJECTED', 'message', 'No such delivery.');
  end if;

  -- ── whose event is this? ──
  --
  -- Deliberately looks for ANY assignment, not just a live one. "Was
  -- yours until a dispatcher moved it" is a conflict; "was never
  -- yours" is a rejection, and confusing the two would either hide a
  -- real handover or accept a stranger's.
  select r.id into v_rider from fleet.rider r where r.user_id = ops.current_actor_id();

  if v_rider is null then
    return jsonb_build_object('client_event_id', p_client_event_id,
      'status', 'REJECTED', 'message', 'You are not a rider.');
  end if;

  select * into v_assign from fleet.assignment
   where delivery_id = p_delivery_id and rider_id = v_rider
   order by assigned_at desc limit 1;

  if v_assign.id is null then
    return jsonb_build_object('client_event_id', p_client_event_id,
      'status', 'REJECTED', 'message', 'That delivery was never assigned to you.');
  end if;

  -- ── when did it really happen? ──
  --
  -- Clamped between the assignment and now. A device clock can be
  -- wrong by hours and can be set deliberately; it is a claim, not
  -- evidence, and an unclamped value would let somebody backdate a
  -- delivery to inside an SLA window.
  v_captured := greatest(least(p_captured_at, now()), v_assign.assigned_at);

  if now() - v_captured > interval '24 hours' then
    v_stale := true;
  end if;

  v_rank_now := delivery.status_rank(d.status);

  -- ── the irreconcilable cases ──
  if d.status = 'CANCELLED' then
    insert into delivery.delivery_exception (delivery_id, code, severity, note, raised_by)
    values (p_delivery_id, 'DELIVERED_AFTER_CANCEL', 'CRITICAL',
            format('Rider reported "%s" at %s, after the delivery was cancelled.',
                   p_action, v_captured), ops.current_actor_id());

    insert into integration.rider_event
      (client_event_id, rider_id, delivery_id, action, payload, captured_at,
       status, conflict_code)
    values (p_client_event_id, v_rider, p_delivery_id, p_action, p_payload, v_captured,
            'CONFLICT', 'DELIVERED_AFTER_CANCEL');

    return jsonb_build_object('client_event_id', p_client_event_id,
      'status', 'CONFLICT', 'conflict_code', 'DELIVERED_AFTER_CANCEL',
      'message', 'This delivery was cancelled while you were offline. Dispatch has been told.');
  end if;

  if v_assign.status in ('SUPERSEDED','EXPIRED','DECLINED')
     and p_action in ('step','complete') then
    insert into delivery.delivery_exception (delivery_id, code, severity, note, raised_by)
    values (p_delivery_id, 'ASSIGNMENT_SUPERSEDED', 'CRITICAL',
            format('Rider reported "%s" at %s, but the assignment was %s.',
                   p_action, v_captured, lower(v_assign.status)), ops.current_actor_id());

    insert into integration.rider_event
      (client_event_id, rider_id, delivery_id, action, payload, captured_at,
       status, conflict_code)
    values (p_client_event_id, v_rider, p_delivery_id, p_action, p_payload, v_captured,
            'CONFLICT', 'ASSIGNMENT_SUPERSEDED');

    return jsonb_build_object('client_event_id', p_client_event_id,
      'status', 'CONFLICT', 'conflict_code', 'ASSIGNMENT_SUPERSEDED',
      'message', 'This delivery was given to somebody else while you were offline. '
                 || 'Dispatch has been told — do not hand it over again.');
  end if;

  if d.status = 'DELIVERY_FAILED' and p_action = 'complete' then
    insert into delivery.delivery_exception (delivery_id, code, severity, note, raised_by)
    values (p_delivery_id, 'CONFLICTING_OUTCOME', 'CRITICAL',
            format('Rider reported a completion at %s; it is already marked failed.',
                   v_captured), ops.current_actor_id());

    insert into integration.rider_event
      (client_event_id, rider_id, delivery_id, action, payload, captured_at,
       status, conflict_code)
    values (p_client_event_id, v_rider, p_delivery_id, p_action, p_payload, v_captured,
            'CONFLICT', 'CONFLICTING_OUTCOME');

    return jsonb_build_object('client_event_id', p_client_event_id,
      'status', 'CONFLICT', 'conflict_code', 'CONFLICTING_OUTCOME',
      'message', 'This delivery is already recorded as failed. Dispatch has been told.');
  end if;

  -- ── the ordinary cases ──
  if p_action = 'step' then
    v_target := p_payload ->> 'to';
    v_rank_to := delivery.status_rank(v_target);

    -- Already past it. Out-of-order replay is expected, not an error.
    if v_rank_now is not null and v_rank_to is not null and v_rank_to <= v_rank_now then
      insert into integration.rider_event
        (client_event_id, rider_id, delivery_id, action, payload, captured_at, status)
      values (p_client_event_id, v_rider, p_delivery_id, p_action, p_payload, v_captured, 'NOOP');

      return jsonb_build_object('client_event_id', p_client_event_id,
        'status', 'NOOP', 'delivery_status', d.status);
    end if;

    begin
      perform delivery.rider_step(p_delivery_id, v_target, 'offline_sync', null);
      v_result := jsonb_build_object('delivery_status', v_target);
    exception when others then
      insert into integration.rider_event
        (client_event_id, rider_id, delivery_id, action, payload, captured_at,
         status, conflict_code)
      values (p_client_event_id, v_rider, p_delivery_id, p_action, p_payload, v_captured,
              'CONFLICT', 'ILLEGAL_TRANSITION');

      return jsonb_build_object('client_event_id', p_client_event_id,
        'status', 'CONFLICT', 'conflict_code', 'ILLEGAL_TRANSITION',
        'message', sqlerrm);
    end;

  elsif p_action = 'complete' then
    if d.status = 'DELIVERED' then
      insert into integration.rider_event
        (client_event_id, rider_id, delivery_id, action, payload, captured_at, status)
      values (p_client_event_id, v_rider, p_delivery_id, p_action, p_payload, v_captured, 'NOOP');

      return jsonb_build_object('client_event_id', p_client_event_id,
        'status', 'NOOP', 'delivery_status', 'DELIVERED');
    end if;

    -- The SAME verification every online delivery goes through. The
    -- code travelled in the outbox; nothing about checking it changed.
    v_otp := delivery.complete_delivery(p_delivery_id, p_payload ->> 'otp', null);

    if not (v_otp ->> 'ok')::boolean then
      insert into delivery.delivery_exception (delivery_id, code, severity, note, raised_by)
      values (p_delivery_id, 'PROOF_DISPUTED', 'CRITICAL',
              format('Offline completion at %s: the code did not verify (%s). '
                     || 'The parcel was handed over; the proof was not good.',
                     v_captured, v_otp ->> 'code'), ops.current_actor_id());

      insert into integration.rider_event
        (client_event_id, rider_id, delivery_id, action, payload, captured_at,
         status, conflict_code, outcome)
      values (p_client_event_id, v_rider, p_delivery_id, p_action, p_payload, v_captured,
              'CONFLICT', 'PROOF_DISPUTED', v_otp);

      return jsonb_build_object('client_event_id', p_client_event_id,
        'status', 'CONFLICT', 'conflict_code', 'PROOF_DISPUTED',
        'message', 'The code did not verify. Dispatch has been told and will call the customer.');
    end if;

    -- It happened when the rider said it happened, not when the phone
    -- found a signal. Otherwise every duration and SLA figure is wrong
    -- by however long the rider was out of contact.
    update delivery.delivery set delivered_at = v_captured where id = p_delivery_id;
    v_result := jsonb_build_object('delivery_status', 'DELIVERED', 'delivered_at', v_captured);

  elsif p_action = 'fail' then
    if d.status = 'DELIVERY_FAILED' then
      insert into integration.rider_event
        (client_event_id, rider_id, delivery_id, action, payload, captured_at, status)
      values (p_client_event_id, v_rider, p_delivery_id, p_action, p_payload, v_captured, 'NOOP');
      return jsonb_build_object('client_event_id', p_client_event_id, 'status', 'NOOP');
    end if;

    perform delivery.fail_delivery(p_delivery_id,
      p_payload ->> 'reason_code', p_payload ->> 'note');
    v_result := jsonb_build_object('delivery_status', 'DELIVERY_FAILED');

  elsif p_action = 'location' then
    -- A position from a window that has since closed is history, not
    -- an error. Recording it would be wrong; refusing the whole sync
    -- over it would be worse.
    begin
      perform fleet.record_location(p_delivery_id,
        (p_payload ->> 'lat')::numeric, (p_payload ->> 'lng')::numeric,
        (p_payload ->> 'accuracy_m')::numeric);
      v_result := jsonb_build_object('recorded', true);
    exception when others then
      insert into integration.rider_event
        (client_event_id, rider_id, delivery_id, action, payload, captured_at, status)
      values (p_client_event_id, v_rider, p_delivery_id, p_action, p_payload, v_captured, 'NOOP');
      return jsonb_build_object('client_event_id', p_client_event_id,
        'status', 'NOOP', 'message', 'Outside the carrying window.');
    end;
  end if;

  if v_stale then
    insert into delivery.delivery_exception (delivery_id, code, severity, note, raised_by)
    values (p_delivery_id, 'STALE_SYNC', 'WARNING',
            format('Reported %s after it happened (%s).',
                   age(now(), v_captured), v_captured), ops.current_actor_id());
  end if;

  insert into integration.rider_event
    (client_event_id, rider_id, delivery_id, action, payload, captured_at, status, outcome)
  values (p_client_event_id, v_rider, p_delivery_id, p_action, p_payload, v_captured,
          'APPLIED', v_result);

  perform ops.audit('rider.event_synced', 'delivery', p_delivery_id::text, null,
    jsonb_build_object('action', p_action, 'captured_at', v_captured, 'stale', v_stale));

  return jsonb_build_object('client_event_id', p_client_event_id,
    'status', 'APPLIED', 'stale', v_stale) || coalesce(v_result, '{}'::jsonb);
end $$;

-- ─────────────── row-level security ───────────────

alter table integration.rider_event enable row level security;

create policy rider_event_read on integration.rider_event
  for select using (
    identity.has_permission('deliveries:read')
    or exists (select 1 from fleet.rider r
                where r.id = rider_id and r.user_id = ops.current_actor_id()));

grant select, insert, update on integration.rider_event to authenticated;

-- ─────────────── what a person needs to look at ───────────────

/**
 * Conflicts nobody has dealt with yet.
 *
 * A definer function, because reading the table under row-level
 * security as a background role shows nothing — the same trap that
 * has now bitten this codebase three times.
 */
create or replace function integration.open_conflicts()
returns table (
  event_id       bigint,
  delivery_id    uuid,
  tracking_id    text,
  rider_code     text,
  action         text,
  conflict_code  text,
  captured_at    timestamptz,
  received_at    timestamptz,
  resolved       boolean
)
language sql stable security definer
set search_path = integration, delivery, fleet, public, extensions
as $$
  select e.id, e.delivery_id, d.tracking_id, r.code, e.action, e.conflict_code,
         e.captured_at, e.received_at,
         exists (select 1 from delivery.delivery_exception x
                  where x.delivery_id = e.delivery_id
                    and x.code = e.conflict_code
                    and x.resolved_at is not null)
    from integration.rider_event e
    join delivery.delivery d on d.id = e.delivery_id
    join fleet.rider r on r.id = e.rider_id
   where e.status = 'CONFLICT'
   order by e.received_at desc;
$$;
