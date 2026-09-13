-- ============================================================
-- 0011 — Finishing the unhappy paths
--
-- Five phases have accumulated three things that the system raises
-- and nothing resolves:
--
--   delivery_exception       rows raised by 4a and 4b; nothing closes them
--   open_conflicts()         lists conflicts; nothing decides them (Q30)
--   RETURN_REQUIRED          a path in the state machine nothing walks
--
-- 0008 says it outright: "-- Phase 6 completes the return."
--
-- ── The rule this migration is built on ──
--
-- Every resolution is a DECISION BY A NAMED PERSON, recorded with
-- their reason, and expressed as a new transition. Nothing here edits
-- history. `delivery_status_history` stays insert-only, so a dispute
-- resolved to DELIVERED shows both the dispute and the decision, in
-- order, forever.
--
-- The alternative -- a timer that converts "we do not know" into "it
-- arrived" after 24 hours -- is how a system ends up confidently
-- stating things nobody ever checked.
-- ============================================================

-- ─────────────── who is holding the parcel ───────────────
--
-- A rescheduled delivery goes back to the pool, but the parcel does
-- not go back to the shop: it is in the previous rider's bag. Telling
-- the next rider to collect it from the shop would send them to the
-- wrong building.

alter table delivery.delivery
  add column if not exists parcel_with_rider_id uuid references fleet.rider(id),
  add column if not exists returned_at timestamptz,
  add column if not exists release_status text not null default 'none'
    check (release_status in ('none','pending','verified','failed'));

comment on column delivery.delivery.parcel_with_rider_id is
  'Who physically has the parcel. NULL means the pickup location does. Set at PICKED_UP, cleared when the parcel reaches its destination or comes back.';

-- ─────────────── a proof that is a decision, not a handover ───────────────
--
-- 0008 left a note saying "Phase 6 extends this". A dispute resolved
-- to DELIVERED has to record SOMETHING as proof, and recording it as
-- 'OTP' would be a lie in the one table whose job is to say what
-- actually happened at a door. OVERRIDE says what it was: a named
-- person decided, and the note says who they spoke to.

alter table delivery.delivery_proof
  drop constraint if exists delivery_proof_type_check;

alter table delivery.delivery_proof
  add constraint delivery_proof_type_check
  check (type in ('OTP','PHOTO','SIGNATURE','OVERRIDE'));

alter table delivery.delivery_proof
  add column if not exists note text;

comment on column delivery.delivery_proof.note is
  'Only for OVERRIDE: why a dispatcher accepted a delivery whose code failed. Reading it later is the whole point.';

-- ─────────────── the return leg, for a phone with no signal ───────────────

/**
 * 0009 ranked the delivery path and stopped at DELIVERED.
 *
 * That was right when nothing walked the return path. Now that a
 * rider carries a parcel back, the gap matters: `apply_rider_event`
 * uses this rank to recognise "you have already passed this step" and
 * answer NOOP. With a NULL rank that check is skipped, the transition
 * is attempted, it fails because RETURN_IN_TRANSIT cannot become
 * itself — and a duplicate event from a flaky connection is reported
 * to a dispatcher as a CONFLICT.
 *
 * A conflict is two people disagreeing. A phone sending the same
 * thing twice is not that, and calling it that trains everybody to
 * ignore the queue.
 *
 * DELIVERED and DELIVERY_FAILED share rank 8: they are the same
 * moment at the door, two outcomes. Nothing compares them, because a
 * failure arrives as action='fail' and never as a step.
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
    -- the doorstep did not go to plan
    when 'DELIVERY_FAILED'      then 8
    when 'RESCHEDULE_REQUIRED'  then 9
    when 'RETURN_REQUIRED'      then 10
    when 'RETURN_IN_TRANSIT'    then 11
    when 'RETURNED'             then 12
    -- CANCELLED stays unranked: it is not a point on the path, and
    -- apply_rider_event handles it as an irreconcilable case before
    -- any ranking happens.
    else null
  end;
$$;

-- ─────────────── resolution, on the exception itself ───────────────

alter table delivery.delivery_exception
  add column if not exists resolved_by     uuid references identity.app_user(id),
  add column if not exists resolution_code text;

create index if not exists delivery_exception_recent
  on delivery.delivery_exception (raised_at desc);

-- ─────────────── the one trigger that watches the timeline ───────────────

/**
 * Track the parcel, and tell Inventory when stock comes back.
 *
 * ── Why this is on the timeline, like Phase 5's ──
 *
 * Status reaches a terminal state by six routes now, and Phase 7 will
 * add more. Every one of them writes exactly one insert-only row to
 * delivery_status_history. Hooking there is the only position a route
 * added later cannot bypass.
 *
 * ── Why the release fires on RETURNED and not RETURN_REQUIRED ──
 *
 * RETURN_REQUIRED means a dispatcher decided the parcel should come
 * back. RETURNED means somebody confirmed it did. Telling Inventory
 * stock is available while it is still in a rider's bag would put
 * something on the shelf that is not there.
 */
