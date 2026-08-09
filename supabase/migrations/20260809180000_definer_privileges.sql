-- 0010 — record who can execute each SECURITY DEFINER function
--
-- 0009 added public.security_definer_functions so a test could assert the list.
-- The list alone is the wrong altitude, though: SECURITY DEFINER on its own is
-- not the hazard. Five of the six entries are definer precisely so an RLS policy
-- can terminate, and they are meant to stay that way.
--
-- What made next_order_reference a leak was the pair:
--
--   SECURITY DEFINER  — runs as the table owner, exempt from RLS
--   granted to a Data API role — so a storefront visitor can call it directly
--
-- Either alone is ordinary. Together they are a function that reads anything,
-- reachable by anyone holding an anonymous session, with arguments the caller
-- chooses. That is the shape to watch for, so the view records it.
--
-- `has_function_privilege` answers this without calling anything, which matters
-- for a function nobody has read: an audit that has to invoke its subject is not
-- an audit. It also accounts for grants made to PUBLIC and through role
-- membership, so it cannot be fooled by a privilege arriving indirectly.

create or replace view public.security_definer_functions as
  select
    p.proname::text                           as function_name,
    pg_get_function_identity_arguments(p.oid)  as arguments,
    p.prosecdef                                as security_definer,
    -- to_regrole returns null rather than raising if a role is absent, so this
    -- view still answers on a database where the Data API roles were never
    -- created. Absent role means no privilege, hence the coalesce.
    coalesce(has_function_privilege(to_regrole('anon'), p.oid, 'EXECUTE'), false)
      as anon_can_execute,
    coalesce(has_function_privilege(to_regrole('authenticated'), p.oid, 'EXECUTE'), false)
      as authenticated_can_execute
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prosecdef;

comment on view public.security_definer_functions is
  'Every SECURITY DEFINER function in the public schema, with whether anon and authenticated hold EXECUTE. Definer alone is ordinary — several RLS helpers must be. Definer AND callable by a Data API role is the combination that let next_order_reference hand any buyer session any tenant''s order count. Read by tests/place-order-rpc.test.ts. Granted to service_role only.';

-- Restated rather than relied upon: `create or replace view` keeps the existing
-- grants, but the whole point of this object is that its own reach is obvious
-- from the migration that defines it.
revoke all on public.security_definer_functions from public, anon, authenticated;
grant select on public.security_definer_functions to service_role;
