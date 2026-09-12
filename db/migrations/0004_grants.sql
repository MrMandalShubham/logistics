-- ============================================================
-- 0004 - What `authenticated` may touch
--
-- Runs last, because a grant needs the table to exist.
--
-- ── Grants and RLS do different jobs ──
--
-- A grant says "this role may issue SELECT against this table at
-- all". A policy says "and these are the rows it gets". Both are
-- required: with no grant the query is refused outright; with a grant
-- and no policy it returns nothing at all, which looks exactly like
-- an empty table and has cost more than one team an afternoon.
--
-- db-verify asserts every table has RLS enabled AND at least one
-- policy, so the second failure mode cannot reach production quietly.
--
-- ── Why no DELETE anywhere ──
--
-- Nothing in logistics is deleted. A delivery that did not happen is
-- a delivery with a terminal state, a rider who left is a deactivated
-- rider, and an audit row is forever. Withholding the privilege means
-- a careless DELETE in a later phase fails loudly instead of quietly
-- removing history.
-- ============================================================

grant usage on schema ops         to authenticated;
grant usage on schema identity    to authenticated;
grant usage on schema integration to authenticated;

grant select, insert, update on all tables in schema ops         to authenticated;
grant select, insert, update on all tables in schema identity    to authenticated;
grant select, insert, update on all tables in schema integration to authenticated;

grant usage on all sequences in schema ops         to authenticated;
grant usage on all sequences in schema identity    to authenticated;
grant usage on all sequences in schema integration to authenticated;

grant execute on all functions in schema ops         to authenticated;
grant execute on all functions in schema identity    to authenticated;
grant execute on all functions in schema integration to authenticated;

-- Tables added by a later migration inherit these, so Phase 2 does
-- not have to remember. Forgetting a grant produces "permission
-- denied for table delivery" in production, which is a bad way to
-- find out.
alter default privileges in schema ops
  grant select, insert, update on tables to authenticated;
alter default privileges in schema identity
  grant select, insert, update on tables to authenticated;
alter default privileges in schema integration
  grant select, insert, update on tables to authenticated;

alter default privileges in schema ops         grant execute on functions to authenticated;
alter default privileges in schema identity    grant execute on functions to authenticated;
alter default privileges in schema integration grant execute on functions to authenticated;

-- The migration ledger is infrastructure. The application never reads
-- it, and a request that could write it could lie about what schema
-- it is running against.
revoke all on ops.schema_migration from authenticated;

-- Password hashes: the RLS policy already returns no rows, and
-- withholding the privilege means even a policy mistake in a later
-- migration cannot expose them.
revoke all on identity.credential from authenticated;