create or replace function delivery.track_parcel_and_stock()
returns trigger
language plpgsql security definer
set search_path = delivery, fleet, integration, ops, public, extensions
as $$
declare
  d       delivery.delivery%rowtype;
  v_rider uuid;
begin
  select * into d from delivery.delivery where id = new.delivery_id;
  if d.id is null then return new; end if;

  -- The parcel leaves the shop.
  if new.to_status = 'PICKED_UP' then
    select a.rider_id into v_rider
      from fleet.assignment a
     where a.delivery_id = new.delivery_id and a.status = 'ACCEPTED'
     order by a.created_at desc limit 1;

    update delivery.delivery set parcel_with_rider_id = v_rider
     where id = new.delivery_id;
    return new;
  end if;

  -- It reaches somewhere it stops being a rider's problem.
  if new.to_status in ('DELIVERED','RETURNED','CANCELLED') then
    update delivery.delivery set parcel_with_rider_id = null
     where id = new.delivery_id;
  end if;

  -- ── Give the stock back ──
  --
  -- A release for a hold that already expired is a no-op at
  -- Inventory's end and a success at ours: the stock is on the shelf
  -- either way, and this is the ledger record of why.
  if new.to_status in ('RETURNED','CANCELLED') then
    update delivery.delivery
       set release_status = 'pending',
           returned_at = case when new.to_status = 'RETURNED' then now() else returned_at end
     where id = new.delivery_id;

    perform integration.enqueue_outbound(
      'INVENTORY', 'inventory.release',
      jsonb_build_object(
        'order_id', d.external_order_id,
        'reason', lower(new.to_status) || ': ' || coalesce(new.reason_code, 'no reason given')),
      'release:' || d.external_order_id,
      new.delivery_id);
  end if;

  return new;
exception when others then
  -- Same rule as Phase 5's notifier: a queue problem must never roll
  -- back a delivery. A rider bringing a parcel back must not be told
  -- "no" because Inventory's queue had a bad moment.
  begin
    perform ops.audit('release.enqueue_failed', 'delivery', new.delivery_id::text,
                      null, jsonb_build_object('to_status', new.to_status), sqlerrm);
  exception when others then null;
  end;
  return new;
end $$;

create trigger delivery_history_tracks_parcel
  after insert on delivery.delivery_status_history
  for each row execute function delivery.track_parcel_and_stock();

/**
 * The worker's way back in, for the release.
 *
 * A definer function rather than an UPDATE from the worker, for the
 * reason this codebase has now rediscovered five times: under RLS an
 * UPDATE with no matching policy affects zero rows and reports
 * success. delivery.delivery has no UPDATE policy on purpose.
 */
create or replace function delivery.record_release_result(
  p_delivery_id uuid, p_status text, p_code text default null, p_note text default null
) returns void
language plpgsql security definer
set search_path = delivery, ops, public, extensions
as $$
begin
  update delivery.delivery set release_status = p_status where id = p_delivery_id;

  if p_code is not null then
    insert into delivery.delivery_exception (delivery_id, code, severity, note)
    values (p_delivery_id, p_code, 'CRITICAL', p_note);
  end if;

  perform ops.audit('inventory.release_' || p_status, 'delivery',
                    p_delivery_id::text, null, null, p_note);
end $$;

-- ─────────────── resolving an exception ───────────────

/**
 * Close an exception, with a name and a reason against it.
 *
 * Resolving does not delete the row and does not touch the delivery.
 * The original account of what went wrong survives, which is the
 * whole reason an exception is a row rather than a log line.
 *
 * Idempotent: resolving twice returns ALREADY_RESOLVED rather than
 * overwriting somebody else's reason with your own.
 */
