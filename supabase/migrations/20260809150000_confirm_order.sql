-- 0007 — confirm_order
--
-- Ticket 04 left one contract item open: SCHEMA.md says stock decrements when
-- an order is confirmed and `stock_mode = counted`, and nothing did it. The
-- dashboard confirmed an order with a loop of PostgREST updates — one per line,
-- then one on the order — which has no transaction across requests, so a
-- failure part-way left some lines carrying a weighed quantity and the order
-- still `received`.
--
-- public.confirm_order() puts the whole confirmation in one transaction and
-- adds the decrement that was missing.
--
-- Three decisions are built into this function and are deliberate:
--
--   Stock moves once, at `confirm`, and never again. Not at `sent` — a phantom
--   order would eat stock it never took. Not at `ready` or `completed`, which
--   move an order the seller already committed to. Nothing restores stock on a
--   later transition either: by `confirm` the goods have left the shelf.
--
--   A confirm never fails on insufficient stock. The count is allowed to go
--   negative. The seller has already cut the meat; a database refusal does not
--   un-cut it, it only leaves them unable to record what happened. A negative
--   count is a visible prompt to recount — the catalogue marks it — where a
--   blocked confirm is a dead end. This is why variants.stock carries no
--   non-negative constraint.
--
--   An `availability` tenant's confirm touches no stock at all. There is no
--   count to move, and a decrement path running against a figure the seller is
--   never shown is how a shop silently empties itself.

-- The shape confirm_order returns, in both the idempotent and the ordinary
-- path. Plain SQL and SECURITY INVOKER, so it reads exactly what the caller
-- could have read for itself.
create or replace function public.order_with_lines(p_tenant_id uuid, p_order_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'order', to_jsonb(o),
    'lines', coalesce(
      (
        select jsonb_agg(to_jsonb(oi) order by oi.name_snapshot)
        from public.order_items oi
        where oi.order_id = o.id
      ),
      '[]'::jsonb
    )
  )
  from public.orders o
  where o.id = p_order_id
    and o.tenant_id = p_tenant_id
$$;

comment on function public.order_with_lines(uuid, uuid) is
  'One order and its lines as jsonb. SECURITY INVOKER — it returns only what the caller''s own policies already allow.';

-- ===========================================================================

