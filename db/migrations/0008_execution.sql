-- ============================================================
-- 0008 - Rider execution, proof, and the commit
--
-- The phase where a parcel actually moves, and where this estate
-- writes its first ledger entry.
--
-- Since the Phase 0 analysis, NOTHING here has ever called
-- stock.commit_order. Every order ever placed held stock for thirty
-- minutes and quietly gave it back; Inventory has never been told
-- that goods left a building. That stops here.
--
-- ── Why the commit is queued rather than called inline ──
--
-- A rider standing at a door must not wait on an HTTP call to another
-- system, and must certainly not be blocked by that system being
-- down. The delivery completes; the bookkeeping follows and retries.
--
-- ── Why the commit is VERIFIED ──
--
-- POST /api/inventory/commit answers `already_committed: true` for a
-- hold that was RELEASED just as it does for one that was CONSUMED
-- (Phase 0 analysis 14.2). Believing it would mean recording a sale
-- whose stock was never reduced. So every commit is followed by a
-- read, and a released hold raises a loud exception instead of a
-- quiet success.
-- ============================================================

-- ─────────────── proof ───────────────

create table delivery.delivery_otp (
  delivery_id uuid primary key references delivery.delivery(id) on delete cascade,

  -- Hashed, like every other secret here. Support cannot read it back;
  -- they RE-ISSUE it, which rotates the code and hands them the new
  -- one once. A code that can be read repeatedly is a code that can
  -- leak repeatedly.
  code_hash   text not null,

  issued_at   timestamptz not null default now(),
  expires_at  timestamptz not null,
  attempts    integer not null default 0,
  consumed_at timestamptz
);

comment on table delivery.delivery_otp is
  'One live code per delivery. Never shown to the rider — a code the rider can read is a code they can use without meeting the customer.';

create table delivery.delivery_proof (
  id          uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references delivery.delivery(id) on delete cascade,

  type text not null check (type in ('OTP','PHOTO','SIGNATURE')),

  -- A reference, never bytes and never a URL. Whoever wants to look at
  -- it asks for a short-lived signed link.
  storage_ref text,

  captured_by uuid,
  captured_at timestamptz not null default now(),
  meta        jsonb
);

create index delivery_proof_delivery on delivery.delivery_proof (delivery_id);

comment on column delivery.delivery_proof.storage_ref is
  'Opaque key into the private proof store. Doorstep photos are not product images: never a public bucket.';

-- Phase 6 extends this with the full taxonomy and support notes.
create table delivery.delivery_exception (
  id          uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references delivery.delivery(id) on delete cascade,
  code        text not null,
  severity    text not null default 'WARNING'
                check (severity in ('INFO','WARNING','CRITICAL')),
  note        text,
  raised_by   uuid,
  raised_at   timestamptz not null default now(),
  resolved_at timestamptz,
  resolution  text
);

create index delivery_exception_open on delivery.delivery_exception (delivery_id)
  where resolved_at is null;

-- ─────────────── rider location ───────────────

create table fleet.rider_location (
  id          bigint generated always as identity primary key,
  rider_id    uuid not null references fleet.rider(id) on delete cascade,
  delivery_id uuid not null references delivery.delivery(id) on delete cascade,
  lat         numeric(9,6) not null,
  lng         numeric(9,6) not null,
  accuracy_m  numeric(7,1),
  recorded_at timestamptz not null default now()
);

create index rider_location_delivery on fleet.rider_location (delivery_id, recorded_at desc);

comment on table fleet.rider_location is
  'Only between PICKED_UP and a terminal state. Continuous tracking of a named worker is not something to collect by default; the window is enforced in fleet.record_location, not left to callers.';

-- ─────────────── the outbound queue ───────────────
--
-- Inventory's 0035 design, ported. It has already survived a worker
-- crash, a duplicate event and a subscriber outage in production; the
-- shape is not worth reinventing.

