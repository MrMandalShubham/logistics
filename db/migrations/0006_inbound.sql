-- ============================================================
-- 0006 - Inbound events: every arrival, accepted or not
--
-- ── Why a rejection is stored, not just refused ──
--
-- No order in this estate carries a delivery address yet (open
-- question Q1). Until Grocery sends one, every real order will be
-- refused at ingest. If a refusal were only an HTTP 422, those orders
-- would be gone -- and the day the address arrives, there would be no
-- backlog to replay, only a gap nobody can reconstruct.
--
-- So every inbound request is recorded with the payload exactly as it
-- arrived. A refusal becomes a thing an admin can look at, fix
-- upstream, and replay.
--
-- ── Why a 4xx is never retried ──
--
-- A malformed payload will be malformed on the tenth attempt. Retry
-- is for OUR failures, not the sender's. A poison message that
-- retries forever buries the one delivery that mattered under ten
-- thousand copies of the one that never could.
-- ============================================================

create table integration.inbound_event (
  id       uuid primary key default gen_random_uuid(),

  source   text not null,                  -- 'GROCERY'
  event    text not null,                  -- 'order.delivery_ready'
  event_id text,                           -- the sender's id, if any

  external_order_id text,

  -- Exactly what arrived, before any interpretation. This is what a
  -- replay re-runs, so it must not be a cleaned-up version.
  payload jsonb not null,

  status text not null default 'ACCEPTED'
           check (status in ('ACCEPTED','REJECTED','DEAD','REPLAYED')),

  error_code   text,
  error_detail text,
  attempts     integer not null default 1,

  correlation_id text,
  received_at    timestamptz not null default now(),
  resolved_at    timestamptz
);

create index inbound_event_status on integration.inbound_event
  (status, received_at desc);
create index inbound_event_order  on integration.inbound_event
  (external_order_id) where external_order_id is not null;

comment on column integration.inbound_event.payload is
  'The raw request body, including customer PII. Admin-only by policy; the log redactor covers these field names.';

/**
 * Record an arrival.
 *
 * Definer, and it never raises: a failure to write the journal must
 * not turn a successful ingest into an error, nor mask the real
 * reason a bad one was refused.
 */
create or replace function integration.record_inbound(
  p_source  text,
  p_event   text,
  p_event_id text,
  p_external_order_id text,
  p_payload jsonb,
  p_status  text,
  p_error_code text default null,
  p_error_detail text default null
) returns uuid
language plpgsql security definer
set search_path = integration, ops, public, extensions
as $$
declare v_id uuid;
begin
  insert into integration.inbound_event
    (source, event, event_id, external_order_id, payload, status,
     error_code, error_detail, correlation_id,
     resolved_at)
  values
    (p_source, p_event, p_event_id, p_external_order_id, p_payload, p_status,
     p_error_code, p_error_detail, ops.current_claims() ->> 'correlation_id',
     case when p_status in ('ACCEPTED','REPLAYED') then now() else null end)
  returning id into v_id;

  perform ops.audit(
    case p_status when 'ACCEPTED' then 'ingest.accepted'
                  when 'REPLAYED' then 'ingest.replayed'
                  else 'ingest.rejected' end,
    'inbound_event', v_id::text, null,
    jsonb_build_object('order', p_external_order_id, 'error', p_error_code));

  return v_id;
exception when others then
  return null;
end $$;

/** Mark a rejected event as replayed, once its retry has succeeded. */
create or replace function integration.mark_replayed(p_id uuid)
returns void
language plpgsql security definer
set search_path = integration, ops, public, extensions
as $$
begin
  if not identity.has_permission('integration:retry') then
    raise exception 'FORBIDDEN: replaying an inbound event requires integration:retry'
      using errcode = '42501';
  end if;

  update integration.inbound_event
     set status = 'REPLAYED', attempts = attempts + 1, resolved_at = now()
   where id = p_id and status in ('REJECTED','DEAD');

  perform ops.audit('ingest.replayed', 'inbound_event', p_id::text);
end $$;

alter table integration.inbound_event enable row level security;

-- Admin only. The payload carries a customer's name, phone and
-- street address; this is the narrowest audience that can still do
-- the job.
create policy inbound_event_read on integration.inbound_event
  for select using (identity.has_permission('integration:read'));

-- ─────────────── permissions for this phase ───────────────

insert into identity.role_permission (role, permission) values
  ('admin',      'deliveries:read'),
  ('admin',      'deliveries:admit'),
  ('admin',      'deliveries:cancel'),
  ('admin',      'integration:read'),
  ('admin',      'integration:retry'),
  ('dispatcher', 'deliveries:read'),
  ('dispatcher', 'deliveries:admit')
on conflict do nothing;

-- A rider still holds only locations:read. Rider permissions arrive
-- in Phase 4 and are scoped to their own assignment, which does not
-- exist yet.