create or replace function delivery.resolve_exception(
  p_exception_id uuid, p_resolution_code text, p_note text default null
) returns text
language plpgsql security definer
set search_path = delivery, identity, ops, public, extensions
as $$
declare x delivery.delivery_exception%rowtype;
begin
  if not identity.has_permission('exceptions:resolve') then
    raise exception 'FORBIDDEN: resolving an exception requires exceptions:resolve'
      using errcode = '42501';
  end if;

  select * into x from delivery.delivery_exception where id = p_exception_id for update;
  if x.id is null then
    raise exception 'NO_SUCH_EXCEPTION: %', p_exception_id using errcode = 'P0002';
  end if;

  if x.resolved_at is not null then
    return 'ALREADY_RESOLVED';
  end if;

  if p_resolution_code is null or btrim(p_resolution_code) = '' then
    raise exception 'RESOLUTION_REQUIRED: say what was decided'
      using errcode = '23514';
  end if;

  update delivery.delivery_exception
     set resolved_at = now(),
         resolved_by = ops.current_actor_id(),
         resolution_code = p_resolution_code,
         resolution = p_note
   where id = p_exception_id;

  perform ops.audit('exception.resolved', 'delivery', x.delivery_id::text,
    jsonb_build_object('code', x.code),
    jsonb_build_object('resolution', p_resolution_code), p_note);

  return 'RESOLVED';
end $$;

-- ─────────────── Q30: deciding a conflict ───────────────
--
-- ── Why the resolution lives on the EVENT ──
--
-- 0009 raised a delivery_exception alongside some conflicts and not
-- others: ASSIGNMENT_SUPERSEDED, DELIVERED_AFTER_CANCEL and
-- CONFLICTING_OUTCOME get one; a conflict caught by the generic
-- handler -- code ILLEGAL_TRANSITION, which is the commonest of the
-- lot -- gets none.
--
-- `open_conflicts()` decided whether a conflict was resolved by
-- looking for a RESOLVED EXCEPTION with a matching code. For the
-- whole ILLEGAL_TRANSITION class there is no such row and never will
-- be, so those conflicts could be decided and would still be listed
-- as outstanding, forever. A queue that will not empty is a queue
-- people stop reading.
--
-- The conflict is a property of the rider event, so its resolution is
-- too. A matching exception is still closed when one exists, because
-- it is the same piece of work.

alter table integration.rider_event
  add column if not exists resolved_at     timestamptz,
  add column if not exists resolved_by     uuid references identity.app_user(id),
  add column if not exists resolution_code text,
  add column if not exists resolution      text;

create index if not exists rider_event_open_conflicts
  on integration.rider_event (received_at desc)
  where status = 'CONFLICT' and resolved_at is null;

-- The return type gains a column, so a replace is not enough.
drop function if exists integration.open_conflicts();

create function integration.open_conflicts()
returns table (
  event_id       bigint,
  delivery_id    uuid,
  tracking_id    text,
  rider_code     text,
  action         text,
  conflict_code  text,
  captured_at    timestamptz,
  received_at    timestamptz,
  resolved       boolean,
  resolution     text
)
language sql stable security definer
set search_path = integration, delivery, fleet, public, extensions
as $$
  select e.id, e.delivery_id, d.tracking_id, r.code, e.action, e.conflict_code,
         e.captured_at, e.received_at,
         e.resolved_at is not null,
         e.resolution
    from integration.rider_event e
    join delivery.delivery d on d.id = e.delivery_id
    join fleet.rider r on r.id = e.rider_id
   where e.status = 'CONFLICT'
   order by (e.resolved_at is not null), e.received_at desc;
$$;

/**
 * Two accounts of the same doorstep disagree. Somebody decides.
 *
 * Phase 4b's rule was that a conflict is surfaced and never silently
 * applied or silently discarded. This is the other half: a person
 * chooses, and the choice is as recorded as the conflict was.
 *
 *   ACCEPT     the rider's account stands; move the delivery there
 *   DISCARD    it is superseded; the delivery does not move
 *   RECONCILE  neither; the dispatcher names a different outcome
 *
 * ACCEPT is deliberately not automatic even when the transition is
 * legal. The rider reported a delivery for a parcel that had been
 * given to somebody else — which of the two of them actually handed
 * it over is not a question a state machine can answer.
 */
create or replace function integration.resolve_conflict(
  p_event_id  bigint,
  p_decision  text,
  p_to_status text default null,
  p_note      text default null
) returns jsonb
language plpgsql security definer
set search_path = integration, delivery, fleet, identity, ops, public, extensions
as $$
declare
  e     integration.rider_event%rowtype;
  x     delivery.delivery_exception%rowtype;
  v_to  text;
