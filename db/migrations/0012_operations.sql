-- ============================================================
-- 0012 — Running by itself, forgetting on time, and saying how it went
--
-- Three things this system has needed since Phase 3 and has been
-- deferring on purpose:
--
--   * Work that nobody schedules. Three jobs, run by hand, one of
--     which was never written at all.
--   * Personal data with no end date.
--   * The twelve numbers §8 of the scope document has promised since
--     Phase 0.
--
-- ── The one that is a defect rather than a gap ──
--
-- Phases 4a and 4b took real care that a rider never learns the
-- customer's code: delivery_otp holds a SHA-256 hash, its SELECT
-- policy is `using (false)`, and mint_otp has EXECUTE revoked from
-- PUBLIC. Then the offline journal wrote the code down in cleartext
-- and kept it forever:
--
--   select payload from integration.rider_event where action='complete';
--    {"otp":"000000"}
--
-- It is not a live credential — by the time the row exists the code
-- is spent, and it expired in fifteen minutes anyway. It is still a
-- customer's one-time code, in cleartext, with no end date, in a
-- table every dispatcher can read. It makes "we never store the
-- code" untrue, and it would have outlived every retention rule
-- below.
-- ============================================================

-- ─────────────── the OTP leaves the journal ───────────────

/**
 * Redact secrets out of a rider event payload.
 *
 * A trigger rather than a change to `apply_rider_event`, for the same
 * reason the notifier and the parcel tracker are triggers: there is
 * one writer today and there will be more, and a rule enforced at the
 * table cannot be forgotten by the next one.
 *
 * The key is KEPT, with its value masked. `{"otp":"******"}` still
 * records that a code was submitted — which matters when somebody
 * later asks whether the rider even tried — while holding nothing
 * worth reading. Deleting the key would lose that.
 */
create or replace function integration.redact_rider_event()
returns trigger
language plpgsql
as $$
begin
  if new.payload ? 'otp' and new.payload ->> 'otp' <> '******' then
    new.payload := jsonb_set(new.payload, '{otp}', '"******"');
  end if;
  return new;
end $$;

create trigger rider_event_redacts_otp
  before insert or update on integration.rider_event
  for each row execute function integration.redact_rider_event();

-- Everything already written. One pass, now.
update integration.rider_event
   set payload = jsonb_set(payload, '{otp}', '"******"')
 where payload ? 'otp' and payload ->> 'otp' <> '******';

comment on function integration.redact_rider_event() is
  'The offline journal records THAT a code was submitted, never which one. delivery_otp holds the hash; nothing holds the plaintext.';

-- ─────────────── Q29: work that runs itself ───────────────

create table ops.job_schedule (
  job              text primary key,
  interval_seconds integer not null check (interval_seconds between 10 and 86400),
  enabled          boolean not null default true,

  -- How stale a last-success may get before the deep health check
  -- calls it a failure. Deliberately separate from the interval: a
  -- job that runs every 30 seconds should not go red because one run
  -- was 31 seconds late.
  stale_after_seconds integer not null check (stale_after_seconds >= 60),

  description text
);

insert into ops.job_schedule (job, interval_seconds, stale_after_seconds, description) values
  ('outbound.drain',      20,   300,
   'Commit to Inventory, push status to Grocery. Nothing else sends these.'),
  ('assignments.expire',  60,   600,
   'Return offers nobody answered. Without it a delivery sits in ASSIGNED looking dispatched.'),
  ('holds.expire',        300,  3600,
   'Flag Inventory holds about to lapse, before a rider is sent to a shop for nothing.'),
  ('retention.purge',     86400, 172800,
   'Forget on schedule. Destroys data on purpose, so it runs once a day and logs what it did.')
on conflict (job) do nothing;

/**
 * One row per run, whatever the outcome.
 *
 * ── Why this is the important half ──
 *
 * A scheduler that silently stops is worse than no scheduler, because
 * everything looks fine. Cron gives you nothing to ask. This table
 * answers "did it run, when, and did it work" — and `ops.job_health`
 * turns that into a check that goes red on its own.
 */
create table ops.job_run (
  id bigint generated always as identity primary key,

  job        text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,

  -- NULL while running. A row that stays NULL is a worker that died
  -- mid-job, which is a different fact from a job that failed.
  ok      boolean,
  detail  text,
  stats   jsonb,
  worker  text
);

