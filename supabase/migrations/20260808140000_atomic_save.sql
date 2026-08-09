-- 0006 — atomic product save, and retirement as a real state
--
-- Two things, both consequences of ticket 03.
--
-- 1. Saving a product was three or more PostgREST calls: the item, then the
--    variant writes, then the removals. PostgREST has no transaction across
--    requests, so a failure part-way left a product half-written. On the screen
--    sellers use most, that is quiet corruption nobody notices until a price is
--    wrong on the storefront. public.save_product() puts the whole thing in one
--    transaction.
--
-- 2. "Retired" needed somewhere to live. A deactivate-only removal set
--    available = false, but `available` is also the ordinary in-stock toggle —
--    the *only* stock signal for an availability tenant, flipped several times
--    a day. Overloading it means the editor cannot tell "the seller removed
--    this, we kept it for order history" from "we are out of these today", so
--    on reopen the value came back ticked and the seller was contradicted by
--    the interface. variants.retired_at makes the two distinguishable.

-- ===========================================================================
-- 1. variants.retired_at
-- ===========================================================================

alter table public.variants
  add column retired_at timestamptz;

comment on column public.variants.retired_at is
  'Set when a seller removed this variant but it could not be deleted, because order_items.variant_id is ON DELETE RESTRICT. Distinct from available = false, which is the everyday in-stock toggle. Retired variants are hidden from buyers and listed separately in the editor, where they can be restored.';

-- Partial index: every storefront-facing read filters on this, and the vast
-- majority of rows are not retired.
create index variants_live_idx on public.variants (tenant_id, item_id)
  where retired_at is null;

-- ---------------------------------------------------------------------------
-- Buyers must not see a retired variant.
--
-- Note this is NOT the same as hiding `available = false`: a sold-out variant
-- still renders, greyed, because it is coming back. A retired one is not.
-- Without this the removal dialog's promise — "buyers will not see them" —
-- would simply be untrue.
-- ---------------------------------------------------------------------------

alter policy variants_anon_select on public.variants
  using (
    public.is_active_tenant(tenant_id)
    and retired_at is null
    and exists (
      select 1 from public.items i
      where i.id = variants.item_id
        and i.tenant_id = variants.tenant_id
        and i.active
    )
  );

alter policy variants_buyer_select on public.variants
  using (
    public.is_anonymous_user()
    and public.is_active_tenant(tenant_id)
    and public.item_is_active(item_id)
    and retired_at is null
  );

alter policy variants_not_anonymous on public.variants
  using (
    not public.is_anonymous_user()
    or (
      public.is_active_tenant(tenant_id)
      and public.item_is_active(item_id)
      and retired_at is null
    )
  );

-- The dashboard is unchanged: a seller still sees retired variants, or they
-- could never restore one.

-- ===========================================================================
-- 2. save_product
-- ===========================================================================