-- SECURITY INVOKER — deliberately, and it must stay that way.
--
-- The function runs as the caller, so every statement in it is subject to the
-- same RLS policies the PostgREST calls it replaces were. It is a transaction
-- wrapper, not a privilege escalation. SECURITY DEFINER here would turn one RPC
-- into a hole straight through the tenant boundary.
--
-- The membership check below is belt and braces on top of RLS, not instead of
-- it: RLS would filter a foreign tenant_id silently to zero rows, which reads
-- as "confirmed nothing" rather than "you may not do that". It is also what
-- shuts a buyer session out — an anonymous auth user holds `authenticated` and
-- therefore holds execute on this function, but has no tenant_users row, so
-- user_tenant_ids() returns nothing and every call raises 42501.
create or replace function public.confirm_order(
  p_tenant_id uuid,
  p_order_id uuid,
  p_lines jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_status       public.order_status;
  v_tracks_stock boolean;
  v_line         jsonb;
begin
  if p_tenant_id is null then
    raise exception 'confirm_order: tenant_id is required' using errcode = '22004';
  end if;

  if p_order_id is null then
    raise exception 'confirm_order: order_id is required' using errcode = '22004';
  end if;

  if p_tenant_id not in (select public.user_tenant_ids()) then
    raise exception 'confirm_order: caller does not belong to tenant %', p_tenant_id
      using errcode = '42501';
  end if;

  -- `for update` so two taps of Confirm cannot both read `received` and both
  -- decrement. The second waits, then finds the order already `confirmed` and
  -- returns it unchanged.
  select o.status into v_status
  from public.orders o
  where o.id = p_order_id
    and o.tenant_id = p_tenant_id
  for update;

  if not found then
    raise exception 'confirm_order: order % does not belong to tenant %', p_order_id, p_tenant_id
      using errcode = '42501';
  end if;

  -- Idempotent, not an error. A double-tap, or a retry after a dropped
  -- response, gets the order back as it stands and moves no stock. Making the
  -- seller interpret an exception for pressing a button twice is worse than
  -- doing nothing.
  if v_status = 'confirmed' then
    return public.order_with_lines(p_tenant_id, p_order_id);
  end if;

  -- Forward-only still holds. Confirming is reachable from `received` and
  -- nowhere else, which is also what stops a `ready` or `completed` order
  -- decrementing a second time.
  if v_status <> 'received' then
    raise exception 'confirm_order: order % is %, and only a received order can be confirmed',
      p_order_id, v_status
      using errcode = '55000';
  end if;

  -- Read from the tenant row rather than trusting a flag from the client: the
  -- caller does not get to decide whether their business counts stock.
  select t.stock_mode = 'counted' into v_tracks_stock
  from public.tenants t
  where t.id = p_tenant_id;

  -- ── lines ─────────────────────────────────────────────────────────────
  -- The arithmetic is not done here. What a confirmed line costs is decided by
  -- order-model.ts, which is tested without a browser; this executes that
  -- decision. Same division as the variant classifier and save_product.
  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    update public.order_items oi
    set qty_confirmed = nullif(v_line->>'qty_confirmed', '')::numeric,
        line_total    = (v_line->>'line_total')::numeric
    where oi.id = (v_line->>'id')::uuid
      and oi.order_id = p_order_id
      and oi.tenant_id = p_tenant_id;

    if not found then
      raise exception 'confirm_order: line % does not belong to this order', v_line->>'id'
        using errcode = '42501';
    end if;
  end loop;

  -- ── stock ─────────────────────────────────────────────────────────────
  -- The quantity actually taken is the confirmed one where the seller entered
  -- it and the ordered one where they did not — never both, and never `qty`
  -- when a confirmed quantity exists, which is the whole point of the column.
  --
  -- Read from order_items rather than from p_lines: a line the client did not
  -- send still left the shelf. Grouped, because one order may carry the same
  -- variant on two lines.
  if v_tracks_stock then
    update public.variants v
    set stock = v.stock - taken.qty
    from (
      select oi.variant_id, sum(coalesce(oi.qty_confirmed, oi.qty)) as qty
      from public.order_items oi
      where oi.order_id = p_order_id
        and oi.tenant_id = p_tenant_id
      group by oi.variant_id
    ) taken
    where v.id = taken.variant_id
      and v.tenant_id = p_tenant_id;
  end if;

  -- ── the order ─────────────────────────────────────────────────────────
  -- The total is summed from the lines as they now stand rather than taken
  -- from the payload: a client-supplied total could disagree with the rows it
  -- was supposedly derived from. Each line_total was already rounded to cents
  -- by the client, so this addition makes no rounding decision of its own.
  update public.orders o
  set status       = 'confirmed',
      confirmed_at = now(),
      total        = coalesce(
        (select sum(oi.line_total) from public.order_items oi where oi.order_id = p_order_id),
        0
      )
  where o.id = p_order_id
    and o.tenant_id = p_tenant_id;

  -- Returned so the detail screen reconciles without a second trip. Same
  -- reason as save_product.
  return public.order_with_lines(p_tenant_id, p_order_id);
end;
$$;

comment on function public.confirm_order(uuid, uuid, jsonb) is
  'Confirms an order in one transaction: writes qty_confirmed and line_total per line, stamps confirmed_at, recomputes the total, and decrements variants.stock when the tenant is counted. SECURITY INVOKER: RLS applies exactly as it does to the equivalent PostgREST calls. Idempotent on an already-confirmed order.';

-- execute is granted to public by default on creation, so revoke first and hand
-- it back only where it is wanted. Neither of these is anything the storefront
-- has any business calling.
revoke execute on function public.confirm_order(uuid, uuid, jsonb) from public, anon;
revoke execute on function public.order_with_lines(uuid, uuid) from public, anon;

grant execute on function public.confirm_order(uuid, uuid, jsonb) to authenticated;
grant execute on function public.order_with_lines(uuid, uuid) to authenticated;