create index job_run_recent on ops.job_run (job, started_at desc);
create index job_run_success on ops.job_run (job, finished_at desc)
  where ok is true;

create or replace function ops.job_started(p_job text, p_worker text default 'worker')
returns bigint
language sql security definer
set search_path = ops, public, extensions
as $$
  insert into ops.job_run (job, worker) values (p_job, p_worker) returning id;
$$;

create or replace function ops.job_finished(
  p_run_id bigint, p_ok boolean, p_detail text default null, p_stats jsonb default null
) returns void
language sql security definer
set search_path = ops, public, extensions
as $$
  update ops.job_run
     set finished_at = now(), ok = p_ok, detail = p_detail, stats = p_stats
   where id = p_run_id;
$$;

/**
 * Is the scheduler actually working?
 *
 * `overdue` is the whole point. It is what lets the deep health check
 * say "the drain has not succeeded for 41 minutes" instead of the
 * first sign being a customer ringing about an order that has said
 * "packed" for two days.
 */
create or replace function ops.job_health()
returns table (
  job text, enabled boolean, interval_seconds integer,
  last_success timestamptz, seconds_since integer,
  stale_after_seconds integer, overdue boolean,
  last_outcome boolean, last_detail text, running boolean)
language sql stable security definer
set search_path = ops, public, extensions
as $$
  select
    s.job, s.enabled, s.interval_seconds,
    ok_run.finished_at,
    case when ok_run.finished_at is null then null
         else extract(epoch from now() - ok_run.finished_at)::integer end,
    s.stale_after_seconds,
    -- A job that has NEVER succeeded is overdue the moment it is
    -- enabled. "No data yet" is not the same as "fine".
    s.enabled and (
      ok_run.finished_at is null
      or now() - ok_run.finished_at > make_interval(secs => s.stale_after_seconds)),
    last_run.ok, last_run.detail,
    exists (select 1 from ops.job_run r
             where r.job = s.job and r.finished_at is null
               and r.started_at > now() - interval '1 hour')
  from ops.job_schedule s
  left join lateral (
    select finished_at from ops.job_run r
     where r.job = s.job and r.ok is true
     order by r.finished_at desc limit 1) ok_run on true
  left join lateral (
    select ok, detail from ops.job_run r
     where r.job = s.job and r.finished_at is not null
     order by r.finished_at desc limit 1) last_run on true
  order by s.job;
$$;

/** Holds about to lapse — the job that was never written. */
create or replace function delivery.expiring_holds(p_within_minutes integer default 10)
returns table (
  delivery_id uuid, tracking_id text, status text, external_order_id text,
  location_code text, hold_expires_at timestamptz, minutes_left integer)
language sql stable security definer
set search_path = delivery, identity, ops, public, extensions
as $$
  select d.id, d.tracking_id, d.status, d.external_order_id,
         d.pickup_location_code, d.hold_expires_at,
         (extract(epoch from d.hold_expires_at - now()) / 60)::integer
    from delivery.delivery d
   where d.hold_status = 'held'
     and not d.hold_confirmed
     and d.hold_expires_at is not null
     and d.hold_expires_at < now() + make_interval(mins => p_within_minutes)
     -- Once the parcel is in a bag the hold no longer matters: the
     -- goods have physically left the shelf.
     and d.status in ('RECEIVED','READY_FOR_ASSIGNMENT','ASSIGNED','ACCEPTED','PICKUP_PENDING')
   order by d.hold_expires_at;
$$;

/** Raise one exception per lapsing hold, once. */
create or replace function delivery.flag_expiring_holds(p_within_minutes integer default 10)
returns integer
language plpgsql security definer
set search_path = delivery, identity, ops, public, extensions
as $$
declare r record; v_n integer := 0;
begin
  for r in select * from delivery.expiring_holds(p_within_minutes) loop
    -- Once per delivery. A job running every five minutes must not
    -- produce twelve identical rows an hour.
    if not exists (select 1 from delivery.delivery_exception x
                    where x.delivery_id = r.delivery_id
                      and x.code = 'HOLD_EXPIRING' and x.resolved_at is null) then
      insert into delivery.delivery_exception (delivery_id, code, severity, note)
      values (r.delivery_id, 'HOLD_EXPIRING', 'WARNING',
        format('The inventory hold for %s lapses in %s minutes and cannot be confirmed (Q4). '
               || 'A rider sent to %s may find nothing set aside.',
               r.external_order_id, r.minutes_left, r.location_code));
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end $$;

