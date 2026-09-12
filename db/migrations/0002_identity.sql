-- ============================================================
-- 0002 - Identity: people, passwords, sessions, permissions
--
-- Three roles, not five. admin dispatches nothing, dispatcher rides
-- nothing, rider administers nothing. Support and viewer were in the
-- plan and are dropped: a role nobody is assigned to is a policy
-- nobody tests, and it can be added in one migration the day someone
-- actually needs it.
--
-- ── Passwords ──
--
-- scrypt from node:crypto, not bcrypt. It is in the standard library,
-- needs no native build on any platform, and is memory-hard. One
-- fewer dependency in the supply chain of a system that holds
-- customer addresses.
--
-- ── Sessions ──
--
-- The cookie value is NEVER stored. Only its SHA-256. Somebody who
-- reads a database backup gets a list of hashes, not a set of live
-- logins.
-- ============================================================

create table identity.app_user (
  id             uuid primary key default gen_random_uuid(),
  email          citext not null unique,
  full_name      text not null,
  phone          text,

  role           text not null check (role in ('admin','dispatcher','rider')),
  status         text not null default 'ACTIVE'
                   check (status in ('ACTIVE','SUSPENDED','DISABLED')),

  -- Empty means every location. One rule, everywhere (see 0001).
  location_codes text[] not null default '{}',

  -- Set by the bootstrap script and by an admin reset. Blocks every
  -- route except the password change itself.
  must_change_password boolean not null default false,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index app_user_role on identity.app_user (role) where status = 'ACTIVE';

create table identity.credential (
  user_id       uuid primary key references identity.app_user(id) on delete cascade,
  password_hash text not null,                 -- scrypt: N$r$p$salt$hash
  failed_count  integer not null default 0,
  locked_until  timestamptz,
  rotated_at    timestamptz not null default now()
);

create table identity.session (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references identity.app_user(id) on delete cascade,
  token_hash   text not null unique,           -- sha256 of the cookie value
  issued_at    timestamptz not null default now(),
  expires_at   timestamptz not null,
  last_seen_at timestamptz,
  revoked_at   timestamptz,
  ip           inet,
  user_agent   text
);

-- Not `session_user`: that is a reserved word in Postgres and the
-- CREATE INDEX fails with a bare "syntax error" that names no cause.
create index session_user_idx on identity.session (user_id);
create index session_expiry_idx on identity.session (expires_at) where revoked_at is null;

-- ─────────────── permissions ───────────────
--
-- A table rather than a hard-coded list, so granting a permission is
-- a migration with a diff and an audit trail rather than an edit
-- buried in application code.

create table identity.role_permission (
  role       text not null,
  permission text not null,
  primary key (role, permission)
);

insert into identity.role_permission (role, permission) values
  ('admin',      'system:health:deep'),
  ('admin',      'audit:read'),
  ('admin',      'users:read'),
  ('admin',      'users:write'),
  ('admin',      'keys:read'),
  ('admin',      'keys:write'),
  ('admin',      'locations:read'),
  ('dispatcher', 'system:health:deep'),
  ('dispatcher', 'users:read'),
  ('dispatcher', 'locations:read'),
  ('rider',      'locations:read');

create or replace function identity.has_permission(p_permission text) returns boolean
language sql stable
set search_path = identity, ops, public
as $$
  select exists (
    select 1 from identity.role_permission
     where role = ops.current_role_name()
       and permission = p_permission);
$$;

create or replace function identity.permissions_for(p_role text) returns text[]
language sql stable as $$
  select coalesce(array_agg(permission order by permission), '{}')
    from identity.role_permission where role = p_role;
$$;

-- ─────────────── sign in ───────────────

/**
 * The stored hash for an email, or null.
 *
 * Definer, because nobody -- not even an admin -- may SELECT from
 * identity.credential. The caller needs the hash only to run scrypt
 * against it, and gets null for an unknown address so it can run the
 * same work against a dummy and make an unknown email cost the same
 * time as a wrong password.
 */
create or replace function identity.password_hash_for(p_email citext)
returns text
language sql security definer stable
set search_path = identity, public, extensions
as $$
  select c.password_hash
    from identity.credential c
    join identity.app_user u on u.id = c.user_id
   where u.email = p_email;
$$;

/**
 * Verify a password and open a session.
 *
 * The password is hashed by the application (scrypt lives in Node,
 * not in Postgres), so this takes the hash comparison as a boolean
 * the caller has already computed. Everything ELSE about signing in
 * -- lockout, status, counters, the session row, the audit entry --
 * happens here, in one transaction, because those are the parts that
 * must not drift apart.
 *
 * ── Why this RETURNS a refusal instead of raising one ──
 *
 * The first version raised. It looked correct and could never have
 * worked: raising aborts the transaction, and the rollback takes the
 * failure counter with it. Five wrong passwords left failed_count at
 * zero, so the account never locked -- and the auth.sign_in_failed
 * audit rows were rolled back too, meaning a brute-force attempt
 * would have left no trace anywhere.
 *
 * A refusal is a normal outcome of signing in, not an exception. It
 * has bookkeeping that must survive it. So it commits.
 *
 * Returns { ok: true, claims } or { ok: false, code, message }.
 */
create or replace function identity.open_session(
  p_email        citext,
  p_password_ok  boolean,
  p_token_hash   text,
  p_ttl_seconds  integer,
  p_ip           text default null,
  p_user_agent   text default null,
  p_correlation_id text default null
) returns jsonb
language plpgsql security definer
set search_path = identity, ops, public, extensions
as $$
declare
  u identity.app_user%rowtype;
  c identity.credential%rowtype;
  v_session uuid;
begin
  select * into u from identity.app_user where email = p_email;
  select * into c from identity.credential where user_id = u.id;

  -- ── Name the actor before auditing anything ──
  --
  -- Sign-in is the one path with no claims yet: it is the request
  -- that creates them. Without this, every auth.signed_in row was
  -- written as actor_kind SYSTEM / role anon with no correlation id,
  -- so the audit log could not answer "who signed in, and when" from
  -- the columns built to answer exactly that.
  --
  -- Setting it here is not a forgery: we have just identified this
  -- row by its email, and the claims are transaction-local.
  if u.id is not null then
    perform set_config('request.jwt.claims', jsonb_build_object(
      'sub', u.id, 'role', u.role, 'actor_kind', 'USER',
      'correlation_id', p_correlation_id)::text, true);
  elsif p_correlation_id is not null then
    perform set_config('request.jwt.claims', jsonb_build_object(
      'actor_kind', 'ANON', 'role', 'anon',
      'correlation_id', p_correlation_id)::text, true);
  end if;

  -- Unknown user and wrong password are deliberately the same answer.
  if u.id is null or c.user_id is null then
    perform ops.audit('auth.sign_in_failed', 'user', p_email::text,
                      null, null, 'no such user', p_ip, p_user_agent);
    return jsonb_build_object(
      'ok', false, 'code', 'INVALID_CREDENTIALS',
      'message', 'Email or password is wrong.');
  end if;

  -- Locked means locked. Inventory shipped a lockout that counted
  -- failures and let the right password straight through anyway;
  -- the check has to come BEFORE the password is considered.
  if c.locked_until is not null and c.locked_until > now() then
    perform ops.audit('auth.locked_out', 'user', u.id::text,
                      null, null, 'attempt while locked', p_ip, p_user_agent);
    return jsonb_build_object(
      'ok', false, 'code', 'LOCKED_OUT',
      'message', 'Too many attempts. Try again after '
                 || to_char(c.locked_until, 'HH24:MI') || '.',
      'retry_after', greatest(1, ceil(extract(epoch from (c.locked_until - now())))));
  end if;

  if not p_password_ok then
    update identity.credential
       set failed_count = failed_count + 1,
           locked_until = case when failed_count + 1 >= 5
                               then now() + interval '15 minutes' else null end
     where user_id = u.id;

    perform ops.audit('auth.sign_in_failed', 'user', u.id::text,
                      null, null, 'wrong password', p_ip, p_user_agent);
    return jsonb_build_object(
      'ok', false, 'code', 'INVALID_CREDENTIALS',
      'message', 'Email or password is wrong.');
  end if;

  if u.status <> 'ACTIVE' then
    perform ops.audit('auth.sign_in_failed', 'user', u.id::text,
                      null, null, 'account ' || u.status, p_ip, p_user_agent);
    return jsonb_build_object(
      'ok', false, 'code', 'ACCOUNT_' || u.status,
      'message', 'This account cannot sign in.');
  end if;

  update identity.credential
     set failed_count = 0, locked_until = null
   where user_id = u.id;

  insert into identity.session (user_id, token_hash, expires_at, ip, user_agent)
  values (u.id, p_token_hash, now() + make_interval(secs => p_ttl_seconds),
          nullif(p_ip, '')::inet, p_user_agent)
  returning id into v_session;

  perform ops.audit('auth.signed_in', 'user', u.id::text,
                    null, jsonb_build_object('session_id', v_session),
                    null, p_ip, p_user_agent);

  return jsonb_build_object('ok', true, 'claims', jsonb_build_object(
    'sub',            u.id,
    'role',           u.role,
    'actor_kind',     'USER',
    'email',          u.email,
    'full_name',      u.full_name,
    'session_id',     v_session,
    'location_codes', to_jsonb(u.location_codes),
    'must_change_password', u.must_change_password,
    'permissions',    to_jsonb(identity.permissions_for(u.role))));
end $$;

/**
 * Resolve a session cookie to claims.
 *
 * Returns null for expired, revoked, unknown or suspended. The caller
 * cannot tell which, and does not need to.
 */
create or replace function identity.resolve_session(p_token_hash text)
returns jsonb
language plpgsql security definer
set search_path = identity, ops, public, extensions
as $$
declare
  s identity.session%rowtype;
  u identity.app_user%rowtype;
begin
  select * into s from identity.session
   where token_hash = p_token_hash
     and revoked_at is null
     and expires_at > now();
  if s.id is null then return null; end if;

  select * into u from identity.app_user where id = s.user_id;
  if u.id is null or u.status <> 'ACTIVE' then return null; end if;

  update identity.session set last_seen_at = now() where id = s.id;

  return jsonb_build_object(
    'sub',            u.id,
    'role',           u.role,
    'actor_kind',     'USER',
    'email',          u.email,
    'full_name',      u.full_name,
    'session_id',     s.id,
    'location_codes', to_jsonb(u.location_codes),
    'must_change_password', u.must_change_password,
    'permissions',    to_jsonb(identity.permissions_for(u.role)));
end $$;

create or replace function identity.close_session(p_token_hash text)
returns boolean
language plpgsql security definer
set search_path = identity, ops, public, extensions
as $$
declare v_id uuid;
begin
  update identity.session set revoked_at = now()
   where token_hash = p_token_hash and revoked_at is null
  returning id into v_id;

  if v_id is not null then
    perform ops.audit('auth.signed_out', 'session', v_id::text);
  end if;
  return v_id is not null;
end $$;

/** Create a user. Admin only, and audited with the role granted. */
create or replace function identity.create_user(
  p_email    citext,
  p_name     text,
  p_role     text,
  p_hash     text,
  p_locations text[] default '{}',
  p_must_change boolean default true
) returns uuid
language plpgsql security definer
set search_path = identity, ops, public, extensions
as $$
declare v_id uuid;
begin
  if ops.current_role_name() not in ('admin','system') then
    raise exception 'FORBIDDEN_ROLE: only an admin may create a user'
      using errcode = '42501';
  end if;

  insert into identity.app_user (email, full_name, role, location_codes, must_change_password)
  values (p_email, p_name, p_role, p_locations, p_must_change)
  returning id into v_id;

  insert into identity.credential (user_id, password_hash) values (v_id, p_hash);

  perform ops.audit('user.created', 'user', v_id::text, null,
    jsonb_build_object('email', p_email, 'role', p_role, 'locations', p_locations));

  return v_id;
end $$;

create or replace function identity.set_password(p_user_id uuid, p_hash text)
returns void
language plpgsql security definer
set search_path = identity, ops, public, extensions
as $$
begin
  if ops.current_role_name() not in ('admin','system')
     and ops.current_actor_id() is distinct from p_user_id then
    raise exception 'FORBIDDEN: you may only change your own password'
      using errcode = '42501';
  end if;

  update identity.credential
     set password_hash = p_hash, rotated_at = now(),
         failed_count = 0, locked_until = null
   where user_id = p_user_id;

  update identity.app_user set must_change_password = false, updated_at = now()
   where id = p_user_id;

  -- Changing a password invalidates every other session. A password
  -- change that leaves the attacker logged in has not changed much.
  update identity.session set revoked_at = now()
   where user_id = p_user_id and revoked_at is null
     and id is distinct from nullif(ops.current_claims() ->> 'session_id','')::uuid;

  perform ops.audit('auth.password_changed', 'user', p_user_id::text);
end $$;

-- ─────────────── row-level security ───────────────

alter table identity.app_user       enable row level security;
alter table identity.credential     enable row level security;
alter table identity.session        enable row level security;
alter table identity.role_permission enable row level security;

-- You can always see yourself. Beyond that it takes a permission.
create policy app_user_read on identity.app_user
  for select using (
    id = ops.current_actor_id()
    or identity.has_permission('users:read'));

create policy app_user_write on identity.app_user
  for all using (identity.has_permission('users:write'))
  with check (identity.has_permission('users:write'));

-- Nobody reads password hashes through SQL. The functions above are
-- SECURITY DEFINER and are the only path.
create policy credential_none on identity.credential
  for select using (false);

create policy session_read on identity.session
  for select using (
    user_id = ops.current_actor_id()
    or identity.has_permission('users:read'));

create policy role_permission_read on identity.role_permission
  for select using (true);
