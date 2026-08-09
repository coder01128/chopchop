-- 0009 — random order references, and the end of next_order_reference
--
-- 0008 generated a reference by counting a tenant's orders. Counting them means
-- reading rows the calling buyer's policies hide, so the counter was
-- SECURITY DEFINER — and place_order is SECURITY INVOKER, so that helper had to
-- be granted to `authenticated` for the RPC to call it at all.
--
-- Buyers hold `authenticated`. Any storefront visitor could therefore call
--
--   select public.next_order_reference('<any tenant id>');
--
-- and read back that tenant's order count in the digits. A client's trading
-- volume, legible to anyone who can open any storefront and pass a uuid. The
-- leak test asserts on tables and policies; a function that hands out an
-- aggregate is invisible to it, which is why this got through.
--
-- A random code needs no count, so the definer function goes away entirely
-- rather than being tightened. Nothing that cannot be called cannot leak.
--
-- The reference is still the thing a seller reads aloud on WhatsApp while
-- serving somebody else, so the alphabet is chosen for the ear, not for
-- entropy: no I or L to be heard as 1, no O to be heard as 0, no U. Thirty
-- characters, five places, ~24.3 million codes per tenant — a collision is a
-- retry, not an event.
--
-- Existing references are left exactly as they are. Uniqueness is per tenant,
-- so the seed's A47 and the Q4- fixtures coexist with the new format
-- indefinitely; nothing renumbers and no order changes its identity.

-- ===========================================================================
-- 1. place_order — reference generation only
-- ===========================================================================
--
-- Everything else in this function is unchanged from 0008 and is repeated only
-- because `create or replace function` takes the whole body.
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
  -- Read aloud, not typed: no I or L against 1, no O against 0, no U.
  c_alphabet   constant text := '23456789ABCDEFGHJKMNPQRSTVWXYZ';
  c_length     constant integer := 5;
  c_attempts   constant integer := 12;

  v_buyer_id     uuid := (select auth.uid());
  v_fulfilment   public.fulfilment_mode;
  v_sale_mode    public.sale_mode;
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

  -- The anon role holds no grants on orders at all, so a checkout that has not
  -- signed in yet fails at the insert with something unreadable. Say it here
  -- instead.
  if v_buyer_id is null then
    raise exception 'place_order: a signed-in buyer session is required'
      using errcode = '42501';
  end if;

  select t.fulfilment_mode, t.sale_mode,
         (
           select array_agg(entry->>'name' order by ord)
           from jsonb_array_elements(t.attribute_schema) with ordinality as e(entry, ord)
         )
    into v_fulfilment, v_sale_mode, v_attr_order
  from public.tenants t
  where t.id = p_tenant_id
    and t.active;

  -- A shop switched off mid-visit. RLS would refuse the insert anyway; this is
  -- the difference between a readable message and a policy violation.
  if not found then
    raise exception 'place_order: this shop is not taking orders'
      using errcode = '55000';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'place_order: an order needs at least one line' using errcode = '22023';
  end if;

  v_name  := nullif(btrim(coalesce(p_details->>'customer_name', '')), '');
  v_phone := nullif(btrim(coalesce(p_details->>'customer_phone', '')), '');

  -- Both columns are NOT NULL. Refused here so the seller's queue never holds
  -- an order nobody can be reached about, and so the buyer gets a sentence
  -- rather than a constraint name.
  if v_name is null then
    raise exception 'place_order: a name is required' using errcode = '22004';
  end if;

  if v_phone is null then
    raise exception 'place_order: a phone number is required' using errcode = '22004';
  end if;

  -- ── resolve the lines before writing anything ─────────────────────────
  --
  -- Prices, labels and the order total are all settled first, because the
  -- buyer has no UPDATE policy on `orders` — a header written with a zero total
  -- and corrected afterwards would stay zero. It also means a rejected line
  -- never burns a reference.
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

    -- A unit business sells whole things. Read from the tenant row, not from a
    -- guess about what it sells.
    if v_sale_mode = 'unit' and v_qty <> trunc(v_qty) then
      raise exception 'place_order: line % cannot be a part quantity', v_index
        using errcode = '22023';
    end if;

    -- Price from the row, never from the payload: the buyer's session can
    -- insert order_items, so a payload price is a price the buyer chose.
    --
    -- name_snapshot is composed here, as the full label the buyer chose —
    -- "Rump Steak — per kg", not "Rump Steak". Ticket 04's queue and the
    -- buyer's status page both render from this and never join variants, which
    -- is what lets a variant be retired without rewriting history.
    --
    -- Attribute order follows the tenant's attribute_schema, so a shoe reads
    -- "8 / white" rather than whatever order jsonb happens to store its keys
    -- in. Anything not in the palette sorts after, by key.
    select v.price, v.available,
           i.name || coalesce(
             ' — ' || nullif((
               select string_agg(a.value, ' / '
                                 order by coalesce(array_position(v_attr_order, a.key), 1000), a.key)
               from jsonb_each_text(v.attributes) a
             ), ''),
             ''
           )
      into v_price, v_available, v_label
    from public.variants v
    join public.items i
      on i.id = v.item_id
     and i.tenant_id = v.tenant_id
    where v.id = v_variant_id
      and v.tenant_id = p_tenant_id;

    -- Covers three cases that are one case to the buyer: the variant belongs to
    -- another tenant, it was retired while the cart sat open, or its product
    -- was hidden. A retired variant is invisible to a buyer by policy, so it
    -- arrives here as simply not found — which is the honest answer to give.
    if not found then
      raise exception 'place_order: line % is no longer on the menu', v_index
        using errcode = '22023';
    end if;

    if not v_available then
      raise exception 'place_order: line % is sold out', v_index using errcode = '22023';
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

  -- ── the header ────────────────────────────────────────────────────────
  --
  -- status is 'sent' and the timestamps stay null. Those are the seller's to
  -- set and the buyer's policy refuses anything else, so this is the honest
  -- value rather than one being smuggled past a check.
  --
  -- `fulfilment` comes from the tenant row, not the payload: v1 has one
  -- fulfilment mode per business and the buyer does not choose another. Same
  -- rule as stock_mode in confirm_order.
  --
  -- On a weight tenant the total is an estimate until the seller weighs, which
  -- is why every surface showing it before `confirmed` says so.
  --
  -- The reference is drawn fresh on every attempt and the unique index on
  -- (tenant_id, reference) is what decides whether it was free. Nothing counts,
  -- nothing is read back, and the code carries no information about the shop.
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
        -- A collect tenant stores nothing here even if a payload supplies it.
        case when v_fulfilment = 'local_delivery'
             then nullif(btrim(coalesce(p_details->>'delivery_address', '')), '')
             else null end,
        'sent',
        v_total
      )
      returning id into v_order_id;
      exit;
    exception when unique_violation then
      -- Two buyers can draw the same code in the same second, and a shop with
      -- a long history has more of the space taken. Draw again.
      --
      -- Twelve failures in a row is not bad luck at any plausible catalogue
      -- size; it means the space is genuinely crowded and the format needs a
      -- character, so say that rather than looping forever.
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
    -- The weighed quantity is the seller's to write, and the buyer's policy
    -- says so too.
    null,
    (line->>'line_total')::numeric
  from jsonb_array_elements(v_resolved) as line;

  -- Returned so checkout composes the WhatsApp message from what was actually
  -- written rather than from cart state — the reference and the snapshots only
  -- exist after this point.
  return public.order_with_lines(p_tenant_id, v_order_id);