-- ─────────────── Q12: forgetting on schedule ───────────────

/**
 * What retention WOULD do. Counts only, changes nothing.
 *
 * A retention job is the one piece of scheduled work that destroys
 * data on purpose. It should be boring to inspect before it is
 * trusted, and inspectable afterwards without reading the code.
 */
create or replace function ops.retention_preview(
  p_location_days integer default 30,
  p_proof_days    integer default 90,
  p_pii_days      integer default 180
) returns table (target text, rows_affected bigint, rule text)
language sql stable security definer
set search_path = ops, delivery, fleet, integration, public, extensions
as $$
  select 'fleet.rider_location', count(*)::bigint,
         format('delete older than %s days', p_location_days)
    from fleet.rider_location
   where recorded_at < now() - make_interval(days => p_location_days)
  union all
  select 'delivery.delivery_proof', count(*)::bigint,
         format('delete older than %s days', p_proof_days)
    from delivery.delivery_proof
   where captured_at < now() - make_interval(days => p_proof_days)
  union all
  select 'delivery.delivery_address', count(*)::bigint,
         format('anonymise %s days after a terminal state', p_pii_days)
    from delivery.delivery_address a
    join delivery.delivery d on d.id = a.delivery_id
   where d.status in ('DELIVERED','RETURNED','CANCELLED')
     and d.updated_at < now() - make_interval(days => p_pii_days)
     and a.recipient_name is distinct from '[redacted]'
  union all
  select 'integration.inbound_event', count(*)::bigint,
         format('redact payload after %s days', p_pii_days)
    from integration.inbound_event
   where received_at < now() - make_interval(days => p_pii_days)
     and payload <> '{"redacted": true}'::jsonb
  union all
  select 'integration.rider_event', count(*)::bigint,
         format('redact payload after %s days', p_pii_days)
    from integration.rider_event
   where received_at < now() - make_interval(days => p_pii_days)
     and payload <> '{"redacted": true}'::jsonb
  union all
  select 'ops.notification', count(*)::bigint,
         format('redact payload after %s days', p_pii_days)
    from ops.notification
   where created_at < now() - make_interval(days => p_pii_days)
     and payload <> '{"redacted": true}'::jsonb
  union all
  select 'ops.audit_log', count(*)::bigint,
         format('redact named PII keys after %s days', p_pii_days)
    from ops.audit_log
   where occurred_at < now() - make_interval(days => p_pii_days)
     and (before ?| array['address','delivery_address','recipient_name','phone']
       or after  ?| array['address','delivery_address','recipient_name','phone']);
$$;

/**
 * Forget.
 *
 * ── Anonymise, do not delete ──
 *
 * Deleting delivery_address would break every report that joins to it
 * and every question of the form "which pincodes fail most often".
 * Worse, it loses the fact that the delivery HAD an address, which is
 * the difference between "personal data was removed on schedule" and
 * "this record is broken".
 *
 * So the name, phone, street and instructions go; the pincode, the
 * city and a coarsened geocode stay. The person is gone and the
 * operational history is not.
 *
 * The coordinates are rounded to two decimal places — roughly a
 * kilometre — which is a neighbourhood rather than a doorstep.
 */
create or replace function ops.retention_purge(
  p_location_days integer default 30,
  p_proof_days    integer default 90,
  p_pii_days      integer default 180
) returns jsonb
language plpgsql security definer
set search_path = ops, delivery, fleet, integration, public, extensions
as $$
declare
  v jsonb := '{}'::jsonb;
  n integer;
