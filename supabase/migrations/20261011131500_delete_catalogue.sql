-- delete_catalogue — wipe a tenant's whole catalogue in one transaction
--
-- Backs the "Delete all catalogue data" control in Settings. The use case is a
-- seller (or Brad, during onboarding) who imported the wrong price list and
-- wants a clean slate rather than deleting products one at a time.
--
-- What it removes:  categories, products (items), variants, pending/applied
--                   import_batches — all for the one tenant.
-- What it never touches: orders and order_items. Order history is the seller's
--                   record of what they sold, and revenue runs off it.
--
-- The catch is order_items.variant_id, which is ON DELETE RESTRICT. A variant
-- that appears in any order cannot be deleted, and neither can its product
-- (items -> variants is a cascade, and the cascade hits the restrict). Those
-- are handled the same way save_product handles a removal it cannot delete:
-- the variant is retired, and its product is hidden. They are reported back in
-- the result so the UI can say so, rather than claiming a clean slate that
-- isn't one.
--
-- Open orders block the whole operation. A seller halfway through fulfilling
-- an order must not have its lines retired underneath them — same rule the
-- single-variant removal dialog applies ('blocked' verdict), applied to all.
--
-- SECURITY INVOKER, deliberately and permanently — see save_product. Every
-- statement runs under the caller's RLS. The owner check below is on top of
-- RLS, not instead of it.
--
-- Storage is not reachable from SQL (deleting from storage.objects does not
-- remove the file). The client removes the tenant's photographs after this
-- returns, and this function clears every image_path so nothing points at a
-- file that is about to go.

create or replace function public.delete_catalogue(p_tenant_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_open_orders      integer;
  v_variants_deleted integer;
  v_variants_retired integer;
  v_items_deleted    integer;
  v_items_kept       integer;
  v_categories       integer;
  v_batches          integer;
begin
  if p_tenant_id is null then
    raise exception 'delete_catalogue: tenant_id is required' using errcode = '22004';
  end if;

  if p_tenant_id not in (select public.user_tenant_ids()) then
    raise exception 'delete_catalogue: caller does not belong to tenant %', p_tenant_id
      using errcode = '42501';
  end if;

  -- Wiping a catalogue is an owner decision. Staff can edit products; they
  -- cannot erase the shop.
  if not exists (
    select 1 from public.tenant_users tu
    where tu.tenant_id = p_tenant_id
      and tu.user_id = (select auth.uid())
      and tu.role = 'owner'
  ) then
    raise exception 'delete_catalogue: only an owner can delete the catalogue'
      using errcode = '42501';
  end if;

  select count(*) into v_open_orders
  from public.orders o
  where o.tenant_id = p_tenant_id
    and o.status in ('sent', 'received', 'confirmed', 'ready');

  if v_open_orders > 0 then
    -- 55000: object_not_in_prerequisite_state. The client keys off the code and
    -- reads the count out of the message.
    raise exception 'delete_catalogue: % open order(s)', v_open_orders using errcode = '55000';
  end if;

  -- 1. Variants in order history cannot be deleted. Retire them and drop their
  --    photo reference. Same state save_product leaves a retired variant in.
  update public.variants v
  set available  = false,
      retired_at = coalesce(v.retired_at, now()),
      image_path = null
  where v.tenant_id = p_tenant_id
    and exists (select 1 from public.order_items oi where oi.variant_id = v.id);
  get diagnostics v_variants_retired = row_count;

  -- 2. Everything else goes.
  delete from public.variants v
  where v.tenant_id = p_tenant_id
    and not exists (select 1 from public.order_items oi where oi.variant_id = v.id);
  get diagnostics v_variants_deleted = row_count;

  -- 3. Products that still hold a retired variant are kept, hidden, with no
  --    category and no photo. They exist only so order history still resolves.
  update public.items i
  set active      = false,
      category_id = null,
      image_path  = null,
      image_url   = null
  where i.tenant_id = p_tenant_id
    and exists (select 1 from public.variants v where v.item_id = i.id);
  get diagnostics v_items_kept = row_count;

  -- 4. Products with nothing left under them go.
  delete from public.items i
  where i.tenant_id = p_tenant_id
    and not exists (select 1 from public.variants v where v.item_id = i.id);
  get diagnostics v_items_deleted = row_count;

  -- 5. Categories. items.category_id is ON DELETE SET NULL and the kept items
  --    were already detached above.
  delete from public.categories c where c.tenant_id = p_tenant_id;
  get diagnostics v_categories = row_count;

  -- 6. Import batches hold extracted rows for review; with the catalogue gone
  --    they describe a state that no longer exists.
  delete from public.import_batches b where b.tenant_id = p_tenant_id;
  get diagnostics v_batches = row_count;

  return jsonb_build_object(
    'items_deleted',    v_items_deleted,
    'items_kept',       v_items_kept,
    'variants_deleted', v_variants_deleted,
    'variants_retired', v_variants_retired,
    'categories_deleted', v_categories,
    'import_batches_deleted', v_batches
  );
end;
$$;

comment on function public.delete_catalogue(uuid) is
  'Deletes a tenant''s categories, products, variants and import batches in one transaction. Orders are never touched; variants that appear in order history are retired and their products hidden instead of deleted, and counted in the result. Refused while any order is open, and for anyone but an owner. SECURITY INVOKER: RLS applies. Does not remove Storage objects — the client does that afterwards.';

revoke execute on function public.delete_catalogue(uuid) from public, anon;
grant execute on function public.delete_catalogue(uuid) to authenticated;
