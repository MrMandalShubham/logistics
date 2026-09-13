-- ============================================================
-- 0013 — Where the shops are
--
-- ── The question this answers ──
--
-- Four of the nine V2 features need to know where a rider collects
-- from: automatic assignment, batching, delivery zones, and any ETA
-- worth the name. None of them can be built while the answer is null.
--
--   $ curl .../api/locations
--   HUB Central Warehouse   lat= None  lng= None
--   SH1 Shop 1 — Andheri    lat= None  lng= None
--   SH2 Shop 2 — Bandra     lat= None  lng= None
--
-- integration.location_ref has had lat and lng since Phase 1. They
-- have been null since Phase 1, because the only thing that fills
-- them is a sync from a system that has no such field. That is Q21,
-- open since Phase 0.
--
-- ── The rule this migration deliberately changes ──
--
-- location_ref has carried one comment since Phase 1:
--
--   'CACHE of Inventory locations. Never a source of truth;
--    refreshed by locations:sync, never written back.'
--
-- That was right, and it stays right about names, types and ids.
-- It is not right about geography, because **Inventory has never
-- claimed to own geography.** It owns stock. "Where does a rider
-- collect from" is a logistics fact that nobody else in this estate
-- is holding, and pretending otherwise has kept the column null for
-- seven phases.
--
-- So: the coordinates become locally owned, per-column, and the
-- comment is rewritten to say so rather than left to mislead. If
-- Inventory ever grows the field, sync prefers its value and the
-- local one becomes the fallback -- see integration.sync_location().
-- ============================================================

alter table integration.location_ref
  -- Four values, because "where did this number come from" has four
  -- genuinely different answers and a development seed must not be
  -- able to pass itself off as either an admin's decision or
  -- Inventory's data.
  add column if not exists geo_source text not null default 'NONE'
    check (geo_source in ('NONE','LOCAL','INVENTORY','SEED')),
  -- ON DELETE SET NULL: who typed a coordinate is useful history,
  -- not a reason an account can never be removed. The audit row keeps
  -- the name regardless, and it cannot be edited.
  add column if not exists geo_set_by uuid
    references identity.app_user(id) on delete set null,
  add column if not exists geo_set_at timestamptz,
  -- How far from this shop we will carry a parcel. Grocery enforces
  -- 10 km at checkout from its own hard-coded list; this is the
  -- logistics view, per shop, and it FLAGS rather than refuses.
  add column if not exists service_radius_km numeric(5,1) not null default 10.0
    check (service_radius_km > 0 and service_radius_km <= 100);

comment on table integration.location_ref is
  'Names, types and ids are a CACHE of Inventory and are never written back. Coordinates and service radius are LOCAL: Inventory has no such field (Q21) and geography is not its fact to own.';

comment on column integration.location_ref.geo_source is
  'NONE until somebody sets it. LOCAL: an admin typed it. INVENTORY: the sync supplied one, which has never happened. SEED: development fallback, and it never overwrites either of the other two.';

-- ─────────────── distance ───────────────

/**
 * Great-circle distance in kilometres.
 *
 * Haversine, in SQL, rather than PostGIS. This estate measures a few
 * kilometres across a single city; the difference between haversine
 * and a projected geometry here is centimetres, and an extension is
 * a deployment dependency for every environment forever.
 *
 * NULL in, NULL out — deliberately. A missing geocode must read as
 * "we do not know" everywhere downstream, never as a distance from
 * (0, 0), which is in the Atlantic and would rank an unmapped shop
 * as very far away rather than as unknown.
 */
create or replace function ops.distance_km(
  p_lat1 numeric, p_lng1 numeric, p_lat2 numeric, p_lng2 numeric
) returns numeric
language sql immutable as $$
  select case
    when p_lat1 is null or p_lng1 is null or p_lat2 is null or p_lng2 is null then null
    else round((
      6371 * 2 * asin(sqrt(
        power(sin(radians(p_lat2 - p_lat1) / 2), 2) +
        cos(radians(p_lat1)) * cos(radians(p_lat2)) *
        power(sin(radians(p_lng2 - p_lng1) / 2), 2)
      ))
    )::numeric, 2)
  end;
