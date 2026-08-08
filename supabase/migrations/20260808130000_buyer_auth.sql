-- 0005 — buyers become anonymous auth users
--
-- Ticket 01 put buyers on the `anon` Postgres role. That forced a
-- SECURITY DEFINER function to fetch one order, and a function is not a
-- subscription, so the buyer status page had to poll. Realtime respects RLS and
-- pushes a row only to clients whose policies let them read it, so what is
-- needed is a per-row check. `buyer_id = auth.uid()` is one.
--
-- A buyer now calls signInAnonymously() on first visit. That user holds the
-- `authenticated` role and carries an `is_anonymous` claim in its JWT.
--
-- The hazard this creates, and most of what follows: permissive policies combine
-- with OR, and a buyer is now `authenticated` like every dashboard user. Every
-- tenant-scoped table therefore gets a RESTRICTIVE policy — restrictive policies
-- combine with AND and cannot be widened by a permissive one added later — that
-- confines an anonymous session to exactly the public catalogue and its own
-- orders.
--
-- Requires: Authentication -> Sign In / Up -> Anonymous sign-ins enabled.

-- ===========================================================================
-- 1. orders.buyer_id
-- ===========================================================================

alter table public.orders
  add column buyer_id uuid references auth.users (id) on delete set null;

comment on column public.orders.buyer_id is
  'The buyer''s anonymous auth user. ON DELETE SET NULL: anonymous users accumulate and get cleaned up periodically, and that cleanup must not take the seller''s order history with it.';

create index orders_buyer_idx on public.orders (buyer_id);

-- ===========================================================================
-- 2. Reference uniqueness
-- ===========================================================================

-- The seller matches an incoming WhatsApp message against this code. Two live
-- orders holding A47 is a wrong parcel, not a cosmetic clash.
alter table public.orders
  add constraint orders_tenant_reference_unique unique (tenant_id, reference);

-- ===========================================================================
-- 3. Tear down the anon-role buyer path
-- ===========================================================================

drop policy if exists orders_anon_insert on public.orders;
drop policy if exists order_items_anon_insert on public.order_items;

revoke all on public.orders from anon;
revoke all on public.order_items from anon;

-- No longer reachable, and no longer wanted: the buyer reads its own orders
-- through a policy now, which is what makes Realtime work.
drop function if exists public.get_order(uuid);

-- Only the (now removed) anonymous order_items insert needed this.
revoke execute on function public.order_belongs_to_tenant(uuid, uuid) from anon;

-- ===========================================================================
-- 4. Helper functions
-- ===========================================================================

-- The `is_anonymous` claim is set by GoTrue on sessions created via
-- signInAnonymously(). Absent for dashboard logins, and absent for the `anon`
-- role's own key, so coalesce to false: "not proven anonymous" must never mean
-- "treat as anonymous" in a policy that grants reach.
create or replace function public.is_anonymous_user()
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
$$;

comment on function public.is_anonymous_user() is
  'True for a buyer session created by signInAnonymously(). Anonymous users hold the authenticated role, so this is the only thing distinguishing them from a dashboard login.';

-- Used by the order_items policies. SECURITY DEFINER so the ownership check on
-- the parent order does not re-enter the orders policies for every line.
create or replace function public.is_buyer_order(p_order_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.orders o
    where o.id = p_order_id
      and o.buyer_id = (select auth.uid())
  )
$$;

-- Used by the buyer-facing variants policies, for the same reason: the parent
-- item's active flag should not be a nested RLS evaluation per variant row.
create or replace function public.item_is_active(p_item_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.items i
    where i.id = p_item_id and i.active
  )
$$;

revoke execute on function public.is_anonymous_user() from public;
revoke execute on function public.is_buyer_order(uuid) from public;
revoke execute on function public.item_is_active(uuid) from public;

grant execute on function public.is_anonymous_user() to authenticated;
grant execute on function public.is_buyer_order(uuid) to authenticated;
grant execute on function public.item_is_active(uuid) to anon, authenticated;

-- ===========================================================================
-- 5. Buyer policies — orders and order_items
-- ===========================================================================

-- Keyed on identity (buyer_id = auth.uid()), not on anonymity. If buyers ever
-- get real accounts, this policy does not change.
create policy orders_buyer_select on public.orders
  for select to authenticated
  using (buyer_id = (select auth.uid()));

-- RLS WITH CHECK can constrain columns in a way a GRANT cannot express: the
-- buyer holds the `authenticated` role and therefore an INSERT grant on every
-- column of orders, including `status`. Revenue metrics run off `completed`,
-- so the ceiling is pinned here instead.
create policy orders_buyer_insert on public.orders
  for insert to authenticated
  with check (
    buyer_id = (select auth.uid())
    and public.is_active_tenant(tenant_id)
    and status = 'sent'
    and confirmed_at is null
    and completed_at is null
  );

