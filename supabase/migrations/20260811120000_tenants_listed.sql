-- ---------------------------------------------------------------------------
-- tenants.listed — may this business appear in a ChopChop-wide directory?
--
-- Nothing renders a directory. This column exists so that every client, from
-- the first one, is already in the data with an answer they were asked for —
-- rather than a listing appearing later and a client discovering it was done
-- to them. `RUNBOOK.md` has the sentence Brad says at onboarding.
--
-- Default true: the clients this is sold to are businesses that want to be
-- found. A seller who does not turns it off in Settings, and that is one tap
-- rather than a support conversation.
-- ---------------------------------------------------------------------------

alter table public.tenants
  add column listed boolean not null default true;

comment on column public.tenants.listed is
  'Whether this business may appear in a ChopChop-wide directory. Nothing renders one yet. Deliberately not granted to anon — see below.';

-- No grant to `anon`, and that is the point.
--
-- `authenticated` holds a table-level grant on tenants (migration
-- 20260808120200), so the seller's own toggle works with no change here. The
-- `anon` grant is column-level and lists nine columns; `listed` is not one of
-- them, so the storefront cannot read it.
--
-- Granting it now would ship the capability ahead of the surface that
-- justifies it, which is the mistake HANDOFF records twice. When the directory
-- is built, that ticket adds `listed` to the anon column grant AND to
-- `PUBLIC_TENANT_COLUMNS` in packages/shared/src/tenant.ts — both, or the
-- storefront's tenant query fails on a column it cannot read.
