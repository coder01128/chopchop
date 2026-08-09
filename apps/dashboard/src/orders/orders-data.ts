import type { ChopChopClient, Database, SaleMode } from '@chopchop/shared';
import { lineTotalFor, type OrderLine } from './order-model';

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
 * Confirming an order: the seller commits to fulfilling it.
 *
 * One call to public.confirm_order(), which is SECURITY INVOKER, so RLS applies
 * exactly as it did to the loop of PostgREST updates this replaced. It writes
 * every line, stamps the order, and — when the tenant counts stock — decrements
 * `variants.stock`, all in one transaction. The decrement is why the loop had
 * to go: stock moving for some lines and not others is not something the seller
 * can see, let alone correct.
 *
 * The arithmetic stays in `order-model.ts`, where it is tested without a
 * browser. `line_total` is computed here and written by the RPC; the RPC
 * executes the decision, it does not make it.
 *
 * No stock options are passed. Whether this business counts stock is read from
 * the tenant row inside the function — the client does not get a say.
 */
export async function confirmOrder(
  client: ChopChopClient,
  tenantId: string,
  orderId: string,
  lines: OrderLine[],
): Promise<{ order: OrderRow; lines: OrderLine[] }> {
  const { data, error } = await client.rpc('confirm_order', {
    p_tenant_id: tenantId,
    p_order_id: orderId,
    p_lines: lines.map((line) => ({
      id: line.id,
      qty_confirmed: line.qty_confirmed,
      line_total: lineTotalFor(line),
    })),
  });

  if (error) throw new Error(`Could not confirm the order: ${error.message}`);

  const confirmed = data as unknown as {
    order: OrderRow;
    lines: {
      id: string;
      name_snapshot: string;
      price_snapshot: number | string;
      qty: number | string;
      qty_confirmed: number | string | null;
      line_total: number | string;
    }[];
  };

  // Returned by the RPC so the screen reconciles without a second trip — and so
  // a re-confirm, which changes nothing, still shows what is actually stored.
  return {
    order: confirmed.order,
    lines: confirmed.lines.map((row) => ({
      id: row.id,
      name_snapshot: row.name_snapshot,
      price_snapshot: Number(row.price_snapshot),
      qty: Number(row.qty),
      qty_confirmed: row.qty_confirmed === null ? null : Number(row.qty_confirmed),
      line_total: Number(row.line_total),
    })),
  };
}

/** Formats money the one way the whole dashboard formats money. */
export const money = new Intl.NumberFormat('en-ZA', {
  style: 'currency',
  currency: 'ZAR',
  minimumFractionDigits: 2,
});

export type { SaleMode };