$$;

comment on function ops.distance_km(numeric, numeric, numeric, numeric) is
  'Haversine km. NULL for a missing geocode, never 0 — "we do not know" and "it is here" must not look alike.';

-- ─────────────── setting a geocode ───────────────

/**
 * An admin says where a shop is.
 *
 * Audited with the previous value, because a wrong geocode sends
 * riders to the wrong building and the question afterwards is always
 * "who changed it, and what was it before".
 */
create or replace function integration.set_location_geo(
  p_code text, p_lat numeric, p_lng numeric, p_radius_km numeric default null,
  p_force boolean default false
) returns jsonb
language plpgsql security definer
set search_path = integration, identity, ops, public, extensions
as $$
declare
  before_row integration.location_ref%rowtype;
  v_nearest  numeric;
begin
  if not identity.has_permission('locations:write') then
    raise exception 'FORBIDDEN: setting a pickup location requires locations:write'
      using errcode = '42501';
  end if;

  if p_lat is null or p_lng is null then
    raise exception 'GEO_REQUIRED: a latitude and a longitude, or nothing'
      using errcode = '23514';
  end if;
  if p_lat < -90 or p_lat > 90 then
    raise exception 'BAD_LATITUDE: % is outside -90..90', p_lat using errcode = '23514';
  end if;
  if p_lng < -180 or p_lng > 180 then
    raise exception 'BAD_LONGITUDE: % is outside -180..180', p_lng using errcode = '23514';
  end if;

  select * into before_row from integration.location_ref where code = upper(p_code);
  if before_row.code is null then
    raise exception 'NO_SUCH_LOCATION: % is not a location this system knows', p_code
      using errcode = 'P0002';
  end if;

  -- ── The check that actually catches a swap ──
  --
  -- A range check cannot. Mumbai is 19.07, 72.87; swapped, the
  -- latitude reads 72.87, which is a perfectly legal latitude — it is
  -- in the Arctic Ocean. Nothing about the number is wrong.
  --
  -- What IS detectable is that it would put this shop thousands of
  -- kilometres from every other shop in the estate. That catches a
  -- swap, a dropped minus sign and a fat-fingered digit alike, and it
  -- does it without hardcoding a country into a schema.
  --
  -- It refuses rather than warns, because there is no way to warn: a
  -- server-side function that returns a caveat nobody reads is the
  -- same as no check. Setting it anyway is `p_force`, which is
  -- audited as a forced value.
  if not p_force then
    select min(ops.distance_km(p_lat, p_lng, l.lat, l.lng))
      into v_nearest
      from integration.location_ref l
     where l.lat is not null and l.code <> upper(p_code);

    if v_nearest is not null and v_nearest > 500 then
      raise exception 'IMPLAUSIBLE_LOCATION: %, % is % km from the nearest shop this system knows. Latitude and longitude entered the wrong way round give exactly this. If it really is that far away, set it with force.',
        p_lat, p_lng, round(v_nearest) using errcode = '23514';
    end if;
  end if;

  update integration.location_ref
     set lat = p_lat, lng = p_lng,
         service_radius_km = coalesce(p_radius_km, service_radius_km),
         geo_source = 'LOCAL',
         geo_set_by = ops.current_actor_id(),
         geo_set_at = now()
   where code = upper(p_code);

  perform ops.audit('location.geo_set', 'location', upper(p_code),
    jsonb_build_object('lat', before_row.lat, 'lng', before_row.lng,
                       'radius_km', before_row.service_radius_km,
                       'source', before_row.geo_source),
    jsonb_build_object('lat', p_lat, 'lng', p_lng,
                       'radius_km', coalesce(p_radius_km, before_row.service_radius_km),
                       'source', 'LOCAL'),
    case when p_force then 'forced past the plausibility check' end);

  return jsonb_build_object('ok', true, 'code', upper(p_code),
    'lat', p_lat, 'lng', p_lng,
    'radius_km', coalesce(p_radius_km, before_row.service_radius_km));
end $$;