begin
  delete from fleet.rider_location
   where recorded_at < now() - make_interval(days => p_location_days);
  get diagnostics n = row_count;
  v := v || jsonb_build_object('rider_location_deleted', n);

  delete from delivery.delivery_proof
   where captured_at < now() - make_interval(days => p_proof_days);
  get diagnostics n = row_count;
  v := v || jsonb_build_object('proof_deleted', n);

  -- recipient_name, phone, line1, city, pincode, lat and lng are all
  -- NOT NULL: 0005 made them so because a delivery with half an
  -- address is not a state this system may be in, even briefly. So
  -- the personal ones are OVERWRITTEN rather than nulled — blanking
  -- them would fail the constraint and take the whole purge with it.
  update delivery.delivery_address a
     set recipient_name = '[redacted]',
         phone          = '[redacted]',
         line1          = '[redacted]',
         line2          = null,
         instructions   = null,
         lat            = round(a.lat, 2),
         lng            = round(a.lng, 2)
    from delivery.delivery d
   where d.id = a.delivery_id
     and d.status in ('DELIVERED','RETURNED','CANCELLED')
     and d.updated_at < now() - make_interval(days => p_pii_days)
     and a.recipient_name is distinct from '[redacted]';
  get diagnostics n = row_count;
  v := v || jsonb_build_object('addresses_anonymised', n);

  -- What was bought is personal. The SKU and the count are not.
  update delivery.delivery_item i
     set name = '[redacted]'
    from delivery.delivery d
   where d.id = i.delivery_id
     and d.status in ('DELIVERED','RETURNED','CANCELLED')
     and d.updated_at < now() - make_interval(days => p_pii_days)
     and i.name is distinct from '[redacted]';
  get diagnostics n = row_count;
  v := v || jsonb_build_object('items_anonymised', n);

  -- The raw payloads. A replay needs them; after six months nothing
  -- is going to be replayed, and they hold the whole order.
  update integration.inbound_event set payload = '{"redacted": true}'::jsonb
   where received_at < now() - make_interval(days => p_pii_days)
     and payload <> '{"redacted": true}'::jsonb;
  get diagnostics n = row_count;
  v := v || jsonb_build_object('inbound_redacted', n);

  update integration.rider_event set payload = '{"redacted": true}'::jsonb
   where received_at < now() - make_interval(days => p_pii_days)
     and payload <> '{"redacted": true}'::jsonb;
  get diagnostics n = row_count;
  v := v || jsonb_build_object('rider_events_redacted', n);

  update ops.notification set payload = '{"redacted": true}'::jsonb
   where created_at < now() - make_interval(days => p_pii_days)
     and payload <> '{"redacted": true}'::jsonb;
  get diagnostics n = row_count;
  v := v || jsonb_build_object('notifications_redacted', n);

  v := v || jsonb_build_object('audit_keys_redacted',
                               ops.redact_audit_pii(p_pii_days));

  return v;
end $$;

/**
 * The narrow hole in the append-only log, and why it is this shape.
 *
 * ops.audit_log has refuse_mutation triggers on UPDATE **and** DELETE,
 * which is exactly what makes it worth trusting. Two kinds of row —
 * ingest, and address changes — carry a customer's name, phone and
 * street inside their before/after JSON, and a 180-day rule has to
 * reach them somehow.
 *
 * What this does NOT do:
 *   * delete a row
 *   * change action, actor, entity, timestamp or reason
 *   * touch anything newer than the window
 *   * open the table to anything else — the trigger is disabled for
 *     the duration of this statement and this statement only, inside
 *     one transaction, by a definer function nothing else calls.
 *
 * What it does: replace four named keys with '[redacted]'.
 *
 * This is a deliberate exception to an invariant, so it is written
 * down here rather than discovered later. Every run is itself audited.
 */
create or replace function ops.redact_audit_pii(p_pii_days integer default 180)
returns integer
language plpgsql security definer
set search_path = ops, public, extensions
as $$
declare
  v_n  integer := 0;
  v_it integer;
  k    text;
  keys text[] := array['address','delivery_address','recipient_name','phone'];
begin
  alter table ops.audit_log disable trigger audit_log_no_update;

  begin
    foreach k in array keys loop
      update ops.audit_log
         set before = case when before ? k then jsonb_set(before, array[k], '"[redacted]"') else before end,
             after  = case when after  ? k then jsonb_set(after,  array[k], '"[redacted]"') else after  end
       where occurred_at < now() - make_interval(days => p_pii_days)
         and (before ? k or after ? k)
         and coalesce(before ->> k, after ->> k) is distinct from '[redacted]';
      get diagnostics v_it = row_count;
      v_n := v_n + v_it;
    end loop;
  exception when others then
    alter table ops.audit_log enable trigger audit_log_no_update;
    raise;
  end;

  alter table ops.audit_log enable trigger audit_log_no_update;

  if v_n > 0 then
    perform ops.audit('retention.audit_redacted', 'audit_log', null, null,
      jsonb_build_object('rows', v_n, 'keys', keys, 'older_than_days', p_pii_days),
      'scheduled retention');
  end if;

  return v_n;
end $$;

-- ─────────────── reports (scope §8) ───────────────