-- No UPDATE and no DELETE policy for buyers, deliberately. Once sent, an order
-- is the seller's to move.

create policy order_items_buyer_select on public.order_items
  for select to authenticated
  using (public.is_buyer_order(order_id));

create policy order_items_buyer_insert on public.order_items
  for insert to authenticated
  with check (
    public.is_buyer_order(order_id)
    and public.order_belongs_to_tenant(order_id, tenant_id)
    and qty_confirmed is null   -- the weighed quantity is the seller's to write
  );

-- ===========================================================================
-- 6. Buyer policies — public catalogue
-- ===========================================================================

-- A signed-in buyer sends a JWT on every request, so the storefront reads the
-- catalogue as `authenticated`, not as `anon` — without these it would see an
-- empty shop. The ticket-01 `anon` policies stay as they are, so a storefront
-- that reads the catalogue on a separate unauthenticated client also still
-- works.
--
-- Each of these is gated on is_anonymous_user(). That is not decoration: a
-- permissive policy saying "any authenticated user may read active items" would
-- OR with the tenant policy and hand every dashboard user the whole database's
-- catalogue. The gate keeps it to buyer sessions.

create policy tenants_buyer_select on public.tenants
  for select to authenticated
  using (public.is_anonymous_user() and active);

create policy categories_buyer_select on public.categories
  for select to authenticated
  using (
    public.is_anonymous_user()
    and active
    and public.is_active_tenant(tenant_id)
  );

create policy items_buyer_select on public.items
  for select to authenticated
  using (
    public.is_anonymous_user()
    and active
    and public.is_active_tenant(tenant_id)
  );

create policy variants_buyer_select on public.variants
  for select to authenticated
  using (
    public.is_anonymous_user()
    and public.is_active_tenant(tenant_id)
    and public.item_is_active(item_id)
  );

-- ===========================================================================
-- 7. Restrictive policies — the belt to the tenant lookup's braces
-- ===========================================================================

-- Restrictive policies AND with everything else. Written as `for all`, they
-- also cover the write paths, so an anonymous session cannot insert or update
-- a catalogue row even if some future permissive policy says it may.
--
-- Read as: "unless you are an anonymous buyer, this policy has no opinion."

create policy tenants_not_anonymous on public.tenants
  as restrictive for all to authenticated
  using (not public.is_anonymous_user() or active)
  with check (not public.is_anonymous_user());

create policy tenant_users_not_anonymous on public.tenant_users
  as restrictive for all to authenticated
  using (not public.is_anonymous_user())
  with check (not public.is_anonymous_user());

create policy categories_not_anonymous on public.categories
  as restrictive for all to authenticated
  using (
    not public.is_anonymous_user()
    or (active and public.is_active_tenant(tenant_id))
  )
  with check (not public.is_anonymous_user());

create policy items_not_anonymous on public.items
  as restrictive for all to authenticated
  using (
    not public.is_anonymous_user()
    or (active and public.is_active_tenant(tenant_id))
  )
  with check (not public.is_anonymous_user());

create policy variants_not_anonymous on public.variants
  as restrictive for all to authenticated
  using (
    not public.is_anonymous_user()
    or (public.is_active_tenant(tenant_id) and public.item_is_active(item_id))
  )
  with check (not public.is_anonymous_user());

-- The two that must let the buyer through: an anonymous session reaches only
-- rows it owns, and may only write rows it will own.
create policy orders_not_anonymous on public.orders
  as restrictive for all to authenticated
  using (
    not public.is_anonymous_user()
    or buyer_id = (select auth.uid())
  )
  with check (
    not public.is_anonymous_user()
    or buyer_id = (select auth.uid())
  );

create policy order_items_not_anonymous on public.order_items
  as restrictive for all to authenticated
  using (
    not public.is_anonymous_user()
    or public.is_buyer_order(order_id)
  )
  with check (
    not public.is_anonymous_user()
    or public.is_buyer_order(order_id)
  );

create policy import_batches_not_anonymous on public.import_batches
  as restrictive for all to authenticated
  using (not public.is_anonymous_user())
  with check (not public.is_anonymous_user());

-- ===========================================================================
-- 8. Realtime
-- ===========================================================================

-- 0002 added both tables; this is the idempotent confirmation the ticket asks
-- for, and it is what makes the buyer status page a subscription rather than a
-- poll. Postgres Changes re-checks RLS per subscriber, so a buyer receives
-- updates to their own order only.
--
-- Replica identity is left at the default (primary key). UPDATE events carry
-- the full new row and are filtered correctly; DELETE events cannot be
-- RLS-filtered without REPLICA IDENTITY FULL and so are not delivered. Nothing
-- deletes orders, so that is left alone rather than paying the WAL cost.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'orders'
  ) then
    alter publication supabase_realtime add table public.orders;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'order_items'
  ) then
    alter publication supabase_realtime add table public.order_items;
  end if;
end
$$;