create table integration.outbound_event (
  id     bigint generated always as identity primary key,

  target text not null check (target in ('INVENTORY','GROCERY')),
  event  text not null,

  -- Deduplication happens at QUEUE time. A receiver cannot tell a
  -- duplicate from a genuine second event, so we must not send one.
  event_key text,

  payload     jsonb not null,
  delivery_id uuid references delivery.delivery(id) on delete set null,

  status text not null default 'PENDING'
           check (status in ('PENDING','SENDING','DELIVERED','FAILED','DEAD')),

  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default now(),

  -- SENDING is a real state: claimed by a worker, outcome unknown.
  -- Without it a crash is indistinguishable from a success.
  claimed_at timestamptz,
  claimed_by text,

  last_error text,
  response   jsonb,

  created_at   timestamptz not null default now(),
  delivered_at timestamptz
);

create unique index outbound_event_once
  on integration.outbound_event (target, event_key)
  where event_key is not null;

create index outbound_event_due on integration.outbound_event (next_attempt_at)
  where status = 'PENDING';
create index outbound_event_claimed on integration.outbound_event (claimed_at)
  where status = 'SENDING';

/** Queue something. Never raises: a queue problem must not fail a delivery. */
create or replace function integration.enqueue_outbound(
  p_target text, p_event text, p_payload jsonb,
  p_event_key text default null, p_delivery_id uuid default null
) returns bigint
language plpgsql security definer
set search_path = integration, ops, public, extensions
as $$
declare v_id bigint;
begin
  insert into integration.outbound_event (target, event, event_key, payload, delivery_id)
  values (p_target, p_event, p_event_key, p_payload, p_delivery_id)
  on conflict do nothing
  returning id into v_id;

  return v_id;
exception when others then
  return null;
end $$;

/** Take a batch. SKIP LOCKED so several workers never take the same row. */
create or replace function integration.claim_outbound_batch(
  p_limit integer default 20, p_worker text default 'worker'
) returns table (
  id bigint, target text, event text, payload jsonb,
  attempts integer, delivery_id uuid
)
language plpgsql security definer
set search_path = integration, ops, public, extensions
as $$
begin
  if ops.current_role_name() not in ('admin','system') then
    raise exception 'FORBIDDEN_ROLE: % may not drain the outbound queue',
      ops.current_role_name() using errcode = '42501';
  end if;

  return query
  with due as (
    select e.id from integration.outbound_event e
     where e.status = 'PENDING' and e.next_attempt_at <= now()
     order by e.next_attempt_at, e.id
     limit greatest(p_limit, 1)
     for update skip locked
  ), claimed as (
    update integration.outbound_event e
       set status = 'SENDING', claimed_at = now(), claimed_by = p_worker
      from due where e.id = due.id
    returning e.*
  )
  select c.id, c.target, c.event, c.payload, c.attempts, c.delivery_id
    from claimed c order by c.id;
end $$;

/**
 * Record what happened.
 *
 * Backoff is exponential from ten seconds, then DEAD. `p_fatal` skips
 * the retries entirely — used when the answer will never change, such
 * as a hold that has been released.
 */
create or replace function integration.record_outbound_result(
  p_id bigint, p_ok boolean, p_error text default null,
  p_response jsonb default null, p_fatal boolean default false
) returns text
language plpgsql security definer
set search_path = integration, ops, public, extensions
as $$
declare e integration.outbound_event%rowtype; v_next integer; v_state text;
begin
  if ops.current_role_name() not in ('admin','system') then
    raise exception 'FORBIDDEN_ROLE: % may not record a delivery result',
      ops.current_role_name() using errcode = '42501';
  end if;

  select * into e from integration.outbound_event where id = p_id;
  if e.id is null then
    raise exception 'NO_SUCH_EVENT: %', p_id using errcode = 'P0002';
  end if;

  v_next := e.attempts + 1;

  if p_ok then
    update integration.outbound_event
       set status = 'DELIVERED', attempts = v_next, delivered_at = now(),
           response = p_response, last_error = null,
           claimed_at = null, claimed_by = null
     where id = p_id;
    return 'DELIVERED';
  end if;

  -- A retry that can never succeed is a retry that buries the queue.
  v_state := case when p_fatal or v_next >= 6 then 'DEAD' else 'PENDING' end;

  update integration.outbound_event
     set status = v_state, attempts = v_next,
         last_error = left(coalesce(p_error, 'unknown'), 500),
         response = p_response,
         next_attempt_at = now() + make_interval(secs => 10 * power(4, e.attempts)::double precision),
         claimed_at = null, claimed_by = null
   where id = p_id;

  return v_state;