/**
 * AC-18. The only report here that tells you about a problem nobody
 * has reported yet.
 */
create or replace function delivery.stuck_deliveries(p_minutes integer default 60)
returns table (
  delivery_id uuid, tracking_id text, status text, location_code text,
  last_moved_at timestamptz, stuck_minutes integer, rider text)
language sql stable security definer
set search_path = delivery, fleet, identity, ops, public, extensions
as $$
  select d.id, d.tracking_id, d.status, d.pickup_location_code,
         h.last_at, (extract(epoch from now() - h.last_at) / 60)::integer,
         r.display_name
    from delivery.delivery d
    join lateral (select max(occurred_at) as last_at
                    from delivery.delivery_status_history s
                   where s.delivery_id = d.id) h on true
    left join fleet.rider r on r.id = d.parcel_with_rider_id
   where identity.has_permission('reports:read')
     and d.status not in ('DELIVERED','RETURNED','CANCELLED')
     and h.last_at < now() - make_interval(mins => p_minutes)
     and ops.can_access_location(d.pickup_location_code)
   order by h.last_at;
$$;

/** Where everything is, right now. */
create or replace function delivery.status_funnel(p_since timestamptz default null)
returns table (status text, n bigint)
language sql stable security definer
set search_path = delivery, identity, ops, public, extensions
as $$
  select d.status, count(*)::bigint
    from delivery.delivery d
   where identity.has_permission('reports:read')
     and (p_since is null or d.created_at >= p_since)
     and ops.can_access_location(d.pickup_location_code)
   group by d.status
   order by count(*) desc;
$$;

/**
 * The latencies from scope §8, computed from the timeline.
 *
 * From delivery_status_history, which is insert-only and enforced so,
 * which means these numbers cannot drift from what happened.
 */
create or replace function delivery.latency_percentiles(p_since timestamptz default null)
returns table (metric text, n bigint, p50_minutes numeric, p90_minutes numeric, target text)
language sql stable security definer
set search_path = delivery, identity, ops, public, extensions
as $$
  with reached as (
    select s.delivery_id, s.to_status, min(s.occurred_at) as at
      from delivery.delivery_status_history s
      join delivery.delivery d on d.id = s.delivery_id
     where identity.has_permission('reports:read')
       and (p_since is null or d.created_at >= p_since)
       and ops.can_access_location(d.pickup_location_code)
     group by s.delivery_id, s.to_status
  ),
  spans as (
    select 'assignment latency' as metric, 'p90 < 10 min' as target,
           a.delivery_id, extract(epoch from b.at - a.at) / 60 as minutes
      from reached a join reached b
        on b.delivery_id = a.delivery_id and a.to_status = 'RECEIVED' and b.to_status = 'ASSIGNED'
    union all
    select 'pickup latency', 'p90 < 20 min',
           a.delivery_id, extract(epoch from b.at - a.at) / 60
      from reached a join reached b
        on b.delivery_id = a.delivery_id and a.to_status = 'ASSIGNED' and b.to_status = 'PICKED_UP'
    union all
    select 'delivery duration', 'p90 < 45 min',
           a.delivery_id, extract(epoch from b.at - a.at) / 60
      from reached a join reached b
        on b.delivery_id = a.delivery_id and a.to_status = 'PICKED_UP' and b.to_status = 'DELIVERED'
  )
  select metric, count(*)::bigint,
         round(percentile_cont(0.5) within group (order by minutes)::numeric, 1),
         round(percentile_cont(0.9) within group (order by minutes)::numeric, 1),
         target
    from spans
   group by metric, target
   order by metric;
$$;

