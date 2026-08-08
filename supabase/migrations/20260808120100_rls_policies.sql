-- 0002 — RLS, helper functions and grants
--
-- RLS is enabled on all eight tables. No exceptions, import_batches included.
-- A table without RLS is a data breach with a delay on it.
--
-- Two audiences:
--   authenticated  dashboard users. Every operation is restricted to rows whose
--                  tenant_id appears in the caller's tenant_users rows.
--   anon           storefront buyers. Read-only on the public catalogue, plus
--                  INSERT of an order. Nothing else, ever.
--
-- This project's tables are NOT auto-exposed to the Data API roles (see
-- supabase/config.toml — auto_expose_new_tables is unset, matching the new
-- cloud default), so every grant below is deliberate. RLS decides which rows;
-- the grants decide which tables and which columns.

-- ===========================================================================
-- Helper functions
-- ===========================================================================

-- Why SECURITY DEFINER:
--
-- The RLS policy on tenant_users has to ask "which tenants does this user
-- belong to?", and the only place that answer lives is tenant_users itself.
-- Written inline, the policy reads the table it is guarding, which re-invokes
-- the same policy while it is still being evaluated — Postgres aborts with
-- 42P17 infinite recursion. The same lookup is used by every other table's
-- policy, so it would also mean one extra RLS evaluation per row everywhere.
--
-- A SECURITY DEFINER function executes as its owner (postgres). The owner is
-- the table owner, and a table owner is not subject to that table's RLS, so the
-- lookup terminates. search_path is pinned to public, pg_temp so a caller
-- cannot create their own `tenant_users` in a schema earlier on the path and
-- have this function read it instead — an unpinned search_path in a definer
-- function is a privilege-escalation hole.
create or replace function public.user_tenant_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select tu.tenant_id
  from public.tenant_users tu
  where tu.user_id = (select auth.uid())
$$;

comment on function public.user_tenant_ids() is
  'Tenants the calling auth user belongs to. SECURITY DEFINER to break RLS recursion on tenant_users.';

-- Anonymous policies need to know whether a tenant is active. anon can read
-- tenants, but only active ones — so a plain sub-select would be circular in
-- the same way. Definer again, for the same reason.
create or replace function public.is_active_tenant(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.tenants t
    where t.id = p_tenant_id and t.active
  )
$$;

-- Used by the anonymous INSERT check on order_items: the line must belong to
-- the same order and tenant the buyer just created. anon has no SELECT on
-- orders, so this lookup cannot be done inline either.
create or replace function public.order_belongs_to_tenant(
  p_order_id uuid,
  p_tenant_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.orders o
    where o.id = p_order_id and o.tenant_id = p_tenant_id
  )
$$;

-- Buyer status page.
--
-- SCHEMA.md requires anonymous read of a single order by id and never a list.
-- RLS cannot express that: a policy is evaluated per row with no knowledge of
-- the caller's filter, so any policy permissive enough to return one order by
-- id is also permissive enough to return all of them unfiltered. The only
-- honest implementation is to grant anon no SELECT on orders at all and hand
-- them this function, which takes the id as an argument and can return exactly
-- one order. The id is a v4 uuid, so it is the capability.
create or replace function public.get_order(p_order_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id',             o.id,
    'tenant_id',      o.tenant_id,
    'reference',      o.reference,
    'customer_name',  o.customer_name,
    'customer_phone', o.customer_phone,
    'fulfilment',     o.fulfilment,
    'notes',          o.notes,
    'status',         o.status,
    'total',          o.total,
    'created_at',     o.created_at,
    'confirmed_at',   o.confirmed_at,
    'completed_at',   o.completed_at,
    'items', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id',             oi.id,
            'variant_id',     oi.variant_id,
            'name_snapshot',  oi.name_snapshot,
            'price_snapshot', oi.price_snapshot,
            'qty',            oi.qty,
            'qty_confirmed',  oi.qty_confirmed,
            'line_total',     oi.line_total
          )
          order by oi.name_snapshot
        )
        from public.order_items oi
        where oi.order_id = o.id
      ),
      '[]'::jsonb
    )
  )
  from public.orders o
  join public.tenants t on t.id = o.tenant_id and t.active
  where o.id = p_order_id
$$;

comment on function public.get_order(uuid) is
  'Single order plus its lines, by id. The anonymous buyer status page reads through this instead of a SELECT policy, because RLS cannot forbid listing.';

-- ===========================================================================
-- Enable RLS — all eight tables
-- ===========================================================================

alter table public.tenants        enable row level security;
alter table public.tenant_users   enable row level security;
alter table public.categories     enable row level security;
alter table public.items          enable row level security;
alter table public.variants       enable row level security;
alter table public.orders         enable row level security;
alter table public.order_items    enable row level security;
alter table public.import_batches enable row level security;

-- ===========================================================================
-- Policies — authenticated (dashboard)
-- ===========================================================================

-- tenants is keyed on id, not tenant_id; everything else is uniform.
create policy tenants_authenticated_all on public.tenants
  for all to authenticated
  using (id in (select public.user_tenant_ids()))
  with check (id in (select public.user_tenant_ids()));