begin
  if not identity.has_permission('exceptions:resolve') then
    raise exception 'FORBIDDEN: resolving a conflict requires exceptions:resolve'
      using errcode = '42501';
  end if;

  if p_decision not in ('ACCEPT','DISCARD','RECONCILE') then
    raise exception 'BAD_DECISION: expected ACCEPT, DISCARD or RECONCILE, got %', p_decision
      using errcode = '23514';
  end if;

  if p_note is null or btrim(p_note) = '' then
    raise exception 'NOTE_REQUIRED: a conflict is two people disagreeing. Say what you found'
      using errcode = '23514';
  end if;

  select * into e from integration.rider_event where id = p_event_id for update;
  if e.id is null then
    raise exception 'NO_SUCH_EVENT: %', p_event_id using errcode = 'P0002';
  end if;
  if e.status <> 'CONFLICT' then
    raise exception 'NOT_A_CONFLICT: event % is %', p_event_id, e.status
      using errcode = '23514';
  end if;

  if e.resolved_at is not null then
    return jsonb_build_object(
      'ok', true, 'already_resolved', true,
      'decision', e.resolution_code, 'note', e.resolution);
  end if;

  -- The exception raised alongside it, if there is one at all. For
  -- the ILLEGAL_TRANSITION class there is not, which is exactly why
  -- the resolution below does not depend on finding it.
  select * into x from delivery.delivery_exception
   where delivery_id = e.delivery_id and code = e.conflict_code and resolved_at is null
   order by raised_at desc limit 1;

  if p_decision = 'ACCEPT' then
    -- What the rider said happened.
    v_to := case e.action
      when 'complete' then 'DELIVERED'
      when 'fail'     then 'DELIVERY_FAILED'
      when 'step'     then e.payload ->> 'to'
    end;
  elsif p_decision = 'RECONCILE' then
    if p_to_status is null then
      raise exception 'TO_STATUS_REQUIRED: RECONCILE means naming the outcome'
        using errcode = '23514';
    end if;
    v_to := p_to_status;
  end if;

  if v_to is not null then
    -- Through transition(), so an illegal move is still refused. A
    -- dispatcher may decide what happened; they may not decide that
    -- a cancelled delivery was delivered.
    perform delivery.transition(e.delivery_id, v_to,
      'conflict_' || lower(p_decision), p_note);
  end if;

  -- The conflict is closed here whether or not an exception exists.
  update integration.rider_event
     set resolved_at = now(),
         resolved_by = ops.current_actor_id(),
         resolution_code = p_decision,
         resolution = p_note
   where id = p_event_id;

  if x.id is not null then
    perform delivery.resolve_exception(x.id, p_decision, p_note);
  end if;

  perform ops.audit('conflict.resolved', 'delivery', e.delivery_id::text,
    jsonb_build_object('conflict', e.conflict_code, 'rider_said', e.action),
    jsonb_build_object('decision', p_decision, 'moved_to', v_to), p_note);

  return jsonb_build_object(
    'ok', true, 'decision', p_decision, 'moved_to', v_to, 'exception', x.id);
end $$;

-- ─────────────── §4.1: a disputed proof ───────────────

/**
 * A rider completed a delivery offline with a code the server then
 * rejected. The parcel is gone either way; whether the proof was good
 * is not a decision for a queue.
 *
 * Only two outcomes, both chosen by a person, both requiring a note:
 * somebody rang the customer, or somebody rang the rider, and this
 * records which way it went.
 *
 * DELIVERED here enqueues the commit exactly as a normal completion
 * does — otherwise a delivery resolved this way would never reach
 * Inventory's ledger and the stock would silently never be sold.
 */
