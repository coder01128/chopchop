-- 0003 — revoke inherited privileges, then re-grant exactly what is intended
--
-- The grants in 0002 were additive, and additive grants cannot narrow anything.
-- The project's default privileges had already handed `anon` and `authenticated`
-- broader table-level rights than this schema wants — the column-level SELECT on
-- `tenants` in 0002 was a no-op on top of an existing table-level SELECT, and
-- `anon` held privileges on tables it has no policy for at all.
--
-- RLS was still holding the line in every case (no policy means no rows), but
-- one layer is not the design. A buyer should be unable to name the table, not
-- merely get an empty result from it.
--
-- This migration is written to be idempotent and independent of whatever the
-- defaults happen to be: strip everything from the API roles on all eight
-- tables, then grant back precisely the surface described in SCHEMA.md.

-- ---------------------------------------------------------------------------
-- Strip
-- ---------------------------------------------------------------------------

revoke all on
  public.tenants,
  public.tenant_users,
  public.categories,
  public.items,
  public.variants,
  public.orders,
  public.order_items,
  public.import_batches
from anon, authenticated, public;

-- Stop the defaults re-arming this for anything added later. Explicit grants in
-- a migration remain the only way a table reaches the Data API.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Re-grant — authenticated (dashboard)
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- Re-grant — anon (storefront)
-- ---------------------------------------------------------------------------

-- Column-level, and it bites now: `created_at` is operational, not public.
-- Everything else on the row is either already on the storefront or required to
-- render it — the product modal is generated from attribute_schema, quantities
-- are formatted from sale_mode, and which stock signal to show depends on
-- stock_mode.
grant select (
  id, slug, name, whatsapp_number, branding, attribute_schema,
  sale_mode, stock_mode, fulfilment_mode, active
) on public.tenants to anon;

grant select on public.categories to anon;
grant select on public.items to anon;
grant select on public.variants to anon;

-- Order creation only. No SELECT: the status page goes through get_order().
-- The column list is what stops a buyer inserting status = 'completed' or
-- writing their own qty_confirmed.
grant insert (
  tenant_id, reference, customer_name, customer_phone, fulfilment, notes, total
) on public.orders to anon;

grant insert (
  tenant_id, order_id, variant_id, name_snapshot, price_snapshot, qty, line_total
) on public.order_items to anon;

-- anon holds nothing whatsoever on tenant_users and import_batches.

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------

revoke execute on function public.user_tenant_ids() from public, anon;
revoke execute on function public.is_active_tenant(uuid) from public;
revoke execute on function public.order_belongs_to_tenant(uuid, uuid) from public;
revoke execute on function public.get_order(uuid) from public;

grant execute on function public.user_tenant_ids() to authenticated;
grant execute on function public.is_active_tenant(uuid) to anon, authenticated;
grant execute on function public.order_belongs_to_tenant(uuid, uuid) to anon, authenticated;
grant execute on function public.get_order(uuid) to anon, authenticated;
