-- ============================================================
-- 0014 — Who counts as a logistics actor
--
-- ── What this fixes, and how it was found ──
--
-- Every phase assumed `authenticated` meant "somebody this system
-- signed in". That held while logistics owned its database: the role
-- is NOLOGIN, and the only way to become it is through this
-- application's HTTP layer, which authenticates first and then sets
-- `request.jwt.claims`.
--
-- Installed beside another application in the same Postgres — a
-- Supabase project, say — it stops holding. There, `authenticated` is
-- the role every signed-in customer of that other application gets,
-- and their JWT arrives with claims this system never issued.
--
-- Probed with exactly such a JWT:
--
--   select from delivery.delivery       0 rows      RLS held
--   select from identity.app_user       0 rows      RLS held
--   delivery.transition -> CANCELLED    *** SUCCEEDED ***
--   delivery.ingest_order               no auth check at all
--
-- Reads were never the problem. Two write paths were:
--
--   * `delivery.transition` gated only on ops.can_access_location(),
--     which returns TRUE when the claims carry no location_codes —
--     "bound to no location" has always meant "every location", and a
--     stranger's JWT is bound to no location.
--
--   * `delivery.ingest_order` checked nothing whatsoever. It was
--     written to be called by the API route after the route had
--     authorised an API key, and the authorisation lived only there.
--
-- ── The rule ──
--
-- A caller must hold a role this system recognises. Not a permission
-- — the roles differ in what they may do — but membership: are you an
-- actor in this system at all, or are you somebody else's user who
-- happens to share a Postgres role name?
--
-- This is defence in depth, not a replacement for the permission
-- checks around it. Both paths keep every check they already had.
-- ============================================================

/**
 * Is the caller an actor in THIS system?
 *
 * The five roles logistics issues claims for. Anything else — a
 * customer signed in to another application, an unauthenticated
 * request, a role invented later — is not.
 *
 * Deliberately a list rather than "has any permission", because
 * `system` and `api_client` legitimately hold no rows in
 * role_permission and must still be able to act.
 */
create or replace function ops.is_logistics_actor() returns boolean
language sql stable as $$
  select ops.current_role_name() in
    ('admin', 'dispatcher', 'rider', 'api_client', 'system');
$$;

comment on function ops.is_logistics_actor() is
  'Membership, not permission. Guards the write paths whose only other gate was can_access_location, which is permissive for claims carrying no location_codes.';

/**
 * The ONLY way a delivery's status changes — now with a gate on who
 * is asking, as well as where.
 *
 * Identical to 0005 apart from the first check. Repeated in full
 * rather than wrapped, because this function is the single point
 * every status change passes through and indirection around it would
 * be the wrong kind of clever.
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
  -- Added in 0014. can_access_location() below answers "which shops
  -- may you act on" and answers it permissively for claims that name
  -- no shop. It was never meant to answer "are you one of us".
  if not ops.is_logistics_actor() then
    raise exception 'FORBIDDEN_ACTOR: % is not a role this system issues claims for',
      ops.current_role_name() using errcode = '42501';
  end if;

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

/**
 * Ingest gains the check its caller was carrying for it.
 *
 * A TRIGGER on delivery.delivery rather than a guard inside
 * ingest_order, for the reason this codebase keeps arriving at: a
 * rule on the table cannot be forgotten by the next writer, and
 * ingest_order is a hundred lines of insert-the-delivery, its
 * address, its items and its first timeline row. Duplicating it to
 * prepend one line would leave two copies to keep in step.
 *
 * It fires inside ingest_order's SECURITY DEFINER context, which
 * changes nothing here: the claims are transaction-local and say who
 * asked, not which function is running.
 */
create or replace function delivery.assert_may_ingest() returns trigger
language plpgsql security definer
set search_path = ops, identity, public, extensions
as $$
begin
  if not ops.is_logistics_actor() then
    raise exception 'FORBIDDEN_ACTOR: creating a delivery requires an API client or a staff session, not a % claim',
      ops.current_role_name() using errcode = '42501';
  end if;
  return new;
end $$;

create trigger delivery_requires_an_actor
  before insert on delivery.delivery
  for each row execute function delivery.assert_may_ingest();

-- ─────────────── permissions ───────────────

grant execute on function ops.is_logistics_actor() to authenticated;
-- The trigger function is called by Postgres, never by a client.
revoke all on function delivery.assert_may_ingest() from public;
revoke all on function delivery.assert_may_ingest() from authenticated;