/**
 * What the sync is allowed to touch.
 *
 * The old upsert already refused to overwrite a geocode with NULL —
 * `coalesce(excluded.lat, location_ref.lat)` — but it reset `source`
 * on every run, which would have relabelled an admin's coordinates as
 * having come from Inventory.
 *
 * This one is explicit about the split: names, types and ids come
 * from Inventory and are overwritten every sync. Coordinates are
 * overwritten only when Inventory actually supplies them, which it
 * never has; when it does, Inventory wins and the local value becomes
 * history. That ordering is the whole reason to keep geo_source.
 */
create or replace function integration.sync_location(
  p_code text, p_external_id uuid, p_name text, p_type text,
  p_lat numeric default null, p_lng numeric default null,
  p_source text default 'INVENTORY'
) returns void
language plpgsql security definer
set search_path = integration, ops, public, extensions
as $$
begin
  insert into integration.location_ref
    (code, external_location_id, name, type, lat, lng, source, synced_at,
     geo_source, geo_set_at)
  values (upper(p_code), p_external_id, p_name, p_type, p_lat, p_lng, p_source, now(),
          case when p_lat is null then 'NONE'
               when p_source = 'SEED' then 'SEED'
               else 'INVENTORY' end,
          case when p_lat is not null then now() end)
  on conflict (code) do update
    set external_location_id = coalesce(excluded.external_location_id,
                                        location_ref.external_location_id),
        name      = excluded.name,
        type      = excluded.type,
        source    = excluded.source,
        synced_at = now(),

        -- Only when Inventory actually has one.
        -- A seed must not overwrite a geocode somebody set on purpose.
        lat = case
          when p_source = 'SEED' and location_ref.geo_source in ('LOCAL','INVENTORY')
            then location_ref.lat
          else coalesce(excluded.lat, location_ref.lat) end,
        lng = case
          when p_source = 'SEED' and location_ref.geo_source in ('LOCAL','INVENTORY')
            then location_ref.lng
          else coalesce(excluded.lng, location_ref.lng) end,
        geo_source = case
          -- A development seed never outranks an admin's decision.
          when excluded.lat is not null and p_source = 'SEED'
               and location_ref.geo_source in ('LOCAL','INVENTORY')
            then location_ref.geo_source
          when excluded.lat is not null and p_source = 'SEED' then 'SEED'
          when excluded.lat is not null then 'INVENTORY'
          else location_ref.geo_source
        end,
        geo_set_at = case
          when excluded.lat is not null then now()
          else location_ref.geo_set_at
        end,
        geo_set_by = case
          when excluded.lat is not null then null
          else location_ref.geo_set_by
        end;
end $$;

/** What an admin sees, including what is still unset. */
create or replace function integration.locations_with_geo()
returns table (
  code text, name text, type text, is_active boolean,
  lat numeric, lng numeric, service_radius_km numeric,
  geo_source text, geo_set_at timestamptz, geo_set_by_name text,
  synced_at timestamptz, open_deliveries bigint)
language sql stable security definer
set search_path = integration, delivery, identity, ops, public, extensions
as $$
  select l.code, l.name, l.type, l.is_active,
         l.lat, l.lng, l.service_radius_km,
         l.geo_source, l.geo_set_at, u.full_name, l.synced_at,
         (select count(*)::bigint from delivery.delivery d
           where d.pickup_location_code = l.code
             and d.status not in ('DELIVERED','RETURNED','CANCELLED'))
    from integration.location_ref l
    left join identity.app_user u on u.id = l.geo_set_by
   where identity.has_permission('locations:read')
   order by l.code;
$$;

-- ─────────────── §3.2: ranking, not automation ───────────────

/**
 * Which rider should take this, and WHY.
 *
 * ── Why this ranks and does not assign ──
 *
 * A scoring function nobody has watched make a decision is not one to
 * hand the wheel to. This returns an ordered list with the reason
 * attached; the dispatcher still clicks. That is useful on day one,
 * it is what automation would have to be built on anyway, and it
 * produces the record you would need to check whether automating the
 * click would have chosen well.
 *
 * ── Where a rider "is" ──
 *
 * Harder than it sounds, and worth stating. fleet.rider_location is
 * only collected between PICKED_UP and a terminal state — Phase 4a
 * made that a rule in the database because tracking a named worker
 * outside their task is not a default to take. So an IDLE rider, who
 * is exactly the one you want to assign, has no position at all.
 *
 * Three tiers, in order of how much they are worth trusting:
 *
 *   LIVE   a position within the last 15 minutes, from a rider
 *          finishing a job nearby
 *   HOME   no position, but their home shop is this shop
 *   NONE   neither. Ranked LAST, never dropped — a rider with no
 *          data is still a rider who can take the job, and dropping
 *          them would quietly shrink the roster.
 */
