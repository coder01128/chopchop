-- Fix place_order: merge random references (0009) with stock check (0012).
--
-- Migration 0012 rewrote place_order against the pre-random version, calling
-- next_order_reference which was dropped in 0009. This restores the random
-- reference generation while keeping the stock-check addition.

create or replace function public.place_order(
  p_tenant_id uuid,
  p_lines jsonb,
  p_details jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  c_alphabet   constant text := '23456789ABCDEFGHJKMNPQRSTVWXYZ';
  c_length     constant integer := 5;
  c_attempts   constant integer := 12;

  v_buyer_id     uuid := (select auth.uid());
  v_fulfilment   public.fulfilment_mode;
  v_sale_mode    public.sale_mode;
  v_stock_mode   public.stock_mode;
  v_attr_order   text[];
  v_order_id     uuid;
  v_reference    text;
  v_line         jsonb;
  v_index        integer := 0;
  v_attempt      integer;
  v_variant_id   uuid;
  v_qty          numeric;
  v_price        numeric;
  v_available    boolean;
  v_stock        numeric;
  v_label        text;
  v_line_total   numeric;
  v_total        numeric := 0;
  v_resolved     jsonb := '[]'::jsonb;
  v_name         text;
  v_phone        text;
begin
  if p_tenant_id is null then
    raise exception 'place_order: tenant_id is required' using errcode = '22004';
  end if;

  if v_buyer_id is null then
    raise exception 'place_order: a signed-in buyer session is required'
      using errcode = '42501';
  end if;

  select t.fulfilment_mode, t.sale_mode, t.stock_mode,
         (
           select array_agg(entry->>'name' order by ord)
           from jsonb_array_elements(t.attribute_schema) with ordinality as e(entry, ord)
         )
    into v_fulfilment, v_sale_mode, v_stock_mode, v_attr_order
  from public.tenants t
  where t.id = p_tenant_id
    and t.active;

  if not found then
    raise exception 'place_order: this shop is not taking orders'
      using errcode = '55000';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'place_order: an order needs at least one line' using errcode = '22023';
  end if;

  v_name  := nullif(btrim(coalesce(p_details->>'customer_name', '')), '');
  v_phone := nullif(btrim(coalesce(p_details->>'customer_phone', '')), '');

  if v_name is null then
    raise exception 'place_order: a name is required' using errcode = '22004';
  end if;

  if v_phone is null then
    raise exception 'place_order: a phone number is required' using errcode = '22004';
  end if;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_index := v_index + 1;
    v_variant_id := nullif(v_line->>'variant_id', '')::uuid;
    v_qty := (v_line->>'qty')::numeric;

    if v_variant_id is null then
      raise exception 'place_order: line % has no variant', v_index using errcode = '22023';
    end if;

    if v_qty is null or v_qty <= 0 then
      raise exception 'place_order: line % has no quantity', v_index using errcode = '22023';
    end if;

    if v_sale_mode = 'unit' and v_qty <> trunc(v_qty) then
      raise exception 'place_order: line % cannot be a part quantity', v_index
        using errcode = '22023';
    end if;

    select v.price, v.available, v.stock,
           i.name || coalesce(
             ' — ' || nullif((
               select string_agg(a.value, ' / '
                                 order by coalesce(array_position(v_attr_order, a.key), 1000), a.key)
               from jsonb_each_text(v.attributes) a
             ), ''),
             ''
           )
      into v_price, v_available, v_stock, v_label
    from public.variants v
    join public.items i
      on i.id = v.item_id
     and i.tenant_id = v.tenant_id
    where v.id = v_variant_id
      and v.tenant_id = p_tenant_id;

    if not found then
      raise exception 'place_order: line % is no longer on the menu', v_index
        using errcode = '22023';
    end if;

    if not v_available then
      raise exception 'place_order: line % is sold out', v_index using errcode = '22023';
    end if;

    if v_stock_mode = 'counted' and v_qty > v_stock then
      raise exception 'place_order: line % exceeds available stock (% available)',
        v_index, v_stock using errcode = '22023';
    end if;

    v_line_total := round(v_price * v_qty, 2);
    v_total := v_total + v_line_total;

    v_resolved := v_resolved || jsonb_build_object(
      'variant_id', v_variant_id,
      'name_snapshot', v_label,
      'price_snapshot', v_price,
      'qty', v_qty,
      'line_total', v_line_total
    );
  end loop;

  for v_attempt in 1..c_attempts loop
    v_reference := (
      select string_agg(
        substr(c_alphabet, 1 + floor(random() * length(c_alphabet))::integer, 1),
        ''
      )
      from generate_series(1, c_length)
    );

    begin
      insert into public.orders (
        tenant_id, buyer_id, reference, customer_name, customer_phone,
        fulfilment, notes, delivery_address, status, total
      )
      values (
        p_tenant_id,
        v_buyer_id,
        v_reference,
        v_name,
        v_phone,
        v_fulfilment,
        nullif(btrim(coalesce(p_details->>'notes', '')), ''),
        case when v_fulfilment = 'local_delivery'
             then nullif(btrim(coalesce(p_details->>'delivery_address', '')), '')
             else null end,
        'sent',
        v_total
      )
      returning id into v_order_id;
      exit;
    exception when unique_violation then
      if v_attempt = c_attempts then
        raise exception
          'place_order: could not allocate an order reference after % attempts', c_attempts
          using errcode = '40001';
      end if;
    end;
  end loop;

  insert into public.order_items (
    tenant_id, order_id, variant_id, name_snapshot, price_snapshot, qty, qty_confirmed, line_total
  )
  select
    p_tenant_id,
    v_order_id,
    (line->>'variant_id')::uuid,
    line->>'name_snapshot',
    (line->>'price_snapshot')::numeric,
    (line->>'qty')::numeric,
    null,
    (line->>'line_total')::numeric
  from jsonb_array_elements(v_resolved) as line;

  return public.order_with_lines(p_tenant_id, v_order_id);
end;
$$;

comment on function public.place_order(uuid, jsonb, jsonb) is
  'Writes a buyer''s order and its lines in one transaction. Prices and labels are read from variants, never from the payload. On a counted tenant, refuses any line whose quantity exceeds current stock. The reference is a random five-character code, retried against the unique index on collision. SECURITY INVOKER: the buyer''s own policies apply.';
