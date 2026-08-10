-- ===========================================================================
-- Ticket 07 — save_product carries image paths
--
-- save_product is the only write path to items and variants. Ticket 07 added
-- items.image_path and variants.image_path, so without this migration a seller
-- can upload a photograph and have the assignment silently dropped on save.
--
-- Three changes, all additive. Everything else in the body is unchanged from
-- 20260808140000_atomic_save.sql, including SECURITY INVOKER, the jsonb return
-- shape the modal reconciles against, and the foreign_key_violation fallback in
-- the removals loop.
--
--   1. p_item->>'image_path'      the product primary
--   2. variant->>'image_path'     the photo assigned to that variant
--   3. p_item->>'new_id'          a client-chosen id for a product being created
--
-- (3) exists because the object path is <tenant_id>/<item_id>/<uuid>.<ext> and
-- a product being created for the first time has no id yet. Without it the
-- upload control would have to stay disabled until the seller saves once, which
-- is not the flow a seller photographing stock in their shop will follow. The
-- modal mints the id when it opens, uploads land under the right prefix
-- immediately, and the insert uses that id.
--
-- Absent key means unchanged, for both image columns. The import pipeline calls
-- this RPC with an item payload carrying no image_path key at all, and a
-- price-list re-import must never wipe photographs the seller uploaded.
-- Present-but-empty means cleared, which is what the remove control sends.
--
-- image_url is untouched. Still legacy, still written by nothing but the seed,
-- still read as the last fallback before the empty state.
-- ===========================================================================

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
  v_new_item_id  uuid;
  v_tracks_stock boolean;
  v_variant      jsonb;
  v_removal      jsonb;
  v_variant_id   uuid;
  v_action       text;
  v_image_path   text;
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

  -- The primary. Checked against the caller's own tenant prefix for the same
  -- reason place_order reads prices from variants rather than from the payload:
  -- the client supplies this string, so the client does not get to decide it
  -- points somewhere it should not. Storage refuses the write; this refuses the
  -- reference.
  v_image_path := nullif(p_item->>'image_path', '');
  if v_image_path is not null
     and v_image_path not like p_tenant_id::text || '/%' then
    raise exception 'save_product: image path % is not under this tenant', v_image_path
      using errcode = '42501';
  end if;

  if v_item_id is null then
    v_new_item_id := nullif(p_item->>'new_id', '')::uuid;

    insert into public.items (
      id, tenant_id, name, description, image_url, image_path, category_id, active
    )
    values (
      coalesce(v_new_item_id, gen_random_uuid()),
      p_tenant_id,
      p_item->>'name',
      nullif(p_item->>'description', ''),
      nullif(p_item->>'image_url', ''),
      v_image_path,
      nullif(p_item->>'category_id', '')::uuid,
      coalesce((p_item->>'active')::boolean, true)
    )
    returning id into v_item_id;
  else
    update public.items
    set name        = p_item->>'name',
        description = nullif(p_item->>'description', ''),
        image_url   = nullif(p_item->>'image_url', ''),
        -- Absent means unchanged; present and empty means cleared.
        image_path  = case when p_item ? 'image_path' then v_image_path else image_path end,
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

    v_image_path := nullif(v_variant->>'image_path', '');
    if v_image_path is not null
       and v_image_path not like p_tenant_id::text || '/%' then
      raise exception 'save_product: image path % is not under this tenant', v_image_path
        using errcode = '42501';
    end if;

    if v_variant_id is null then
      insert into public.variants (
        tenant_id, item_id, attributes, price, available, sku, stock, image_path
      )
      values (
        p_tenant_id,
        v_item_id,
        coalesce(v_variant->'attributes', '{}'::jsonb),
        (v_variant->>'price')::numeric,
        coalesce((v_variant->>'available')::boolean, true),
        nullif(v_variant->>'sku', ''),
        case when v_tracks_stock then coalesce((v_variant->>'stock')::numeric, 0) else 0 end,
        v_image_path
      );
    else
      update public.variants
      set attributes = coalesce(v_variant->'attributes', attributes),
          price      = (v_variant->>'price')::numeric,
          available  = coalesce((v_variant->>'available')::boolean, true),
          sku        = nullif(v_variant->>'sku', ''),
          -- Absent means unchanged. A spreadsheet re-import sends no image_path
          -- and must not strip the photographs the seller uploaded by hand.
          image_path = case when v_variant ? 'image_path' then v_image_path else image_path end,
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
  --
  -- Unchanged from the original, including the objects a removed variant may
  -- have pointed at: deleting a variant row does not delete a photograph.
  -- The image belongs to the product's library, not to the variant, and the
  -- same file may be carrying two other sizes.
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
  'Writes a product, its variants, its removals and its image paths in one transaction. SECURITY INVOKER: RLS applies exactly as it does to the equivalent PostgREST calls. An image_path is refused unless it sits under the caller''s own tenant prefix, and an absent image_path key means unchanged, so a spreadsheet re-import never strips uploaded photographs. p_item->>''new_id'' lets the client choose the id of a product it is creating, because the Storage object path contains the item id and a photo may be uploaded before the first save.';

revoke execute on function public.save_product(uuid, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.save_product(uuid, jsonb, jsonb, jsonb) to authenticated;