create or replace function fleet.rank_riders_for(p_delivery_id uuid)
returns table (
  rider_id uuid, code text, display_name text,
  distance_km numeric, position_source text,
  active_count integer, max_concurrent integer,
  idle_minutes integer, unavailable_reason text,
  rank integer, why text)
language sql stable security definer
set search_path = fleet, delivery, integration, identity, ops, public, extensions
as $$
  with d as (
    select dd.id, dd.pickup_location_code, l.lat as shop_lat, l.lng as shop_lng
      from delivery.delivery dd
      join integration.location_ref l on l.code = dd.pickup_location_code
     where dd.id = p_delivery_id
       and identity.has_permission('deliveries:assign')
       and ops.can_access_location(dd.pickup_location_code)
  ),
  live as (
    select distinct on (rl.rider_id) rl.rider_id, rl.lat, rl.lng, rl.recorded_at
      from fleet.rider_location rl
     where rl.recorded_at > now() - interval '15 minutes'
     order by rl.rider_id, rl.recorded_at desc
  ),
  scored as (
    select r.id, r.code, r.display_name,
           r.active_count, r.max_concurrent,
           fleet.unavailable_reason(r.id) as reason,
           -- Only a MEASURED distance goes here. "Based at this shop"
           -- is a good reason to rank somebody first and it is not a
           -- distance: with no shop coordinates it would report 0 km,
           -- which claims we know exactly where they are. The tier in
           -- `pos` carries that preference instead.
           case
             when live.lat is not null
               then ops.distance_km(live.lat, live.lng, d.shop_lat, d.shop_lng)
           end as km,
           case
             when live.lat is not null then 'LIVE'
             when r.home_location_code = d.pickup_location_code then 'HOME'
             else 'NONE'
           end as pos,
           (extract(epoch from now() - coalesce(
              (select max(a.responded_at) from fleet.assignment a where a.rider_id = r.id),
              r.created_at)) / 60)::integer as idle
      from fleet.rider_current r
      cross join d
      left join live on live.rider_id = r.id
     where r.status = 'ACTIVE'
  )
  select id, code, display_name, km, pos, active_count, max_concurrent, idle, reason,
         row_number() over (
           order by
             -- Available first. An unavailable rider is shown with
             -- the reason rather than hidden, because "nobody is
             -- free" and "everybody is busy for this reason" are
             -- different problems.
             (reason is null) desc,
             -- Then how much we trust where they are.
             case pos when 'LIVE' then 0 when 'HOME' then 1 else 2 end,
             km nulls last,
             active_count,
             idle desc,
             code
         )::integer,
         case
           when reason is not null then reason
           when pos = 'LIVE' and km is not null then
             format('%s km away, last seen just now, %s of %s in hand',
                    km, active_count, max_concurrent)
           when pos = 'LIVE' then
             format('nearby but the shop has no coordinates (Q21), %s of %s in hand',
                    active_count, max_concurrent)
           when pos = 'HOME' then
             format('based at this shop, %s of %s in hand, idle %s min',
                    active_count, max_concurrent, idle)
           else
             format('no recent position, %s of %s in hand, idle %s min',
                    active_count, max_concurrent, idle)
         end
    from scored;
$$;

-- ─────────────── §8.5: serviceability, which flags ───────────────