create or replace function delivery.resolve_disputed_proof(
  p_delivery_id uuid, p_outcome text, p_note text
) returns jsonb
language plpgsql security definer
set search_path = delivery, integration, identity, ops, public, extensions
as $$
declare d delivery.delivery%rowtype;
begin
  if not identity.has_permission('exceptions:resolve') then
    raise exception 'FORBIDDEN: resolving a disputed proof requires exceptions:resolve'
      using errcode = '42501';
  end if;

  if p_outcome not in ('DELIVERED','DELIVERY_FAILED') then
    raise exception 'BAD_OUTCOME: expected DELIVERED or DELIVERY_FAILED, got %', p_outcome
      using errcode = '23514';
  end if;

  -- Not optional. This is the only record of why somebody overrode a
  -- failed code, and "resolved" on its own answers nothing later.
  if p_note is null or btrim(p_note) = '' then
    raise exception 'NOTE_REQUIRED: say who you spoke to and what they said'
      using errcode = '23514';
  end if;

  select * into d from delivery.delivery where id = p_delivery_id for update;
  if d.id is null then
    raise exception 'NO_SUCH_DELIVERY: %', p_delivery_id using errcode = 'P0002';
  end if;

  perform delivery.transition(p_delivery_id, p_outcome, 'proof_dispute_resolved', p_note);

  if p_outcome = 'DELIVERED' then
    update delivery.delivery
       set delivered_at = coalesce(delivered_at, now()), commit_status = 'pending'
     where id = p_delivery_id;

    -- The proof is the dispatcher's decision, not a code. Recorded as
    -- what it is, so nobody later reads it as a verified handover.
    insert into delivery.delivery_proof (delivery_id, type, captured_by, note)
    values (p_delivery_id, 'OVERRIDE', ops.current_actor_id(), p_note);

    perform integration.enqueue_outbound(
      'INVENTORY', 'inventory.commit',
      jsonb_build_object('order_id', d.external_order_id),
      'commit:' || d.external_order_id,
      p_delivery_id);
  else
    update delivery.delivery set failed_reason_code = 'PROOF_DISPUTED'
     where id = p_delivery_id;
  end if;

  -- Close every open PROOF_DISPUTED on this delivery.
  update delivery.delivery_exception
     set resolved_at = now(), resolved_by = ops.current_actor_id(),
         resolution_code = p_outcome, resolution = p_note
   where delivery_id = p_delivery_id and code = 'PROOF_DISPUTED' and resolved_at is null;

  perform ops.audit('proof.dispute_resolved', 'delivery', p_delivery_id::text,
    null, jsonb_build_object('outcome', p_outcome), p_note);

  return jsonb_build_object('ok', true, 'status', p_outcome);
end $$;

-- ─────────────── §4.3: reschedule ───────────────

/**
 * Try again tomorrow.
 *
 * Two transitions, not one: DELIVERY_FAILED cannot become
 * READY_FOR_ASSIGNMENT directly, and going through
 * RESCHEDULE_REQUIRED means the timeline shows the decision as well
 * as its effect.
 *
 * ── The bit that is easy to get wrong ──
 *
 * The job goes back to the pool. The PARCEL does not. It is in the
 * previous rider's bag, and `parcel_with_rider_id` is deliberately
 * left set so the next assignment can say where to collect it. A
 * reschedule that sends the next rider to the shop sends them to a
 * shelf with nothing on it.
 */
create or replace function delivery.reschedule(
  p_delivery_id uuid, p_note text default null
) returns jsonb
language plpgsql security definer
set search_path = delivery, fleet, identity, ops, public, extensions
as $$
declare
  d       delivery.delivery%rowtype;
  v_held  uuid;
begin
  if not identity.has_permission('deliveries:assign') then
    raise exception 'FORBIDDEN: rescheduling requires deliveries:assign'
      using errcode = '42501';
  end if;

  select * into d from delivery.delivery where id = p_delivery_id for update;
  if d.id is null then
    raise exception 'NO_SUCH_DELIVERY: %', p_delivery_id using errcode = 'P0002';
  end if;

  if d.status = 'DELIVERY_FAILED' then
    perform delivery.transition(p_delivery_id, 'RESCHEDULE_REQUIRED', 'reschedule', p_note);
  end if;

  perform delivery.transition(p_delivery_id, 'READY_FOR_ASSIGNMENT', 'reschedule', p_note);

  -- READY_FOR_ASSIGNMENT is not terminal, so the trigger in 0008 does
  -- not close the assignment. Left open, the previous rider stays at
  -- capacity for a job that is no longer theirs.
  update fleet.assignment
     set status = 'COMPLETED', responded_at = coalesce(responded_at, now())
   where delivery_id = p_delivery_id and status in ('OFFERED','ACCEPTED');

  select parcel_with_rider_id into v_held from delivery.delivery where id = p_delivery_id;

  perform ops.audit('delivery.rescheduled', 'delivery', p_delivery_id::text, null,
    jsonb_build_object('parcel_with_rider', v_held), p_note);

  return jsonb_build_object(
    'ok', true, 'status', 'READY_FOR_ASSIGNMENT', 'parcel_with_rider_id', v_held);
end $$;

