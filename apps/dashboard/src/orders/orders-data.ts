import type { ChopChopClient, Database, SaleMode } from '@chopchop/shared';
import { lineTotalFor, orderTotalFor, type OrderLine } from './order-model';

export type OrderRow = Database['public']['Tables']['orders']['Row'];
export type OrderStatus = Database['public']['Enums']['order_status'];

export interface OrderSummary {
  order: OrderRow;
  lineCount: number;
}

/**
 * The queue. Orders for the resolved tenant only — RLS enforces that, and the
 * explicit filter keeps the query honest about its intent.
 */
export async function loadOrders(
  client: ChopChopClient,
  tenantId: string,
): Promise<OrderSummary[]> {
  const [orders, lines] = await Promise.all([
    client
      .from('orders')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false }),
    client.from('order_items').select('order_id').eq('tenant_id', tenantId),
  ]);

  if (orders.error) throw new Error(`Could not load orders: ${orders.error.message}`);
  if (lines.error) throw new Error(`Could not load order lines: ${lines.error.message}`);

  const counts = new Map<string, number>();
  for (const line of lines.data ?? []) {
    counts.set(line.order_id, (counts.get(line.order_id) ?? 0) + 1);
  }

  return (orders.data ?? []).map((order) => ({
    order,
    lineCount: counts.get(order.id) ?? 0,
  }));
}

/**
 * An order's lines, from `order_items` alone.
 *
 * `variants` is deliberately not joined. The snapshot columns exist precisely
 * so history does not depend on a mutable product row — and a variant retired
 * since the order was placed is filtered out by the buyer and anon policies, so
 * a join would quietly drop lines from the very orders that made the variant
 * un-deletable.
 */
export async function loadOrderLines(
  client: ChopChopClient,
  orderId: string,
): Promise<OrderLine[]> {
  const { data, error } = await client
    .from('order_items')
    .select('id, name_snapshot, price_snapshot, qty, qty_confirmed, line_total')
    .eq('order_id', orderId)
    .order('name_snapshot');

  if (error) throw new Error(`Could not load the order's lines: ${error.message}`);

  return (data ?? []).map((row) => ({
    id: row.id,
    name_snapshot: row.name_snapshot,
    price_snapshot: Number(row.price_snapshot),
    qty: Number(row.qty),
    qty_confirmed: row.qty_confirmed === null ? null : Number(row.qty_confirmed),
    line_total: Number(row.line_total),
  }));
}

/**
 * Moves an order along the flow.
 *
 * The transition itself is decided by `allowedTransitions` in the model; this
 * only writes it. The timestamps are set here because they are facts about the
 * write, not decisions.
 */
export async function transitionOrder(
  client: ChopChopClient,
  orderId: string,
  to: OrderStatus,
): Promise<void> {
  const patch: Partial<OrderRow> = { status: to };
  if (to === 'confirmed') patch.confirmed_at = new Date().toISOString();
  if (to === 'completed') patch.completed_at = new Date().toISOString();

  const { error } = await client.from('orders').update(patch).eq('id', orderId);
  if (error) throw new Error(`Could not update the order: ${error.message}`);
}

/**
 * Confirming a weight order: the seller has cut and weighed, and the quantities
 * they entered become the real totals.
 *
 * `line_total` is a stored column rather than a generated one, so it is written
 * here, and the order total is recomputed from the lines — until this point it
 * was an estimate.
 *
 * Not atomic across lines, and it does not need to be in the way `save_product`
 * did: every write here is idempotent and derived from values the seller can
 * see, so a failure part-way is re-runnable by pressing Confirm again rather
 * than leaving a half-built product.
 */
export async function confirmWithQuantities(
  client: ChopChopClient,
  orderId: string,
  lines: OrderLine[],
): Promise<void> {
  for (const line of lines) {
    const { error } = await client
      .from('order_items')
      .update({
        qty_confirmed: line.qty_confirmed,
        line_total: lineTotalFor(line),
      })
      .eq('id', line.id);
    if (error) throw new Error(`Could not save the weighed quantity: ${error.message}`);
  }

  const { error } = await client
    .from('orders')
    .update({
      status: 'confirmed',
      confirmed_at: new Date().toISOString(),
      total: orderTotalFor(lines),
    })
    .eq('id', orderId);
  if (error) throw new Error(`Could not confirm the order: ${error.message}`);
}

/** Formats money the one way the whole dashboard formats money. */
export const money = new Intl.NumberFormat('en-ZA', {
  style: 'currency',
  currency: 'ZAR',
  minimumFractionDigits: 2,
});

export type { SaleMode };
