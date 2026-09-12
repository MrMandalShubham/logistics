-- ============================================================
-- 0007 - The fleet: riders, availability, and assignment
--
-- Until now the queue dead-ended. A delivery could be admitted and
-- then nothing: ASSIGNED and ACCEPTED were declared in the enum and
-- unreachable. This is the phase where a parcel becomes somebody's
-- job.
--
-- ── Identity and profile are separate on purpose ──
--
-- identity.app_user holds the login (created in 0002, role 'rider').
-- fleet.rider holds the operational profile. One row each, joined.
--
-- The split means a rider who leaves keeps an auditable identity on
-- every delivery they ever made, while losing all access the same
-- day. Merging them would force a choice between deleting history and
-- leaving a live account behind.
--
-- ── Reassignment inserts, it does not edit ──
--
-- Moving a delivery to another rider creates a NEW assignment row and
-- marks the old one SUPERSEDED. "Who was asked first, and what did
-- they say" is precisely the question a complaint turns on, and an
-- UPDATE to rider_id would erase it.
-- ============================================================

create schema if not exists fleet;

-- ─────────────── riders ───────────────

create table fleet.rider (
  id      uuid primary key default gen_random_uuid(),

  -- The login. One profile per user, enforced.
  user_id uuid not null unique references identity.app_user(id),

  code         text not null unique,        -- RDR-001: readable on a roster
  display_name text not null,
  phone        text not null,

  vehicle_type text not null default 'BIKE'
                 check (vehicle_type in ('BIKE','SCOOTER','CYCLE','VAN','FOOT')),

  home_location_code text references integration.location_ref(code),

  status text not null default 'ACTIVE'
           check (status in ('ACTIVE','SUSPENDED','OFFBOARDED')),

  -- One parcel, one rider, by default. A cheap guard against handing
  -- somebody ten by accident. Batching as a feature is a later phase;
  -- raising this number is not the same thing and is not enough.
  max_concurrent integer not null default 1 check (max_concurrent between 1 and 10),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index rider_active on fleet.rider (status) where status = 'ACTIVE';

-- ─────────────── availability ───────────────
--
-- A log, not a boolean on the rider row.
--
-- "Is this rider online" is the easy question. "When did they go
-- offline, and who did it" is the one asked when a shift's numbers
-- look wrong, and a single column cannot answer it.

create table fleet.rider_availability (
  id          bigint generated always as identity primary key,
  rider_id    uuid not null references fleet.rider(id) on delete cascade,
  is_online   boolean not null,
  reason      text,
  -- Null when the rider did it themselves.
  changed_by  uuid,
  occurred_at timestamptz not null default now()
);

create index rider_availability_latest
  on fleet.rider_availability (rider_id, occurred_at desc, id desc);

-- ─────────────── assignment ───────────────

create table fleet.assignment (
  id          uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references delivery.delivery(id) on delete cascade,
  rider_id    uuid not null references fleet.rider(id),

  status text not null default 'OFFERED' check (status in (
    'OFFERED',     -- waiting for the rider to answer
    'ACCEPTED',    -- theirs
    'DECLINED',    -- they said no
    'EXPIRED',     -- they never answered
    'SUPERSEDED',  -- a dispatcher moved it to somebody else
    'COMPLETED')), -- the delivery reached a terminal state (Phase 4)

  assigned_by uuid not null,
  assigned_at timestamptz not null default now(),

  -- An offer nobody answers must not hold a parcel forever.
  expires_at timestamptz not null,

  responded_at   timestamptz,
  decline_reason text,

  -- Which assignment replaced this one.
  superseded_by uuid references fleet.assignment(id),

  created_at timestamptz not null default now()
);

/**
 * At most ONE live offer per delivery.
 *
 * The load-bearing line in this migration. Two dispatchers clicking
 * Assign on the same delivery in the same second produce one winner
 * and one clean conflict — rather than two riders at one door, which
 * is not a bug you can apologise your way out of.
 */
create unique index assignment_one_live
  on fleet.assignment (delivery_id)
  where status in ('OFFERED','ACCEPTED');

create index assignment_rider on fleet.assignment (rider_id, status);
create index assignment_due   on fleet.assignment (expires_at) where status = 'OFFERED';

-- ─────────────── the current picture ───────────────

create view fleet.rider_current as
  select r.*,
         coalesce((select a.is_online
                     from fleet.rider_availability a
                    where a.rider_id = r.id
                    order by a.occurred_at desc, a.id desc
                    limit 1), false) as is_online,
         (select count(*)::int
            from fleet.assignment x
           where x.rider_id = r.id
             and x.status in ('OFFERED','ACCEPTED')) as active_count
    from fleet.rider r;

comment on view fleet.rider_current is
  'Riders with their latest availability and current load. Read this, not the tables.';

-- ─────────────── helpers ───────────────

/**
 * Is this delivery offered to, or held by, the caller?
 *
 * A definer function rather than an inline subquery, because it is
 * used inside a row-level-security policy on delivery.delivery where
 * an unqualified `id` would resolve ambiguously and silently.
 */
create or replace function fleet.is_my_assignment(p_delivery_id uuid)
returns boolean
language sql stable security definer
set search_path = fleet, ops, public, extensions
as $$
  select exists (
    select 1
      from fleet.assignment a
      join fleet.rider r on r.id = a.rider_id
     where a.delivery_id = p_delivery_id
       and a.status in ('OFFERED','ACCEPTED')
       and r.user_id = ops.current_actor_id());
$$;

/** Why a rider cannot be given work right now, or null if they can. */
create or replace function fleet.unavailable_reason(p_rider_id uuid)
returns text
language plpgsql stable security definer
set search_path = fleet, public, extensions
as $$
declare c record;
begin
  select * into c from fleet.rider_current where id = p_rider_id;

  if c.id is null       then return 'no such rider'; end if;
  if c.status <> 'ACTIVE' then return lower(c.status); end if;
  if not c.is_online    then return 'offline'; end if;
  if c.active_count >= c.max_concurrent then
    return format('at capacity (%s of %s)', c.active_count, c.max_concurrent);
  end if;
  return null;
end $$;

-- ─────────────── the widened state machine ───────────────

/**
 * REPLACES the Phase 2 version. There is one of these, not two.
 *
 * ASSIGNED -> READY_FOR_ASSIGNMENT covers three different things —
 * declined, expired, and taken back by a dispatcher — each told apart
 * by its reason_code on the timeline rather than by a separate state.
 */
create or replace function delivery.allowed_next(p_from text) returns text[]
language sql immutable as $$
  select case p_from
    when 'RECEIVED'             then array['READY_FOR_ASSIGNMENT','CANCELLED']
    when 'READY_FOR_ASSIGNMENT' then array['ASSIGNED','CANCELLED']
    when 'ASSIGNED'             then array['ACCEPTED','READY_FOR_ASSIGNMENT','CANCELLED']
    -- Phase 4 adds PICKUP_PENDING here.
    when 'ACCEPTED'             then array['READY_FOR_ASSIGNMENT','CANCELLED']
    else array[]::text[]
  end;
$$;

-- ─────────────── creating a rider ───────────────

/**
 * Create a rider: a login AND a profile, in one transaction.
 *
 * A profile with no login cannot sign in; a login with no profile
 * cannot be dispatched. Neither is a state this system should be able
 * to reach, so neither is created alone.
 *
 * The password hash is computed by the caller (scrypt lives in Node),
 * exactly as identity.create_user does.
 */
create or replace function fleet.create_rider(
  p_email        citext,
  p_display_name text,
  p_phone        text,
  p_password_hash text,
  p_code         text default null,
  p_vehicle_type text default 'BIKE',
  p_home_location text default null,
  p_max_concurrent integer default 1
) returns table (rider_id uuid, user_id uuid, code text)
language plpgsql security definer
set search_path = fleet, identity, ops, public, extensions
as $$
declare
  v_user  uuid;
  v_rider uuid;
  v_code  text;
begin
  if not identity.has_permission('riders:write')
     and ops.current_role_name() <> 'system' then
    raise exception 'FORBIDDEN: creating a rider requires riders:write'
      using errcode = '42501';
  end if;

  v_user := identity.create_user(
    p_email, p_display_name, 'rider', p_password_hash,
    case when p_home_location is null then '{}'::text[] else array[p_home_location] end,
    true);

  v_code := coalesce(nullif(btrim(p_code), ''),
    'RDR-' || lpad(((select count(*) from fleet.rider) + 1)::text, 3, '0'));

  insert into fleet.rider
    (user_id, code, display_name, phone, vehicle_type, home_location_code, max_concurrent)
  values
    (v_user, v_code, p_display_name, p_phone, p_vehicle_type, p_home_location, p_max_concurrent)
  returning id into v_rider;

  -- Riders start OFFLINE. Somebody who has not said they are working
  -- is not working.
  insert into fleet.rider_availability (rider_id, is_online, reason, changed_by)
  values (v_rider, false, 'created', ops.current_actor_id());

  perform ops.audit('rider.created', 'rider', v_rider::text, null,
    jsonb_build_object('code', v_code, 'email', p_email, 'vehicle', p_vehicle_type));

  rider_id := v_rider; user_id := v_user; code := v_code;
  return next;
end $$;

/** Suspend, reactivate or offboard. Offboarding also disables the login. */
create or replace function fleet.set_rider_status(p_rider_id uuid, p_status text, p_reason text default null)
returns void
language plpgsql security definer
set search_path = fleet, identity, ops, public, extensions
as $$
declare r fleet.rider%rowtype;
begin
  if not identity.has_permission('riders:write')
     and ops.current_role_name() <> 'system' then
    raise exception 'FORBIDDEN: changing a rider requires riders:write'
      using errcode = '42501';
  end if;

  select * into r from fleet.rider where id = p_rider_id;
  if r.id is null then
    raise exception 'NO_SUCH_RIDER: %', p_rider_id using errcode = 'P0002';
  end if;

  update fleet.rider set status = p_status, updated_at = now() where id = p_rider_id;

  -- A rider who is not working cannot be shown as available.
  if p_status <> 'ACTIVE' then
    insert into fleet.rider_availability (rider_id, is_online, reason, changed_by)
    values (p_rider_id, false, lower(p_status), ops.current_actor_id());
  end if;

  -- Offboarding must close the door, not just the roster.
  if p_status = 'OFFBOARDED' then
    update identity.app_user set status = 'DISABLED', updated_at = now()
     where id = r.user_id;
  end if;

  perform ops.audit(
    case p_status when 'ACTIVE' then 'rider.reactivated'
                  when 'SUSPENDED' then 'rider.suspended'
                  else 'rider.offboarded' end,
    'rider', p_rider_id::text,
    jsonb_build_object('status', r.status),
    jsonb_build_object('status', p_status), p_reason);
end $$;

-- ─────────────── availability ───────────────

create or replace function fleet.set_availability(
  p_rider_id uuid, p_online boolean, p_reason text default null
) returns void
language plpgsql security definer
set search_path = fleet, identity, ops, public, extensions
as $$
declare r fleet.rider%rowtype; v_self boolean;
begin
  select * into r from fleet.rider where id = p_rider_id;
  if r.id is null then
    raise exception 'NO_SUCH_RIDER: %', p_rider_id using errcode = 'P0002';
  end if;

  v_self := r.user_id = ops.current_actor_id();

  -- A rider may toggle themselves; anyone else needs the permission.
  if not v_self
     and not identity.has_permission('riders:availability')
     and ops.current_role_name() <> 'system' then
    raise exception 'FORBIDDEN: you may only change your own availability'
      using errcode = '42501';
  end if;

  if p_online and r.status <> 'ACTIVE' then
    raise exception 'RIDER_NOT_ACTIVE: a % rider cannot go online', lower(r.status)
      using errcode = '23514';
  end if;

  insert into fleet.rider_availability (rider_id, is_online, reason, changed_by)
  values (p_rider_id, p_online, p_reason, case when v_self then null else ops.current_actor_id() end);

  perform ops.audit(
    case when p_online then 'rider.went_online' else 'rider.went_offline' end,
    'rider', p_rider_id::text, null, null, p_reason);
end $$;

-- ─────────────── assignment ───────────────

/**
 * Offer a delivery to a rider.
 *
 * Three guards, because one would not be enough:
 *
 *   1. delivery.transition takes FOR UPDATE on the delivery row
 *   2. the partial unique index refuses a second live assignment
 *   3. the rider must actually be available
 *
 * Two dispatchers racing produce one assignment and one 23505, which
 * the route turns into a 409 naming the winner.
 */
create or replace function fleet.assign_delivery(
  p_delivery_id uuid,
  p_rider_id    uuid,
  p_expires_seconds integer default 120
) returns uuid
language plpgsql security definer
set search_path = fleet, delivery, identity, ops, public, extensions
as $$
declare
  v_reason text;
  v_id     uuid;
  r        fleet.rider%rowtype;
begin
  if not identity.has_permission('deliveries:assign')
     and ops.current_role_name() <> 'system' then
    raise exception 'FORBIDDEN: assigning requires deliveries:assign'
      using errcode = '42501';
  end if;

  v_reason := fleet.unavailable_reason(p_rider_id);
  if v_reason is not null then
    raise exception 'RIDER_UNAVAILABLE: % is %',
      coalesce((select code from fleet.rider where id = p_rider_id), 'that rider'), v_reason
      using errcode = '23514';
  end if;

  select * into r from fleet.rider where id = p_rider_id;

  -- Moves the delivery and writes the timeline row. Refuses if the
  -- delivery is not in a state that can be assigned, and takes the
  -- row lock that makes the race below resolvable.
  perform delivery.transition(p_delivery_id, 'ASSIGNED', 'assigned', 'to ' || r.code);

  insert into fleet.assignment
    (delivery_id, rider_id, assigned_by, expires_at)
  values
    (p_delivery_id, p_rider_id, ops.current_actor_id(),
     now() + make_interval(secs => greatest(p_expires_seconds, 30)))
  returning id into v_id;

  perform ops.audit('delivery.assigned', 'delivery', p_delivery_id::text, null,
    jsonb_build_object('rider', r.code, 'assignment_id', v_id));

  return v_id;
end $$;

/**
 * The rider answers.
 *
 * ── The check that matters ──
 *
 * Holding `deliveries:respond` says "you are a rider". It must not
 * say "you may accept THIS". Ownership is verified here, in the
 * database, so no route can forget it.
 */
create or replace function fleet.respond_to_assignment(
  p_delivery_id uuid,
  p_accept      boolean,
  p_reason      text default null
) returns text
language plpgsql security definer
set search_path = fleet, delivery, identity, ops, public, extensions
as $$
declare
  a fleet.assignment%rowtype;
  r fleet.rider%rowtype;
begin
  select * into a from fleet.assignment
   where delivery_id = p_delivery_id and status = 'OFFERED'
   for update;

  if a.id is null then
    raise exception 'NO_LIVE_OFFER: there is no open offer for this delivery'
      using errcode = 'P0002';
  end if;

  select * into r from fleet.rider where id = a.rider_id;

  -- A rider may answer only their own offer. Staff acting on a
  -- rider's behalf need the assign permission.
  if ops.current_role_name() = 'rider' then
    if r.user_id is distinct from ops.current_actor_id() then
      raise exception 'NOT_YOUR_ASSIGNMENT: this delivery is not offered to you'
        using errcode = '42501';
    end if;
  elsif not identity.has_permission('deliveries:assign')
        and ops.current_role_name() <> 'system' then
    raise exception 'FORBIDDEN: answering for a rider requires deliveries:assign'
      using errcode = '42501';
  end if;

  if a.expires_at <= now() then
    raise exception 'OFFER_EXPIRED: that offer lapsed at %',
      to_char(a.expires_at, 'HH24:MI:SS') using errcode = '23514';
  end if;

  -- Suspended between being offered the job and answering it.
  if r.status <> 'ACTIVE' then
    raise exception 'RIDER_NOT_ACTIVE: a % rider cannot accept work', lower(r.status)
      using errcode = '23514';
  end if;

  if p_accept then
    update fleet.assignment
       set status = 'ACCEPTED', responded_at = now()
     where id = a.id;

    perform delivery.transition(p_delivery_id, 'ACCEPTED', 'accepted', r.code);
    perform ops.audit('delivery.accepted', 'delivery', p_delivery_id::text, null,
      jsonb_build_object('rider', r.code));
    return 'ACCEPTED';
  end if;

  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'REASON_REQUIRED: say why, so dispatch can act on it'
      using errcode = '23514';
  end if;

  update fleet.assignment
     set status = 'DECLINED', responded_at = now(), decline_reason = p_reason
   where id = a.id;

  perform delivery.transition(
    p_delivery_id, 'READY_FOR_ASSIGNMENT', 'declined', r.code || ': ' || p_reason);
  perform ops.audit('delivery.declined', 'delivery', p_delivery_id::text, null,
    jsonb_build_object('rider', r.code), p_reason);

  return 'DECLINED';
end $$;

/**
 * Move a delivery to a different rider.
 *
 * Works from ASSIGNED and from ACCEPTED — a rider whose bike has
 * broken down should not strand a parcel.
 *
 * The delivery passes back through READY_FOR_ASSIGNMENT rather than
 * jumping rider to rider, so the timeline shows what actually
 * happened: taken back, then given to somebody else.
 */
create or replace function fleet.reassign_delivery(
  p_delivery_id uuid,
  p_new_rider   uuid,
  p_reason      text
) returns uuid
language plpgsql security definer
set search_path = fleet, delivery, identity, ops, public, extensions
as $$
declare
  a     fleet.assignment%rowtype;
  v_new uuid;
begin
  if not identity.has_permission('deliveries:assign')
     and ops.current_role_name() <> 'system' then
    raise exception 'FORBIDDEN: reassigning requires deliveries:assign'
      using errcode = '42501';
  end if;

  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'REASON_REQUIRED: a reassignment without one cannot be explained later'
      using errcode = '23514';
  end if;

  select * into a from fleet.assignment
   where delivery_id = p_delivery_id and status in ('OFFERED','ACCEPTED')
   for update;

  if a.id is null then
    raise exception 'NO_LIVE_OFFER: this delivery is not assigned to anybody'
      using errcode = 'P0002';
  end if;

  if a.rider_id = p_new_rider then
    raise exception 'SAME_RIDER: that delivery is already with them'
      using errcode = '23514';
  end if;

  -- Superseded, never overwritten. The first rider asked is part of
  -- the record.
  update fleet.assignment
     set status = 'SUPERSEDED', responded_at = now(), decline_reason = p_reason
   where id = a.id;

  perform delivery.transition(
    p_delivery_id, 'READY_FOR_ASSIGNMENT', 'reassigned', p_reason);

  v_new := fleet.assign_delivery(p_delivery_id, p_new_rider);

  update fleet.assignment set superseded_by = v_new where id = a.id;

  perform ops.audit('delivery.reassigned', 'delivery', p_delivery_id::text,
    jsonb_build_object('from_assignment', a.id),
    jsonb_build_object('to_assignment', v_new), p_reason);

  return v_new;
end $$;

/**
 * Which offers are about to be swept, without sweeping them.
 *
 * A definer function rather than a query in the script, and that is
 * the whole point: `expire_assignments` is SECURITY DEFINER and sees
 * everything, while a plain SELECT from the script runs under RLS as
 * a role holding no permissions — so it returned an empty list and
 * reported "nothing to do" while the real sweep found work.
 *
 * A dry run that disagrees with the real run is worse than no dry run
 * at all. Both now take the same path.
 */
create or replace function fleet.expiring_assignments()
returns table (
  assignment_id uuid,
  rider_code    text,
  tracking_id   text,
  expires_at    timestamptz
)
language sql stable security definer
set search_path = fleet, delivery, public, extensions
as $$
  select a.id, r.code, d.tracking_id, a.expires_at
    from fleet.assignment a
    join fleet.rider r on r.id = a.rider_id
    join delivery.delivery d on d.id = a.delivery_id
   where a.status = 'OFFERED' and a.expires_at <= now()
   order by a.expires_at;
$$;

/**
 * Return offers nobody answered.
 *
 * Run from a scheduler. Idempotent: an offer already expired, accepted
 * or declined is not touched.
 */
create or replace function fleet.expire_assignments()
returns integer
language plpgsql security definer
set search_path = fleet, delivery, ops, public, extensions
as $$
declare a record; n integer := 0;
begin
  for a in
    select id, delivery_id, rider_id from fleet.assignment
     where status = 'OFFERED' and expires_at <= now()
     order by expires_at
     for update skip locked
  loop
    update fleet.assignment
       set status = 'EXPIRED', responded_at = now()
     where id = a.id;

    perform delivery.transition(
      a.delivery_id, 'READY_FOR_ASSIGNMENT', 'offer_expired',
      (select code from fleet.rider where id = a.rider_id) || ' did not answer');

    perform ops.audit('assignment.expired', 'assignment', a.id::text);
    n := n + 1;
  end loop;

  return n;
end $$;

-- ─────────────── permissions ───────────────

insert into identity.role_permission (role, permission) values
  ('admin',      'riders:read'),
  ('admin',      'riders:write'),
  ('admin',      'riders:availability'),
  ('admin',      'deliveries:assign'),
  ('dispatcher', 'riders:read'),
  ('dispatcher', 'riders:availability'),
  ('dispatcher', 'deliveries:assign'),
  -- A rider's first real permission. It says "you are a rider", NOT
  -- "you may accept this" — ownership is checked separately, above.
  ('rider',      'deliveries:respond')
on conflict do nothing;

-- ─────────────── row-level security ───────────────

alter table fleet.rider              enable row level security;
alter table fleet.rider_availability enable row level security;
alter table fleet.assignment         enable row level security;

-- Staff with the permission see every rider; a rider sees themselves.
create policy rider_read on fleet.rider
  for select using (
    identity.has_permission('riders:read')
    or user_id = ops.current_actor_id());

create policy rider_availability_read on fleet.rider_availability
  for select using (
    identity.has_permission('riders:read')
    or exists (select 1 from fleet.rider r
                where r.id = rider_id and r.user_id = ops.current_actor_id()));

create policy assignment_read on fleet.assignment
  for select using (
    identity.has_permission('deliveries:read')
    or exists (select 1 from fleet.rider r
                where r.id = rider_id and r.user_id = ops.current_actor_id()));

/**
 * A rider may read the delivery they are carrying.
 *
 * Added ALONGSIDE the Phase 2 policy, not instead of it: multiple
 * SELECT policies are OR'd, so staff keep their location-scoped view
 * and a rider gains exactly one delivery — the one they hold.
 *
 * When the assignment ends, so does the access. The address and phone
 * are visible for as long as they are needed to deliver, and no longer.
 */
create policy delivery_read_rider on delivery.delivery
  for select using (fleet.is_my_assignment(id));

-- ─────────────── grants ───────────────
--
-- No DELETE, as everywhere else.

grant usage on schema fleet to authenticated;
grant select, insert, update on all tables in schema fleet to authenticated;
grant select on fleet.rider_current to authenticated;
grant usage on all sequences in schema fleet to authenticated;
grant execute on all functions in schema fleet to authenticated;

alter default privileges in schema fleet
  grant select, insert, update on tables to authenticated;
alter default privileges in schema fleet
  grant execute on functions to authenticated;