create policy tenant_users_authenticated_all on public.tenant_users
  for all to authenticated
  using (tenant_id in (select public.user_tenant_ids()))
  with check (tenant_id in (select public.user_tenant_ids()));

create policy categories_authenticated_all on public.categories
  for all to authenticated
  using (tenant_id in (select public.user_tenant_ids()))
  with check (tenant_id in (select public.user_tenant_ids()));

create policy items_authenticated_all on public.items
  for all to authenticated
  using (tenant_id in (select public.user_tenant_ids()))
  with check (tenant_id in (select public.user_tenant_ids()));

create policy variants_authenticated_all on public.variants
  for all to authenticated
  using (tenant_id in (select public.user_tenant_ids()))
  with check (tenant_id in (select public.user_tenant_ids()));

create policy orders_authenticated_all on public.orders
  for all to authenticated
  using (tenant_id in (select public.user_tenant_ids()))
  with check (tenant_id in (select public.user_tenant_ids()));

create policy order_items_authenticated_all on public.order_items
  for all to authenticated
  using (tenant_id in (select public.user_tenant_ids()))
  with check (tenant_id in (select public.user_tenant_ids()));

create policy import_batches_authenticated_all on public.import_batches
  for all to authenticated
  using (tenant_id in (select public.user_tenant_ids()))
  with check (tenant_id in (select public.user_tenant_ids()));

-- ===========================================================================
-- Policies — anon (storefront)
-- ===========================================================================

-- A menu is public information; nothing else is.

create policy tenants_anon_select on public.tenants
  for select to anon
  using (active);

create policy categories_anon_select on public.categories
  for select to anon
  using (active and public.is_active_tenant(tenant_id));

create policy items_anon_select on public.items
  for select to anon
  using (active and public.is_active_tenant(tenant_id));

-- variants have no `active` column — `available` is the in-stock toggle and a
-- sold-out variant must still render, greyed out. The gate is therefore the
-- parent item being active, not the variant being available.
create policy variants_anon_select on public.variants
  for select to anon
  using (
    public.is_active_tenant(tenant_id)
    and exists (
      select 1 from public.items i
      where i.id = variants.item_id
        and i.tenant_id = variants.tenant_id
        and i.active
    )
  );

-- Order creation. INSERT only — there is no anon SELECT policy on orders or
-- order_items, so a buyer can write an order and then never read the table
-- back. The status page goes through public.get_order().
create policy orders_anon_insert on public.orders
  for insert to anon
  with check (public.is_active_tenant(tenant_id));

create policy order_items_anon_insert on public.order_items
  for insert to anon
  with check (
    public.is_active_tenant(tenant_id)
    and public.order_belongs_to_tenant(order_id, tenant_id)
  );

-- ===========================================================================
-- Grants
-- ===========================================================================

grant usage on schema public to anon, authenticated;

-- Dashboard: full CRUD on its own tenant's rows, gated by the policies above.
grant select, insert, update, delete on
  public.tenants,
  public.tenant_users,
  public.categories,
  public.items,
  public.variants,
  public.orders,
  public.order_items,
  public.import_batches
to authenticated;

-- Storefront read. Column-level on tenants: `created_at` is operational, not
-- public. Everything else on the row is either already on the storefront
-- (name, branding, whatsapp_number) or required to render it at all — the
-- product modal is generated from attribute_schema, prices and quantities are
-- formatted from sale_mode, and the stock signal to show depends on stock_mode.
grant select (
  id, slug, name, whatsapp_number, branding, attribute_schema,
  sale_mode, stock_mode, fulfilment_mode, active
) on public.tenants to anon;

grant select on public.categories to anon;
grant select on public.items to anon;
grant select on public.variants to anon;

-- Order creation, column-level: a buyer supplies the cart and their contact
-- details. They do not get to set status, confirmed_at, completed_at or
-- qty_confirmed — those are the seller's, and a column grant is the only thing
-- that actually stops an INSERT setting them.
grant insert (
  tenant_id, reference, customer_name, customer_phone, fulfilment, notes, total
) on public.orders to anon;

grant insert (
  tenant_id, order_id, variant_id, name_snapshot, price_snapshot, qty, line_total
) on public.order_items to anon;

-- Explicitly: anon gets nothing at all on tenant_users or import_batches.

-- Functions. execute is granted to public by default on creation, so revoke
-- first and hand it back only where it is wanted.
revoke execute on function public.user_tenant_ids() from public;
revoke execute on function public.is_active_tenant(uuid) from public;
revoke execute on function public.order_belongs_to_tenant(uuid, uuid) from public;
revoke execute on function public.get_order(uuid) from public;

grant execute on function public.user_tenant_ids() to authenticated;
grant execute on function public.is_active_tenant(uuid) to anon, authenticated;
grant execute on function public.order_belongs_to_tenant(uuid, uuid) to anon, authenticated;
grant execute on function public.get_order(uuid) to anon, authenticated;

-- ===========================================================================
-- Realtime
-- ===========================================================================

-- The dashboard order queue subscribes to this as an authenticated user, so
-- the authenticated policy above gates it. The buyer status page cannot use
-- Realtime while anon has no SELECT policy on orders — it polls get_order()
-- instead. Noted here rather than silently working around it.
alter publication supabase_realtime add table public.orders;
alter publication supabase_realtime add table public.order_items;