end;
$$;

comment on function public.place_order(uuid, jsonb, jsonb) is
  'Writes a buyer''s order and its lines in one transaction. Prices and labels are read from variants, never from the payload. The reference is a random five-character code, retried against the unique index on collision. SECURITY INVOKER: the buyer''s own policies apply.';

-- ===========================================================================
-- 2. Drop the counter
-- ===========================================================================

-- Nothing else calls it: place_order above was the only caller, and it no
-- longer does.
drop function if exists public.next_order_reference(uuid, integer);

-- ===========================================================================
-- 3. A way to see every SECURITY DEFINER function
-- ===========================================================================

-- This exists so a test can assert the list, because the mistake this migration
-- undoes was not that the function was wrong — it was that nothing was watching
-- for a definer function appearing with a grant on it.
--
-- The five that remain are deliberate and documented in 0002 and 0005: each
-- breaks an RLS recursion that cannot be written any other way. A sixth should
-- be a decision somebody argued for, not something a test discovers later.
--
-- `prosecdef` is world-readable in pg_catalog to any database role already, so
-- the view discloses nothing new inside the database. It is not exposed through
-- the API: the Data API roles get no grant, only the service role used by the
-- test harness, which bypasses RLS anyway.
create or replace view public.security_definer_functions as
  select
    p.proname::text                        as function_name,
    pg_get_function_identity_arguments(p.oid) as arguments,
    p.prosecdef                            as security_definer
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prosecdef;

comment on view public.security_definer_functions is
  'Every SECURITY DEFINER function in the public schema. Read by tests/place-order-rpc.test.ts, which asserts the list against the five deliberate RLS-recursion breakers. Granted to service_role only.';

revoke all on public.security_definer_functions from public, anon, authenticated;
grant select on public.security_definer_functions to service_role;