end $$;

/**
 * What is waiting, without sending it.
 *
 * A definer function, for the same reason fleet.expiring_assignments()
 * is one: the worker runs under row-level security as a role holding
 * no permissions, so a plain SELECT here returns nothing and reports
 * "the queue is empty" while the queue is not. An operator view that
 * disagrees with the worker is worse than no view at all.
 */
create or replace function integration.pending_outbound()
returns table (
  id bigint, target text, event text, status text,
  attempts integer, next_attempt_at timestamptz, last_error text
)
language sql stable security definer
set search_path = integration, public, extensions
as $$
  select e.id, e.target, e.event, e.status, e.attempts, e.next_attempt_at, e.last_error
    from integration.outbound_event e
   where e.status in ('PENDING','SENDING','DEAD')
   order by e.id;
$$;

/** Reclaim rows abandoned by a worker that died mid-flight. */
create or replace function integration.requeue_stuck_outbound(
  p_older_than interval default interval '5 minutes'
) returns integer
language plpgsql security definer
set search_path = integration, public, extensions
as $$
declare v integer;
begin
  update integration.outbound_event
     set status = 'PENDING', claimed_at = null, claimed_by = null,
         last_error = 'worker did not report back; requeued'
   where status = 'SENDING' and claimed_at < now() - p_older_than;
  get diagnostics v = row_count;
  return v;
end $$;

-- ─────────────── recording what the commit did ───────────────
--
-- Placed here, and SECURITY DEFINER, because the worker runs under
-- row-level security like every other caller — and delivery.delivery
-- has no UPDATE policy, deliberately: status changes go through
-- delivery.transition and nowhere else.
--
-- The first version had the worker UPDATE the table directly and it
-- failed with a WITH CHECK violation, which is the right outcome: the
-- rule held, and the code that ignored it broke loudly instead of
-- writing something it should not have.

create or replace function delivery.record_commit_result(
  p_delivery_id uuid,
  p_status      text,
  p_ledger_ids  jsonb default null,
  p_error_code  text default null,
  p_error_note  text default null
) returns void
language plpgsql security definer
set search_path = delivery, ops, public, extensions
as $$
begin
  if ops.current_role_name() not in ('admin','system') then
    raise exception 'FORBIDDEN_ROLE: % may not record a commit result',
      ops.current_role_name() using errcode = '42501';
  end if;

  update delivery.delivery
     set commit_status = p_status,
         commit_ledger_ids = coalesce(p_ledger_ids, commit_ledger_ids)
   where id = p_delivery_id;

  -- A dead commit is a stock discrepancy, not a queue statistic.
  if p_error_code is not null then
    insert into delivery.delivery_exception
      (delivery_id, code, severity, note)
    values (p_delivery_id, p_error_code, 'CRITICAL', p_error_note);
  end if;

  perform ops.audit('commit.' || p_status, 'delivery', p_delivery_id::text, null,
    jsonb_build_object('ledger_ids', p_ledger_ids), p_error_note);
end $$;

-- ─────────────── the delivery gains a commit record ───────────────

alter table delivery.delivery
  add column commit_status text not null default 'not_required'
    check (commit_status in ('not_required','pending','verified','failed')),
  add column commit_ledger_ids jsonb,
  add column delivered_at timestamptz,
  add column failed_reason_code text;

comment on column delivery.delivery.commit_status is
  'verified means Inventory was asked AND confirmed the stock is consumed. "already_committed" alone is never trusted.';

-- ─────────────── the widened state machine ───────────────