/**
 * Send it back to the shop it came from (Q14).
 *
 * The dispatcher's half. The rider then walks RETURN_IN_TRANSIT and
 * RETURNED through the ordinary rider_step path, because they are the
 * one carrying it.
 */
create or replace function delivery.require_return(
  p_delivery_id uuid, p_note text default null
) returns jsonb
language plpgsql security definer
set search_path = delivery, identity, ops, public, extensions
as $$
declare d delivery.delivery%rowtype;
begin
  if not identity.has_permission('deliveries:assign') then
    raise exception 'FORBIDDEN: ordering a return requires deliveries:assign'
      using errcode = '42501';
  end if;

  select * into d from delivery.delivery where id = p_delivery_id;
  if d.id is null then
    raise exception 'NO_SUCH_DELIVERY: %', p_delivery_id using errcode = 'P0002';
  end if;

  perform delivery.transition(p_delivery_id, 'RETURN_REQUIRED', 'return_ordered', p_note);

  perform ops.audit('delivery.return_ordered', 'delivery', p_delivery_id::text, null,
    jsonb_build_object('to_location', d.pickup_location_code), p_note);

  return jsonb_build_object(
    'ok', true, 'status', 'RETURN_REQUIRED', 'return_to', d.pickup_location_code);
end $$;

-- ─────────────── what a dispatcher reads ───────────────

/**
 * The work queue.
 *
 * A definer function. Under RLS a plain SELECT as a role with no
 * matching policy returns zero rows and reports success -- on a queue
 * of things that need attention, "nothing to do" and "you cannot see
 * anything" would render identically. That has now bitten this
 * codebase five times and it is not going to bite it here.
 *
 * Location scoping is applied explicitly, so a dispatcher bound to
 * SH1 sees SH1 because this says so rather than because a policy
 * happened to be in the way.
 */
create or replace function delivery.open_exceptions(p_limit integer default 100)
returns table (
  id uuid, delivery_id uuid, tracking_id text, status text,
  code text, severity text, note text,
  raised_at timestamptz, age_minutes integer,
  location_code text, parcel_with_rider text)
language sql stable security definer
set search_path = delivery, fleet, ops, public, extensions
as $$
  select x.id, x.delivery_id, d.tracking_id, d.status,
         x.code, x.severity, x.note,
         x.raised_at, (extract(epoch from now() - x.raised_at) / 60)::integer,
         d.pickup_location_code, r.display_name
    from delivery.delivery_exception x
    join delivery.delivery d on d.id = x.delivery_id
    left join fleet.rider r on r.id = d.parcel_with_rider_id
   where x.resolved_at is null
     and ops.can_access_location(d.pickup_location_code)
   order by
     case x.severity when 'CRITICAL' then 0 when 'WARNING' then 1 else 2 end,
     x.raised_at
   limit p_limit;
$$;

/** One delivery's exceptions, resolved ones included -- the history matters. */
create or replace function delivery.exceptions_for(p_delivery_id uuid)
returns table (
  id uuid, code text, severity text, note text, raised_at timestamptz,
  resolved_at timestamptz, resolution_code text, resolution text, resolved_by_name text)
language sql stable security definer
set search_path = delivery, identity, ops, public, extensions
as $$
  select x.id, x.code, x.severity, x.note, x.raised_at,
         x.resolved_at, x.resolution_code, x.resolution, u.full_name
    from delivery.delivery_exception x
    left join identity.app_user u on u.id = x.resolved_by
   where x.delivery_id = p_delivery_id
   order by x.raised_at desc;
$$;

-- ─────────────── permissions ───────────────

insert into identity.role_permission (role, permission) values
  ('admin',      'exceptions:resolve'),
  ('dispatcher', 'exceptions:resolve')
on conflict do nothing;

grant execute on function delivery.resolve_exception(uuid, text, text) to authenticated;
grant execute on function delivery.resolve_disputed_proof(uuid, text, text) to authenticated;
grant execute on function delivery.reschedule(uuid, text) to authenticated;
grant execute on function delivery.require_return(uuid, text) to authenticated;
grant execute on function delivery.open_exceptions(integer) to authenticated;
grant execute on function delivery.exceptions_for(uuid) to authenticated;
grant execute on function delivery.record_release_result(uuid, text, text, text) to authenticated;
grant execute on function integration.resolve_conflict(bigint, text, text, text) to authenticated;

-- Called by Postgres, never by a client.
revoke all on function delivery.track_parcel_and_stock() from public;
revoke all on function delivery.track_parcel_and_stock() from authenticated;
