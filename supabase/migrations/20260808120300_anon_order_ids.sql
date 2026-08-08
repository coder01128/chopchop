-- 0004 — let the buyer supply the order id
--
-- The storefront has to be able to link to its own order status page, which
-- means it has to know the order id. It cannot read one back: anon has no
-- SELECT on `orders` by design, so an INSERT ... RETURNING is not available
-- either.
--
-- The remaining option that does not weaken anything is for the client to
-- generate the uuid (crypto.randomUUID) and send it. The id is the capability
-- for get_order(), and it is the buyer's own order, so the buyer choosing it
-- gives them nothing they did not already have. A collision is a primary key
-- violation, not a leak.

grant insert (
  id, tenant_id, reference, customer_name, customer_phone, fulfilment, notes, total
) on public.orders to anon;

grant insert (
  id, tenant_id, order_id, variant_id, name_snapshot, price_snapshot, qty, line_total
) on public.order_items to anon;