create or replace function delivery.allowed_next(p_from text) returns text[]
language sql immutable as $$
  select case p_from
    when 'RECEIVED'             then array['READY_FOR_ASSIGNMENT','CANCELLED']
    when 'READY_FOR_ASSIGNMENT' then array['ASSIGNED','CANCELLED']
    when 'ASSIGNED'             then array['ACCEPTED','READY_FOR_ASSIGNMENT','CANCELLED']
    when 'ACCEPTED'             then array['PICKUP_PENDING','READY_FOR_ASSIGNMENT','CANCELLED']
    when 'PICKUP_PENDING'       then array['PICKED_UP','DELIVERY_FAILED','CANCELLED']
    when 'PICKED_UP'            then array['OUT_FOR_DELIVERY','DELIVERY_FAILED']
    when 'OUT_FOR_DELIVERY'     then array['ARRIVED','DELIVERY_FAILED']
    when 'ARRIVED'              then array['DELIVERED','DELIVERY_FAILED']
    when 'DELIVERY_FAILED'      then array['RESCHEDULE_REQUIRED','RETURN_REQUIRED']
    when 'RESCHEDULE_REQUIRED'  then array['READY_FOR_ASSIGNMENT','RETURN_REQUIRED']
    -- Phase 6 completes the return.
    when 'RETURN_REQUIRED'      then array['RETURN_IN_TRANSIT']
    when 'RETURN_IN_TRANSIT'    then array['RETURNED']
    else array[]::text[]
  end;
$$;

-- ─────────────── Q25: closing the assignment ───────────────

/**
 * Free the rider when the parcel is no longer theirs.
 *
 * A TRIGGER, not a call at the end of each completion function. There
 * are four ways a delivery can end and more will arrive; one
 * forgotten call and a rider sits at capacity forever, with nothing
 * to indicate why.
 *
 * DELIVERY_FAILED deliberately does NOT close it: the rider is still
 * holding the parcel, and it is still their job until it is
 * rescheduled or returned.
 */
create or replace function fleet.close_assignment_on_terminal()
returns trigger
language plpgsql security definer
set search_path = fleet, ops, public, extensions
as $$
begin
  if new.status in ('DELIVERED','RETURNED','CANCELLED')
     and old.status is distinct from new.status then

    update fleet.assignment
       set status = 'COMPLETED', responded_at = coalesce(responded_at, now())
     where delivery_id = new.id
       and status in ('OFFERED','ACCEPTED');
  end if;
  return null;
end $$;

create trigger delivery_closes_assignment
  after update on delivery.delivery
  for each row execute function fleet.close_assignment_on_terminal();

-- ─────────────── the rider's own guard ───────────────

/**
 * Refuse unless the caller holds the live assignment.
 *
 * Staff with deliveries:assign may act for a rider — somebody has to
 * be able to unstick a delivery when a phone dies.
 */
create or replace function delivery.assert_may_execute(p_delivery_id uuid)
returns void
language plpgsql stable security definer
set search_path = delivery, fleet, identity, ops, public, extensions
as $$
begin
  if ops.current_role_name() = 'rider' then
    if not fleet.is_my_assignment(p_delivery_id) then
      raise exception 'NOT_YOUR_ASSIGNMENT: this delivery is not yours'
        using errcode = '42501';
    end if;
    return;
  end if;

  if identity.has_permission('deliveries:assign') or ops.current_role_name() = 'system' then
    return;
  end if;

  raise exception 'FORBIDDEN: acting on a delivery requires the assignment or deliveries:assign'
    using errcode = '42501';
end $$;

/** One step along the rider's path. */
create or replace function delivery.rider_step(
  p_delivery_id uuid, p_to text, p_reason text default null, p_note text default null
) returns text
language plpgsql security definer
set search_path = delivery, ops, public, extensions
as $$
begin
  perform delivery.assert_may_execute(p_delivery_id);
  perform delivery.transition(p_delivery_id, p_to, p_reason, p_note);

  -- Arriving mints the customer's code. The return value is discarded
  -- deliberately: the rider triggered this and must never see it.
  if p_to = 'ARRIVED' then
    perform delivery.mint_otp(p_delivery_id);
    perform ops.audit('otp.issued', 'delivery', p_delivery_id::text);
  end if;

  return p_to;
end $$;