/** Why deliveries fail, and how often they come back. */
create or replace function delivery.outcome_rates(p_since timestamptz default null)
returns table (metric text, value text, detail text)
language sql stable security definer
set search_path = delivery, identity, ops, public, extensions
as $$
  with d as (
    select * from delivery.delivery
     where identity.has_permission('reports:read')
       and (p_since is null or created_at >= p_since)
       and ops.can_access_location(pickup_location_code)
  ),
  n as (
    select
      count(*) filter (where status = 'DELIVERED')  as delivered,
      count(*) filter (where status = 'RETURNED')   as returned,
      count(*) filter (where status in ('DELIVERED','RETURNED','CANCELLED')) as terminal,
      (select count(*) from delivery.delivery_status_history s
        join d on d.id = s.delivery_id where s.to_status = 'DELIVERY_FAILED') as failures
    from d
  )
  select 'first-attempt success',
         case when delivered + failures = 0 then 'no data'
              else round(100.0 * delivered / (delivered + failures), 1)::text || ' %' end,
         format('%s delivered, %s failed attempts (target > 95 %%)', delivered, failures)
    from n
  union all
  select 'return rate',
         case when delivered = 0 then 'no data'
              else round(100.0 * returned / greatest(delivered, 1), 1)::text || ' %' end,
         format('%s returned (target < 2 %%)', returned)
    from n
  union all
  -- Stated, not computed. promised_to is null on every real delivery
  -- because Grocery sends no promised_window (Q8), and a plausible
  -- zero here would be worse than an honest gap.
  select 'on-time rate', 'not available',
         'no promised window is set on any order (Q8 — Grocery sends none)'
  union all
  select 'rider utilisation', 'not available',
         'needs shift data this system does not hold';
$$;

/** The one number where anything but 100% is a stock discrepancy. */
create or replace function delivery.commit_health()
returns table (kind text, state text, n bigint)
language sql stable security definer
set search_path = delivery, identity, ops, public, extensions
as $$
  select 'commit', coalesce(d.commit_status, 'none'), count(*)::bigint
    from delivery.delivery d
   where identity.has_permission('reports:read')
     and d.status = 'DELIVERED' and ops.can_access_location(d.pickup_location_code)
   group by 2
  union all
  select 'release', d.release_status, count(*)::bigint
    from delivery.delivery d
   where identity.has_permission('reports:read')
     and d.release_status <> 'none' and ops.can_access_location(d.pickup_location_code)
   group by 2
   order by 1, 2;
$$;

/** Dead-lettered ÷ total. Target < 0.1 %. */
create or replace function integration.error_rate()
returns table (total bigint, dead bigint, rate text)
language sql stable security definer
set search_path = integration, identity, public, extensions
as $$
  select count(*)::bigint,
         count(*) filter (where status = 'DEAD')::bigint,
         case when count(*) = 0 then 'no data'
              else round(100.0 * count(*) filter (where status = 'DEAD') / count(*), 3)::text || ' %'
         end
    from integration.outbound_event
   where identity.has_permission('reports:read');
$$;

-- ─────────────── permissions ───────────────

insert into identity.role_permission (role, permission) values
  ('admin',      'reports:read'),
  ('dispatcher', 'reports:read')
on conflict do nothing;

alter table ops.job_run      enable row level security;
alter table ops.job_schedule enable row level security;

create policy job_run_read on ops.job_run
  for select using (identity.has_permission('system:health:deep'));
create policy job_schedule_read on ops.job_schedule
  for select using (identity.has_permission('system:health:deep'));

grant select on ops.job_run, ops.job_schedule to authenticated;

grant execute on function ops.job_started(text, text)                 to authenticated;
grant execute on function ops.job_finished(bigint, boolean, text, jsonb) to authenticated;
grant execute on function ops.job_health()                            to authenticated;
grant execute on function ops.retention_preview(integer, integer, integer) to authenticated;
grant execute on function delivery.expiring_holds(integer)            to authenticated;
grant execute on function delivery.flag_expiring_holds(integer)       to authenticated;
grant execute on function delivery.stuck_deliveries(integer)          to authenticated;
grant execute on function delivery.status_funnel(timestamptz)         to authenticated;
grant execute on function delivery.latency_percentiles(timestamptz)   to authenticated;
grant execute on function delivery.outcome_rates(timestamptz)         to authenticated;
grant execute on function delivery.commit_health()                    to authenticated;
grant execute on function integration.error_rate()                    to authenticated;

-- ── The two that destroy data ──
--
-- Callable only by the worker's own role, never by a signed-in user
-- through any screen. Postgres grants EXECUTE to PUBLIC by default,
-- so revoking from `authenticated` alone would do nothing — this
-- codebase learned that with mint_otp in Phase 4a.
revoke all on function ops.retention_purge(integer, integer, integer) from public;
revoke all on function ops.retention_purge(integer, integer, integer) from authenticated;
revoke all on function ops.redact_audit_pii(integer) from public;
revoke all on function ops.redact_audit_pii(integer) from authenticated;
revoke all on function integration.redact_rider_event() from public;
revoke all on function integration.redact_rider_event() from authenticated;
