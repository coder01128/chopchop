-- 0008 — place_order, and somewhere for a delivery address to land
--
-- The first write a buyer makes. Everything before this was the seller's side.
--
-- Why an RPC rather than the two inserts the buyer's policies already allow:
--
--   Prices. A buyer session can insert order lines — it has to, it is placing
--   the order — and `price_snapshot` is a column on that insert. A checkout
--   that composes the line client-side is a checkout where the buyer names
--   their own price. Inside this function the price is read from `variants` and
--   anything the payload said about it is discarded. That is the security point
--   of the whole ticket.
--
--   Atomicity. A header without lines shows up in the seller's queue as an
--   empty order, which is worse than no order at all.
--
--   The reference. `(tenant_id, reference)` is unique and nothing generated one
--   before now — the seed hardcoded A47 and S12. Generation and collision
--   retry have to live somewhere the client cannot skip.
--
-- Stock is deliberately neither checked nor decremented here. Decrement happens
-- once, at confirm (0007), and that decision stands. Two buyers can order the
-- last box; the seller sorts it out on WhatsApp, which is what they do today.

-- ===========================================================================
-- 1. orders.delivery_address
-- ===========================================================================

-- Checkout collects an address when the tenant is `local_delivery`, and there
-- was nowhere for it to go. It is not squeezed into `notes`: `notes` is the
-- buyer's own message to the seller and a seller scanning a queue must be able
-- to tell "leave it at the gate" from the address itself.
--
-- Nullable, because a `collect` tenant never collects one — that tenant's
-- checkout has no address field at all.
alter table public.orders
  add column delivery_address text;

comment on column public.orders.delivery_address is
  'Where to deliver. Written only when the tenant is local_delivery; null for a collect tenant, whose checkout never shows the field. Distinct from notes, which is the buyer''s message to the seller.';

-- ===========================================================================
-- 2. Reference generation
-- ===========================================================================

-- SECURITY DEFINER, and it has to be.
--
-- A reference is "the next one for this tenant", which means counting that
-- tenant's orders — and the caller is a buyer, whose RLS policy on `orders`
-- shows them their own rows and nothing else. Counted as the caller, every
-- buyer's first order would be number one. The definer runs as the table owner,
-- who is not subject to that policy, so the count is the real one.
--
-- What it hands back is one short string the buyer receives anyway, on the
-- order it just placed. search_path is pinned, as with every other definer
-- function in this schema.
--
-- Sequential rather than random, deliberately: the seller reads these aloud on
-- WhatsApp and matches them against the queue by eye. B08 following B07 is
-- legible; gaps in a shared global sequence would read as lost orders.
create or replace function public.next_order_reference(
  p_tenant_id uuid,
  p_attempt integer default 0
)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    -- One letter from the tenant, so a seller with two shops can tell them
    -- apart at a glance. The slug's last segment first (demo-butchery -> B),
    -- falling back to the trading name, falling back to A.
    coalesce(
      nullif(upper(substring(regexp_replace(split_part(t.slug, '-', array_length(string_to_array(t.slug, '-'), 1)), '[^a-zA-Z]', '', 'g') from 1 for 1)), ''),
      nullif(upper(substring(regexp_replace(t.name, '[^a-zA-Z]', '', 'g') from 1 for 1)), ''),
      'A'
    )
    || lpad(
      (
        (select count(*) from public.orders o where o.tenant_id = p_tenant_id)
        + 1
        + greatest(p_attempt, 0)
      )::text,
      2,
      '0'
    )
  from public.tenants t
  where t.id = p_tenant_id
$$;

comment on function public.next_order_reference(uuid, integer) is
  'The next human-sayable reference for a tenant — B08. SECURITY DEFINER because the count spans orders the calling buyer cannot see. p_attempt steps past a collision.';

-- ===========================================================================
-- 3. place_order
-- ===========================================================================

-- SECURITY INVOKER — deliberately, and it must stay that way. Same reasoning as
-- save_product and confirm_order: this is a transaction wrapper, not a
-- privilege escalation. Every insert below is subject to the buyer's own
-- policies, which is what confines the order to the buyer's own id and to an
-- active tenant. SECURITY DEFINER here would hand the storefront a way to write
-- any row it liked into anybody's queue.
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
  for v_attempt in 0..24 loop
    v_reference := public.next_order_reference(p_tenant_id, v_attempt);
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
      -- (tenant_id, reference) is unique and two buyers can check out in the
      -- same second. Step to the next reference and try again.
      if v_attempt >= 24 then
        raise exception 'place_order: could not allocate an order reference'
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
  'Writes a buyer''s order and its lines in one transaction. Prices and labels are read from variants, never from the payload. Generates the reference and retries on collision. SECURITY INVOKER: the buyer''s own policies apply.';

-- ===========================================================================
-- 4. Grants
-- ===========================================================================

-- Buyers are anonymous auth users holding `authenticated`. The anon role has no
-- grants on orders at all, which is why sign-in has to complete before
-- checkout — and why anon is explicitly revoked here rather than left to
-- default.
revoke execute on function public.place_order(uuid, jsonb, jsonb) from public, anon;
revoke execute on function public.next_order_reference(uuid, integer) from public, anon;

grant execute on function public.place_order(uuid, jsonb, jsonb) to authenticated;
grant execute on function public.next_order_reference(uuid, integer) to authenticated;