-- ─────────────── OTP ───────────────

/**
 * Mint a code. INTERNAL — execute is revoked from `authenticated`
 * at the foot of this migration.
 *
 * It exists separately because two callers need it for opposite
 * reasons: `issue_otp` hands the code to support, and `rider_step`
 * must create one when a rider arrives *without* ever returning it to
 * them. Sharing one role-checked function would mean either the rider
 * could read the code or arriving could not mint one.
 */
create or replace function delivery.mint_otp(
  p_delivery_id uuid, p_ttl_seconds integer default 900
) returns text
language plpgsql security definer
set search_path = delivery, ops, public, extensions
as $$
declare v_code text;
begin
  v_code := lpad((floor(random() * 1000000))::int::text, 6, '0');

  insert into delivery.delivery_otp (delivery_id, code_hash, expires_at)
  values (p_delivery_id, encode(digest(v_code, 'sha256'), 'hex'),
          now() + make_interval(secs => p_ttl_seconds))
  on conflict (delivery_id) do update
    set code_hash = excluded.code_hash,
        issued_at = now(),
        expires_at = excluded.expires_at,
        attempts = 0,
        consumed_at = null;

  return v_code;
end $$;

/**
 * Issue (or re-issue) the code for a delivery.
 *
 * Returns the plaintext ONCE. Only the hash is kept, so support
 * asking again rotates the code rather than reading the old one back
 * — which is the point: a code that can be read repeatedly can leak
 * repeatedly.
 *
 * Never callable by a rider. That restriction is the whole basis of
 * the proof: a code the rider can see is a code they can use without
 * ever meeting the customer.
 */
create or replace function delivery.issue_otp(
  p_delivery_id uuid, p_ttl_seconds integer default 900
) returns text
language plpgsql security definer
set search_path = delivery, identity, ops, public, extensions
as $$
declare v_code text;
begin
  if ops.current_role_name() = 'rider' then
    raise exception 'FORBIDDEN: a rider may not see the delivery code'
      using errcode = '42501';
  end if;

  if not identity.has_permission('deliveries:read')
     and ops.current_role_name() <> 'system' then
    raise exception 'FORBIDDEN: reading a delivery code requires deliveries:read'
      using errcode = '42501';
  end if;

  v_code := delivery.mint_otp(p_delivery_id, p_ttl_seconds);

  perform ops.audit('otp.issued', 'delivery', p_delivery_id::text);
  return v_code;
end $$;

/**
 * Check a code.
 *
 * Returns a refusal rather than raising, for the same reason sign-in
 * does: the attempt counter and the audit row must survive the
 * refusal, and a raise would roll both back.
 */
create or replace function delivery.verify_otp(p_delivery_id uuid, p_code text)
returns jsonb
language plpgsql security definer
set search_path = delivery, ops, public, extensions
as $$
declare o delivery.delivery_otp%rowtype;
begin
  select * into o from delivery.delivery_otp where delivery_id = p_delivery_id for update;

  if o.delivery_id is null then
    return jsonb_build_object('ok', false, 'code', 'NO_OTP',
      'message', 'No code has been issued for this delivery.');
  end if;

  if o.consumed_at is not null then
    return jsonb_build_object('ok', false, 'code', 'OTP_USED',
      'message', 'That code has already been used.');
  end if;

  if o.attempts >= 5 then
    perform ops.audit('otp.locked', 'delivery', p_delivery_id::text);
    return jsonb_build_object('ok', false, 'code', 'OTP_LOCKED',
      'message', 'Too many wrong codes. Ask support to issue a new one.');
  end if;

  if o.expires_at <= now() then
    return jsonb_build_object('ok', false, 'code', 'OTP_EXPIRED',
      'message', 'That code has expired. Ask support to issue a new one.');
  end if;

  if o.code_hash <> encode(digest(coalesce(p_code, ''), 'sha256'), 'hex') then
    update delivery.delivery_otp set attempts = attempts + 1 where delivery_id = p_delivery_id;
    perform ops.audit('otp.failed', 'delivery', p_delivery_id::text, null,
      jsonb_build_object('attempt', o.attempts + 1));
    return jsonb_build_object('ok', false, 'code', 'OTP_WRONG',
      'message', 'That code is not right.',
      'attempts_left', 5 - (o.attempts + 1));
  end if;

  update delivery.delivery_otp set consumed_at = now() where delivery_id = p_delivery_id;
  perform ops.audit('otp.verified', 'delivery', p_delivery_id::text);
  return jsonb_build_object('ok', true);
