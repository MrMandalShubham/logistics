-- ============================================================
-- 0003 - Integration: API keys, idempotency, rate limit,
--        and references to the two systems we talk to
--
-- ── What "external reference" means here ──
--
-- integration.location_ref is a CACHE of Inventory's locations. It
-- is not a source of truth and must never become one. The moment
-- logistics starts deciding what a location is, there are two
-- answers to a question that can only have one.
--
-- The same rule will apply in Phase 2 to products: we will store a
-- sku and a name as they were at dispatch, because that is a fact
-- about a parcel, and nothing that could drift into a second
-- catalogue.
-- ============================================================

-- ─────────────── API clients ───────────────

create table integration.api_client (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,

  -- The key itself is never stored. Only its SHA-256 and a prefix
  -- long enough to recognise it in a list.
  key_hash       text not null unique,
  key_prefix     text not null,

  scopes         text[] not null,
  location_codes text[] not null default '{}',   -- empty = all (0001)

  environment    text not null default 'LIVE'
                   check (environment in ('LIVE','SANDBOX')),
  rate_limit_per_min integer not null default 120
                   check (rate_limit_per_min between 1 and 10000),

  status         text not null default 'ACTIVE'
                   check (status in ('ACTIVE','REVOKED')),
  expires_at     timestamptz,
  created_at     timestamptz not null default now(),
  last_used_at   timestamptz,

  -- Token bucket. Kept on the client row so charging a request is
  -- one indexed UPDATE rather than a join.
  tokens         numeric not null default 0,
  tokens_at      timestamptz not null default now()
);

create index api_client_active on integration.api_client (status)
  where status = 'ACTIVE';

/**
 * Mint a key. Returns it ONCE; after this only the hash exists.
 *
 * lg_live_ / lg_test_ so a sandbox key pasted into production is
 * obvious on sight and in a log.
 */
create or replace function integration.create_api_client(
  p_name        text,
  p_scopes      text[],
  p_locations   text[] default '{}',
  p_environment text default 'LIVE',
  p_rate_limit  integer default 120
) returns table (client_id uuid, api_key text)
language plpgsql security definer
set search_path = integration, ops, public, extensions
as $$
declare v_key text; v_id uuid;
begin
  if ops.current_role_name() not in ('admin','system') then
    raise exception 'FORBIDDEN_ROLE: only an admin may mint a key'
      using errcode = '42501';
  end if;

  v_key := 'lg_' || lower(case p_environment when 'SANDBOX' then 'test' else 'live' end)
           || '_' || encode(gen_random_bytes(24), 'hex');

  -- The bucket starts FULL, not empty.
  --
  -- `tokens` defaults to 0, and the bucket refills from elapsed time
  -- since tokens_at -- which at mint is "now", so there is nothing to
  -- refill from. A brand new key was therefore rate-limited on its
  -- very first request, which is a baffling way to greet an
  -- integrator who has just pasted their credentials in.
  insert into integration.api_client
    (name, key_hash, key_prefix, scopes, location_codes, environment,
     rate_limit_per_min, tokens)
  values
    (p_name, encode(digest(v_key, 'sha256'), 'hex'), left(v_key, 12),
     p_scopes, p_locations, p_environment, p_rate_limit, p_rate_limit)
  returning id into v_id;

  perform ops.audit('api_key.minted', 'api_client', v_id::text, null,
    jsonb_build_object('name', p_name, 'scopes', p_scopes,
                       'environment', p_environment));

  client_id := v_id; api_key := v_key; return next;
end $$;

/**
 * Resolve a presented key to claims.
 *
 * Unknown, revoked and expired are one answer, deliberately. Telling
 * a caller which of the three it is tells an attacker which keys exist.
 */
create or replace function integration.authenticate_api_key(p_key text)
returns jsonb
language plpgsql security definer
set search_path = integration, identity, ops, public, extensions
as $$
declare c integration.api_client%rowtype;
begin
  select * into c from integration.api_client
   where key_hash = encode(digest(p_key, 'sha256'), 'hex')
     and status = 'ACTIVE'
     and (expires_at is null or expires_at > now());

  if c.id is null then return null; end if;

  update integration.api_client set last_used_at = now() where id = c.id;

  return jsonb_build_object(
    'sub',            null,
    'client_id',      c.id,
    'role',           'api_client',
    'actor_kind',     'API_CLIENT',
    'name',           c.name,
    'scopes',         to_jsonb(c.scopes),
    'location_codes', to_jsonb(c.location_codes),
    'environment',    c.environment,
    'rate_limit',     c.rate_limit_per_min);
end $$;

create or replace function integration.revoke_api_client(p_id uuid)
returns void
language plpgsql security definer
set search_path = integration, ops, public, extensions
as $$
begin
  if ops.current_role_name() not in ('admin','system') then
    raise exception 'FORBIDDEN_ROLE: only an admin may revoke a key'
      using errcode = '42501';
  end if;

  update integration.api_client set status = 'REVOKED' where id = p_id;
  perform ops.audit('api_key.revoked', 'api_client', p_id::text);
end $$;

-- ─────────────── rate limit ───────────────

/**
 * Charge one request against a client's bucket.
 *
 * Refills continuously rather than resetting on a boundary, so a
 * client cannot get two full minutes' worth by timing its burst
 * across the turn of a minute. One UPDATE, so two concurrent
 * requests cannot both read the same remaining count and both pass.
 */