/**
 * Is this address within range of the shop fulfilling it?
 *
 * ── Why this never refuses ──
 *
 * Grocery already accepted the order, took the money and reserved the
 * stock. An order that reached us is not one logistics may quietly
 * drop because a radius says so — that would leave a customer paid up
 * with no parcel and nobody told.
 *
 * So it answers, and Phase 6's exception queue carries the answer to
 * a person who can ring somebody.
 *
 * 'unknown' is a real answer and is kept distinct from 'out'. Until
 * Q21 is answered for a shop, we genuinely cannot tell, and saying
 * "out of range" would be inventing a fact.
 */
create or replace function delivery.serviceability(p_delivery_id uuid)
returns table (verdict text, distance_km numeric, radius_km numeric, detail text)
language sql stable security definer
set search_path = delivery, integration, ops, public, extensions
as $$
  select
    case
      when l.lat is null then 'unknown'
      when ops.distance_km(a.lat, a.lng, l.lat, l.lng) <= l.service_radius_km then 'in'
      else 'out'
    end,
    ops.distance_km(a.lat, a.lng, l.lat, l.lng),
    l.service_radius_km,
    case
      when l.lat is null then
        format('%s has no coordinates, so range cannot be checked (Q21)', l.code)
      when ops.distance_km(a.lat, a.lng, l.lat, l.lng) <= l.service_radius_km then
        format('%s km from %s, within %s km',
               ops.distance_km(a.lat, a.lng, l.lat, l.lng), l.code, l.service_radius_km)
      else
        format('%s km from %s, which is beyond the %s km this shop serves',
               ops.distance_km(a.lat, a.lng, l.lat, l.lng), l.code, l.service_radius_km)
    end
    from delivery.delivery d
    join delivery.delivery_address a on a.delivery_id = d.id
    join integration.location_ref l on l.code = d.pickup_location_code
   where d.id = p_delivery_id;
$$;

/**
 * Raise a flag for anything out of range, once per delivery.
 *
 * Called by the ingest path; also safe to run over a backlog.
 */
create or replace function delivery.flag_unserviceable(p_delivery_id uuid)
returns text
language plpgsql security definer
set search_path = delivery, ops, public, extensions
as $$
declare s record;
begin
  select * into s from delivery.serviceability(p_delivery_id);
  if s.verdict is null or s.verdict <> 'out' then
    return coalesce(s.verdict, 'unknown');
  end if;

  if not exists (select 1 from delivery.delivery_exception x
                  where x.delivery_id = p_delivery_id
                    and x.code = 'OUT_OF_SERVICE_RANGE' and x.resolved_at is null) then
    insert into delivery.delivery_exception (delivery_id, code, severity, note)
    values (p_delivery_id, 'OUT_OF_SERVICE_RANGE', 'WARNING', s.detail);
  end if;

  return 'out';
end $$;

/**
 * Check it at ingest, and never fail ingest because of it.
 *
 * A trigger on the address row rather than a line inside
 * ingest_order, for the reason this codebase keeps landing on: there
 * will be more writers, and the address is the thing that makes the
 * question answerable.
 */
create or replace function delivery.check_serviceability()
returns trigger
language plpgsql security definer
set search_path = delivery, ops, public, extensions
as $$
begin
  begin
    perform delivery.flag_unserviceable(new.delivery_id);
  exception when others then
    -- An order Grocery accepted must not fail to arrive here because
    -- a radius check had a bad moment.
    null;
  end;
  return new;
end $$;

create trigger address_checks_serviceability
  after insert on delivery.delivery_address
  for each row execute function delivery.check_serviceability();

-- ─────────────── permissions ───────────────

insert into identity.role_permission (role, permission) values
  ('admin', 'locations:write')
on conflict do nothing;

grant execute on function ops.distance_km(numeric, numeric, numeric, numeric) to authenticated;
grant execute on function integration.set_location_geo(text, numeric, numeric, numeric, boolean) to authenticated;
grant execute on function integration.sync_location(text, uuid, text, text, numeric, numeric, text) to authenticated;
grant execute on function integration.locations_with_geo() to authenticated;
grant execute on function fleet.rank_riders_for(uuid) to authenticated;
grant execute on function delivery.serviceability(uuid) to authenticated;
grant execute on function delivery.flag_unserviceable(uuid) to authenticated;

revoke all on function delivery.check_serviceability() from public;
revoke all on function delivery.check_serviceability() from authenticated;