end $$;

-- ─────────────── completion ───────────────

/**
 * The handover happened.
 *
 * ── Why the commit is enqueued and not called ──
 *
 * A rider is standing at a door. Whether Inventory answers is not
 * their problem and must not be their delay. The delivery completes;
 * the ledger entry follows, retries, and shouts if it cannot be made.
 */
create or replace function delivery.complete_delivery(
  p_delivery_id uuid, p_code text, p_photo_ref text default null
) returns jsonb
language plpgsql security definer
set search_path = delivery, fleet, integration, ops, public, extensions
as $$
declare
  d      delivery.delivery%rowtype;
  v_otp  jsonb;
begin
  perform delivery.assert_may_execute(p_delivery_id);

  select * into d from delivery.delivery where id = p_delivery_id;
  if d.id is null then
    raise exception 'NO_SUCH_DELIVERY: %', p_delivery_id using errcode = 'P0002';
  end if;

  v_otp := delivery.verify_otp(p_delivery_id, p_code);
  if not (v_otp ->> 'ok')::boolean then
    return v_otp;
  end if;

  perform delivery.transition(p_delivery_id, 'DELIVERED', 'otp_verified', null);

  update delivery.delivery
     set delivered_at = now(), commit_status = 'pending'
   where id = p_delivery_id;

  insert into delivery.delivery_proof (delivery_id, type, captured_by)
  values (p_delivery_id, 'OTP', ops.current_actor_id());

  if p_photo_ref is not null then
    insert into delivery.delivery_proof (delivery_id, type, storage_ref, captured_by)
    values (p_delivery_id, 'PHOTO', p_photo_ref, ops.current_actor_id());
  end if;

  -- The first write this estate has ever made to Inventory's ledger.
  perform integration.enqueue_outbound(
    'INVENTORY', 'inventory.commit',
    jsonb_build_object('order_id', d.external_order_id),
    'commit:' || d.external_order_id,
    p_delivery_id);

  perform ops.audit('delivery.delivered', 'delivery', p_delivery_id::text, null,
    jsonb_build_object('order', d.external_order_id, 'photo', p_photo_ref is not null));

  return jsonb_build_object('ok', true, 'status', 'DELIVERED');
end $$;

/** It did not happen. The rider still has the parcel. */
create or replace function delivery.fail_delivery(
  p_delivery_id uuid, p_reason_code text, p_note text default null
) returns text
language plpgsql security definer
set search_path = delivery, ops, public, extensions
as $$
begin
  perform delivery.assert_may_execute(p_delivery_id);

  if p_reason_code is null or btrim(p_reason_code) = '' then
    raise exception 'REASON_REQUIRED: say what went wrong, so somebody can act on it'
      using errcode = '23514';
  end if;

  perform delivery.transition(p_delivery_id, 'DELIVERY_FAILED', p_reason_code, p_note);

  update delivery.delivery set failed_reason_code = p_reason_code where id = p_delivery_id;

  insert into delivery.delivery_exception (delivery_id, code, note, raised_by)
  values (p_delivery_id, p_reason_code, p_note, ops.current_actor_id());

  perform ops.audit('delivery.failed', 'delivery', p_delivery_id::text, null,
    jsonb_build_object('reason', p_reason_code), p_note);

  return 'DELIVERY_FAILED';
end $$;

-- ─────────────── rider location ───────────────

/**
 * A position ping.
 *
 * Accepted ONLY between PICKED_UP and a terminal state. Outside that
 * window it is refused, not quietly dropped — the difference matters
 * when somebody later asks what we collected and when.
 *
 * Tracking a named worker's movements is not something to do by
 * default, so the window is a rule in the database rather than a
 * convention in a client.
 */