create or replace function integration.consume_rate_token(
  p_client_id uuid, p_cost numeric default 1
) returns table (allowed boolean, limit_per_min integer,
                 remaining integer, retry_after integer)
language plpgsql security definer
set search_path = integration, public, extensions
as $$
declare c integration.api_client%rowtype; v_refill numeric;
begin
  update integration.api_client
     set tokens = least(
           rate_limit_per_min::numeric,
           tokens + extract(epoch from (now() - tokens_at))
                    * (rate_limit_per_min::numeric / 60.0)),
         tokens_at = now()
   where id = p_client_id
  returning * into c;

  if c.id is null then
    allowed := false; limit_per_min := 0; remaining := 0; retry_after := 60;
    return next; return;
  end if;

  if c.tokens >= p_cost then
    update integration.api_client set tokens = tokens - p_cost where id = p_client_id;
    allowed := true;
    limit_per_min := c.rate_limit_per_min;
    remaining := floor(c.tokens - p_cost);
    retry_after := 0;
  else
    v_refill := (p_cost - c.tokens) / (c.rate_limit_per_min::numeric / 60.0);
    allowed := false;
    limit_per_min := c.rate_limit_per_min;
    remaining := 0;
    retry_after := greatest(1, ceil(v_refill));
  end if;
  return next;
end $$;

-- ─────────────── idempotency ───────────────

create table integration.idempotency_record (
  api_client_id uuid not null references integration.api_client(id) on delete cascade,
  key           text not null,
  method        text not null,
  path          text not null,

  -- So a client reusing a key for a DIFFERENT request is told,
  -- rather than silently handed an answer to a question it did not ask.
  request_hash  text not null,

  status_code   integer not null,
  response_body jsonb not null,
  created_at    timestamptz not null default now(),
  primary key (api_client_id, key)
);

create index idempotency_age on integration.idempotency_record (created_at);

-- ─────────────── the systems we talk to ───────────────

create table integration.external_system (
  code       text primary key,          -- 'GROCERY' | 'INVENTORY'
  name       text not null,
  base_url   text,
  status     text not null default 'ACTIVE'
               check (status in ('ACTIVE','DISABLED')),
  notes      text,
  updated_at timestamptz not null default now()
);

insert into integration.external_system (code, name, notes) values
  ('GROCERY',   'Grocery storefront',
   'Owns the customer, the order and payment. Sends us delivery-ready orders; receives status.'),
  ('INVENTORY', 'Inventory Core',
   'System of record for stock. We confirm holds on ingest, commit on delivery, release on return.');

/**
 * A cache of Inventory's locations.
 *
 * source = SEED means it came from a fixture because no Inventory
 * key was configured. That is visible on purpose: a seeded row is a
 * guess, and an operator should be able to tell a guess from a fact.
 */
create table integration.location_ref (
  code                 text primary key,           -- HUB, SH1, SH2, SH3
  external_location_id uuid,
  name                 text not null,
  type                 text not null
                         check (type in ('HUB','STORE','WAREHOUSE','VIRTUAL')),
  lat                  numeric(9,6),
  lng                  numeric(9,6),
  is_active            boolean not null default true,
  source               text not null default 'INVENTORY'
                         check (source in ('INVENTORY','SEED')),
  synced_at            timestamptz
);

comment on table integration.location_ref is
  'CACHE of Inventory locations. Never a source of truth; refreshed by locations:sync, never written back.';

create or replace function integration.upsert_location_ref(
  p_code text, p_external_id uuid, p_name text, p_type text,
  p_lat numeric, p_lng numeric, p_source text
) returns void
language plpgsql security definer
set search_path = integration, ops, public, extensions
as $$
begin
  insert into integration.location_ref
    (code, external_location_id, name, type, lat, lng, source, synced_at)
  values (p_code, p_external_id, p_name, p_type, p_lat, p_lng, p_source, now())
  on conflict (code) do update
    set external_location_id = coalesce(excluded.external_location_id,
                                        location_ref.external_location_id),
        name      = excluded.name,
        type      = excluded.type,
        lat       = coalesce(excluded.lat, location_ref.lat),
        lng       = coalesce(excluded.lng, location_ref.lng),
        source    = excluded.source,
        synced_at = now();
end $$;

-- ─────────────── row-level security ───────────────

alter table integration.api_client          enable row level security;
alter table integration.idempotency_record  enable row level security;
alter table integration.external_system     enable row level security;
alter table integration.location_ref        enable row level security;

create policy api_client_read on integration.api_client
  for select using (identity.has_permission('keys:read'));

-- A key may read its OWN row, and only its own.
--
-- Without this, /api/v1/whoami -- the endpoint whose entire job is
-- "is my key wired up correctly?" -- returns null for the key prefix
-- and the last-used time, because an api_client holds no permissions
-- and RLS hides the row from the very client it describes. It fails
-- by looking like it worked, which is the worst way to fail.
create policy api_client_self on integration.api_client
  for select using (id = ops.current_client_id());

-- Idempotency records belong to the client that made them, and are
-- read by the wrapper before the role switch. No broad policy.
create policy idempotency_own on integration.idempotency_record
  for select using (api_client_id = ops.current_client_id());

create policy external_system_read on integration.external_system
  for select using (ops.current_role_name() <> 'anon');

-- Location scoping actually bites here: a dispatcher bound to SH1
-- sees SH1.
create policy location_ref_read on integration.location_ref
  for select using (
    ops.current_role_name() <> 'anon'
    and ops.can_access_location(code));
