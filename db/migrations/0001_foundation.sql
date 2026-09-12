-- ============================================================
-- 0001 - Foundation: schemas, claims, and the audit log
--
-- The audit log is created FIRST, before anything it audits.
-- Everything after this migration can assume it exists, which is
-- why no later migration has to remember to add auditing.
--
-- ── Why claims rather than a "current user" table ──
--
-- Every request sets request.jwt.claims and switches to the
-- `authenticated` role. Row-level security then reads the claims.
-- A human session and an API key produce the SAME claim shape, so
-- one set of policies covers both and there is no privileged path
-- that only the dashboard can take.
-- ============================================================

create schema if not exists ops;
create schema if not exists identity;
create schema if not exists integration;

create extension if not exists pgcrypto;
create extension if not exists citext;

-- ─────────────── the role every request runs as ───────────────
--
-- Supabase ships `authenticated` already; a plain postgres:17-alpine
-- container does not, and the failure is a bare "role does not exist"
-- at the first SET LOCAL ROLE -- long after the migration that should
-- have created it. Creating it here means local development and
-- Supabase behave the same way.
--
-- NOLOGIN: nothing connects AS this role. A request connects as the
-- pool's user and switches into it for the duration of one
-- transaction, which is what puts row-level security in the path.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end $$;

-- ─────────────── claims accessors ───────────────

create or replace function ops.current_claims() returns jsonb
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb);
$$;

create or replace function ops.current_role_name() returns text
language sql stable as $$
  select coalesce(ops.current_claims() ->> 'role', 'anon');
$$;

create or replace function ops.current_actor_id() returns uuid
language sql stable as $$
  select nullif(ops.current_claims() ->> 'sub', '')::uuid;
$$;

create or replace function ops.current_client_id() returns uuid
language sql stable as $$
  select nullif(ops.current_claims() ->> 'client_id', '')::uuid;
$$;

create or replace function ops.current_actor_kind() returns text
language sql stable as $$
  select coalesce(ops.current_claims() ->> 'actor_kind', 'SYSTEM');
$$;

/**
 * Locations this caller may act on. An EMPTY array means ALL.
 *
 * That rule is deliberate and applies to both humans and API keys
 * here, unlike Inventory where it differs between the two. Keeping
 * one rule is the simpler system: there is one sentence to remember
 * instead of two that contradict each other.
 */
create or replace function ops.current_locations() returns text[]
language sql stable as $$
  select coalesce(
    array(select jsonb_array_elements_text(
      case jsonb_typeof(ops.current_claims() -> 'location_codes')
        when 'array' then ops.current_claims() -> 'location_codes'
        else '[]'::jsonb end)),
    '{}'::text[]);
$$;

create or replace function ops.can_access_location(p_code text) returns boolean
language sql stable as $$
  select p_code is null
      or cardinality(ops.current_locations()) = 0
      or p_code = any(ops.current_locations());
$$;

-- ─────────────── the audit log ───────────────

create table ops.audit_log (
  id             bigint generated always as identity primary key,
  occurred_at    timestamptz not null default now(),

  -- Null for an unauthenticated or system action. "Who did this"
  -- must still name something, so actor_kind is never null.
  actor_id       uuid,
  actor_role     text,
  actor_kind     text not null default 'SYSTEM'
                   check (actor_kind in ('USER','API_CLIENT','SYSTEM','ANON')),

  action         text not null,          -- 'auth.signed_in', 'api_key.minted', ...
  entity_type    text,
  entity_id      text,
  before         jsonb,
  after          jsonb,
  reason         text,
  correlation_id text,
  ip             inet,
  user_agent     text
);

create index audit_log_occurred  on ops.audit_log (occurred_at desc);
create index audit_log_action    on ops.audit_log (action, occurred_at desc);
create index audit_log_entity    on ops.audit_log (entity_type, entity_id);
create index audit_log_actor     on ops.audit_log (actor_id) where actor_id is not null;

/**
 * Append-only, enforced.
 *
 * A log that can be edited is not an audit log; it is a table that
 * happens to contain history. The difference only matters on the day
 * somebody wants to change what it says, which is exactly the day it
 * must not be possible.
 */
create or replace function ops.refuse_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'AUDIT_IMMUTABLE: the audit log is append-only'
    using errcode = '42501';
end $$;

create trigger audit_log_no_update
  before update on ops.audit_log
  for each row execute function ops.refuse_mutation();

create trigger audit_log_no_delete
  before delete on ops.audit_log
  for each row execute function ops.refuse_mutation();

/**
 * The only way a row gets in.
 *
 * SECURITY DEFINER, so there is no insert policy for anyone. Callers
 * cannot choose the actor: it is read from the claims. An audit row
 * you can forge is worth nothing.
 */
create or replace function ops.audit(
  p_action      text,
  p_entity_type text default null,
  p_entity_id   text default null,
  p_before      jsonb default null,
  p_after       jsonb default null,
  p_reason      text default null,
  p_ip          text default null,
  p_user_agent  text default null
) returns bigint
language plpgsql security definer
set search_path = ops, public, extensions
as $$
declare v_id bigint;
begin
  insert into ops.audit_log (
    actor_id, actor_role, actor_kind, action, entity_type, entity_id,
    before, after, reason, correlation_id, ip, user_agent)
  values (
    ops.current_actor_id(), ops.current_role_name(), ops.current_actor_kind(),
    p_action, p_entity_type, p_entity_id,
    p_before, p_after, p_reason,
    ops.current_claims() ->> 'correlation_id',
    nullif(p_ip, '')::inet, p_user_agent)
  returning id into v_id;
  return v_id;
end $$;

alter table ops.audit_log enable row level security;

-- Readable by those allowed to read it; writable by nobody. The
-- absence of an insert policy is the point, not an oversight.
create policy audit_log_read on ops.audit_log
  for select using (ops.current_role_name() in ('admin','system'));

comment on table ops.audit_log is
  'Append-only. UPDATE and DELETE raise AUDIT_IMMUTABLE; rows arrive only via ops.audit().';