create or replace function fleet.record_location(
  p_delivery_id uuid, p_lat numeric, p_lng numeric, p_accuracy numeric default null
) returns void
language plpgsql security definer
set search_path = fleet, delivery, ops, public, extensions
as $$
declare d delivery.delivery%rowtype; v_rider uuid;
begin
  perform delivery.assert_may_execute(p_delivery_id);

  select * into d from delivery.delivery where id = p_delivery_id;

  if d.status not in ('PICKED_UP','OUT_FOR_DELIVERY','ARRIVED') then
    raise exception
      'LOCATION_NOT_ACCEPTED: a position is only recorded while carrying a parcel (this is %)',
      d.status using errcode = '23514';
  end if;

  select a.rider_id into v_rider from fleet.assignment a
   where a.delivery_id = p_delivery_id and a.status in ('OFFERED','ACCEPTED');

  if v_rider is null then
    raise exception 'NO_LIVE_ASSIGNMENT: nobody is carrying this' using errcode = 'P0002';
  end if;

  insert into fleet.rider_location (rider_id, delivery_id, lat, lng, accuracy_m)
  values (v_rider, p_delivery_id, p_lat, p_lng, p_accuracy);
end $$;

-- ─────────────── permissions ───────────────

insert into identity.role_permission (role, permission) values
  ('rider',      'deliveries:execute'),
  ('admin',      'proof:read'),
  ('dispatcher', 'proof:read')
on conflict do nothing;

-- ─────────────── row-level security ───────────────

alter table delivery.delivery_otp       enable row level security;
alter table delivery.delivery_proof     enable row level security;
alter table delivery.delivery_exception enable row level security;
alter table fleet.rider_location        enable row level security;
alter table integration.outbound_event  enable row level security;

-- Nobody SELECTs the OTP table. The hash is useless and the columns
-- around it leak timing; issue_otp and verify_otp are the only paths.
create policy otp_none on delivery.delivery_otp for select using (false);

create policy proof_read on delivery.delivery_proof
  for select using (identity.has_permission('proof:read'));

create policy exception_read on delivery.delivery_exception
  for select using (identity.has_permission('deliveries:read'));

-- A rider may see the trail of the parcel they are carrying, and
-- nobody else's movements.
create policy rider_location_read on fleet.rider_location
  for select using (
    identity.has_permission('deliveries:read')
    or fleet.is_my_assignment(delivery_id));

create policy outbound_read on integration.outbound_event
  for select using (identity.has_permission('integration:read'));

-- ─────────────── grants ───────────────

grant select, insert, update on all tables in schema delivery to authenticated;
grant select, insert, update on all tables in schema fleet to authenticated;
grant select, insert, update on all tables in schema integration to authenticated;
grant usage on all sequences in schema delivery, fleet, integration to authenticated;
grant execute on all functions in schema delivery to authenticated;
grant execute on all functions in schema fleet to authenticated;
grant execute on all functions in schema integration to authenticated;

-- The OTP hash is not readable even with a policy mistake later.
revoke all on delivery.delivery_otp from authenticated;

-- mint_otp RETURNS the plaintext code, so it must be callable only by
-- the definer functions above — never by the rider standing at the
-- door, which would defeat the entire proof.
--
-- BOTH revokes are required, and the second is the one that matters.
-- Postgres grants EXECUTE on every new function to PUBLIC by default,
-- so revoking from `authenticated` alone leaves it wide open through
-- the public grant. The first version of this did exactly that: a
-- rider calling mint_otp got past the privilege check and failed on a
-- foreign key instead, which looks like a refusal and is not one.
revoke all on function delivery.mint_otp(uuid, integer) from public;
revoke all on function delivery.mint_otp(uuid, integer) from authenticated;

-- Same reasoning for the queue internals: draining is an operator
-- action, and the role checks inside are a second line, not the first.
revoke all on function integration.claim_outbound_batch(integer, text) from public;
revoke all on function integration.record_outbound_result(bigint, boolean, text, jsonb, boolean) from public;