-- SECURITY INVOKER — deliberately, and it must stay that way.
--
-- This function runs as the caller, so every statement in it is subject to the
-- same RLS policies the equivalent PostgREST calls were. It is a transaction
-- wrapper, not a privilege escalation. Making it SECURITY DEFINER would turn
-- one RPC into a hole straight through the tenant boundary.
--
-- The membership check below is therefore belt and braces on top of RLS, not
-- instead of it: RLS would filter a foreign tenant_id silently to zero rows,
-- which reads as "saved nothing" rather than "you may not do that". An explicit
-- error is the honest answer, and it is what the test asserts against.
create or replace function public.save_product(
  p_tenant_id uuid,
  p_item jsonb,
  p_variants jsonb default '[]'::jsonb,
  p_removals jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_item_id      uuid;
  v_tracks_stock boolean;
  v_variant      jsonb;
  v_removal      jsonb;
  v_variant_id   uuid;
  v_action       text;
begin
  if p_tenant_id is null then
    raise exception 'save_product: tenant_id is required' using errcode = '22004';
  end if;

  if p_tenant_id not in (select public.user_tenant_ids()) then
    raise exception 'save_product: caller does not belong to tenant %', p_tenant_id
      using errcode = '42501';
  end if;

  -- Read from the tenant row rather than trusting a flag from the client: the
  -- caller does not get to decide whether their business tracks stock.
  select t.stock_mode = 'counted' into v_tracks_stock
  from public.tenants t
  where t.id = p_tenant_id;

  -- ── item ──────────────────────────────────────────────────────────────
  v_item_id := nullif(p_item->>'id', '')::uuid;

  if v_item_id is null then
    insert into public.items (tenant_id, name, description, image_url, category_id, active)
    values (
      p_tenant_id,
      p_item->>'name',
      nullif(p_item->>'description', ''),
      nullif(p_item->>'image_url', ''),
      nullif(p_item->>'category_id', '')::uuid,
      coalesce((p_item->>'active')::boolean, true)
    )
    returning id into v_item_id;
  else
    update public.items
    set name        = p_item->>'name',
        description = nullif(p_item->>'description', ''),
        image_url   = nullif(p_item->>'image_url', ''),
        category_id = nullif(p_item->>'category_id', '')::uuid,
        active      = coalesce((p_item->>'active')::boolean, true)
    where id = v_item_id
      and tenant_id = p_tenant_id;

    if not found then
      raise exception 'save_product: product % does not belong to tenant %', v_item_id, p_tenant_id
        using errcode = '42501';
    end if;
  end if;

  -- ── variants ──────────────────────────────────────────────────────────
  for v_variant in select * from jsonb_array_elements(p_variants)
  loop
    v_variant_id := nullif(v_variant->>'id', '')::uuid;

    if v_variant_id is null then
      insert into public.variants (tenant_id, item_id, attributes, price, available, sku, stock)
      values (
        p_tenant_id,
        v_item_id,
        coalesce(v_variant->'attributes', '{}'::jsonb),
        (v_variant->>'price')::numeric,
        coalesce((v_variant->>'available')::boolean, true),
        nullif(v_variant->>'sku', ''),
        case when v_tracks_stock then coalesce((v_variant->>'stock')::numeric, 0) else 0 end
      );
    else
      update public.variants
      set attributes = coalesce(v_variant->'attributes', attributes),
          price      = (v_variant->>'price')::numeric,
          available  = coalesce((v_variant->>'available')::boolean, true),
          sku        = nullif(v_variant->>'sku', ''),
          -- Present in the live list means not retired. This is how Restore
          -- works: the variant simply comes back as an ordinary write.
          retired_at = null,
          -- An availability tenant is shown no stock figure, so none is
          -- written — inventing one or zeroing theirs are both wrong.
          stock      = case when v_tracks_stock
                            then coalesce((v_variant->>'stock')::numeric, stock)
                            else stock end
      where id = v_variant_id
        and tenant_id = p_tenant_id
        and item_id = v_item_id;

      if not found then
        raise exception 'save_product: variant % does not belong to this product', v_variant_id
          using errcode = '42501';
      end if;
    end if;
  end loop;

  -- ── removals ──────────────────────────────────────────────────────────
  -- The RPC executes decisions; it does not make them. Whether a variant may
  -- be deleted, must be retired, or is blocked is decided by the classifier in
  -- the client, which asks about order history before offering the control.
  for v_removal in select * from jsonb_array_elements(p_removals)
  loop
    v_variant_id := (v_removal->>'id')::uuid;
    v_action := v_removal->>'action';

    if v_action = 'delete' then
      -- The classification can be a moment stale — an order may have arrived
      -- while the modal was open. Retire rather than surface a foreign key
      -- violation. The sub-block keeps the rest of the transaction intact.
      begin
        delete from public.variants
        where id = v_variant_id and tenant_id = p_tenant_id;
      exception when foreign_key_violation then
        update public.variants
        set available = false, retired_at = now()
        where id = v_variant_id and tenant_id = p_tenant_id;
      end;

    elsif v_action = 'retire' then
      update public.variants
      set available = false, retired_at = now()
      where id = v_variant_id and tenant_id = p_tenant_id;

    else
      raise exception 'save_product: unknown removal action %', coalesce(v_action, 'null')
        using errcode = '22023';
    end if;
  end loop;

  -- Return the saved state so the modal can reconcile without a second trip.
  return jsonb_build_object(
    'item', (select to_jsonb(i) from public.items i where i.id = v_item_id),
    'variants', coalesce(
      (select jsonb_agg(to_jsonb(v) order by v.id) from public.variants v where v.item_id = v_item_id),
      '[]'::jsonb
    )
  );
end;
$$;

comment on function public.save_product(uuid, jsonb, jsonb, jsonb) is
  'Writes a product, its variants and its removals in one transaction. SECURITY INVOKER: RLS applies exactly as it does to the equivalent PostgREST calls.';

revoke execute on function public.save_product(uuid, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.save_product(uuid, jsonb, jsonb, jsonb) to authenticated;
