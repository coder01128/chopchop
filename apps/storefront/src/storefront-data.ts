import type { ChopChopClient, Database } from '@chopchop/shared';
import type { CartLine, StorefrontVariant } from './storefront-model';

/**
 * Every read and write the storefront makes.
 *
 * Two roles reach these functions and both are expected. Before checkout the
 * buyer is the `anon` role, reading the public catalogue policies. After
 * checkout their device holds an anonymous auth session, so the very same
 * queries arrive as `authenticated` and are answered by the buyer policies
 * instead. Nothing here needs to know which — that is the point of having both
 * sets of policies.
 */

export type CategoryRow = Database['public']['Tables']['categories']['Row'];
export type OrderRow = Database['public']['Tables']['orders']['Row'];
export type OrderStatus = Database['public']['Enums']['order_status'];

export interface StorefrontItem {
  id: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  categoryId: string | null;
  variants: StorefrontVariant[];
}

export interface Catalogue {
  categories: CategoryRow[];
  items: StorefrontItem[];
}

/**
 * The shop.
 *
 * Retired variants are not filtered here and must not be: the anon and buyer
 * policies already drop them, and a second client-side filter is a second
 * definition of "retired" that can drift from the one that actually protects
 * the data.
 */
export async function loadCatalogue(
  client: ChopChopClient,
  tenantId: string,
): Promise<Catalogue> {
  const [categories, items, variants] = await Promise.all([
    client
      .from('categories')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('sort_order')
      .order('name'),
    client
      .from('items')
      .select('id, name, description, image_url, category_id')
      .eq('tenant_id', tenantId)
      .order('sort_order')
      .order('name'),
    client
      .from('variants')
      .select('id, item_id, attributes, price, stock, available')
      .eq('tenant_id', tenantId),
  ]);

  if (categories.error) throw new Error(`Could not load the shop: ${categories.error.message}`);
  if (items.error) throw new Error(`Could not load the shop: ${items.error.message}`);
  if (variants.error) throw new Error(`Could not load prices: ${variants.error.message}`);

  const byItem = new Map<string, StorefrontVariant[]>();
  for (const row of variants.data ?? []) {
    const list = byItem.get(row.item_id) ?? [];
    list.push({
      id: row.id,
      itemId: row.item_id,
      attributes: (row.attributes ?? {}) as Record<string, string>,
      price: Number(row.price),
      stock: Number(row.stock),
      available: row.available,
    });
    byItem.set(row.item_id, list);
  }

  return {
    categories: categories.data ?? [],
    items: (items.data ?? [])
      .map((item) => ({
        id: item.id,
        name: item.name,
        description: item.description,
        imageUrl: item.image_url,
        categoryId: item.category_id,
        variants: byItem.get(item.id) ?? [],
      }))
      // A product with no priced variant has nothing to sell.
      .filter((item) => item.variants.length > 0),
  };
}

/**
 * The buyer's identity, created at the last possible moment.
 *
 * SCHEMA.md is explicit that this happens at checkout and not on first visit:
 * anonymous sign-ins drive MAU cost, and `auth.users` should grow with orders
 * rather than with traffic. It also has to complete *before* the order is
 * written — the `anon` role holds no grant on `orders` at all, so a checkout
 * that inserts first fails outright.
 */
export async function ensureBuyerSession(client: ChopChopClient): Promise<string> {
  const { data: existing } = await client.auth.getSession();
  if (existing.session?.user) return existing.session.user.id;

  const { data, error } = await client.auth.signInAnonymously();
  if (error || !data.user) {
    throw new Error(
      `Could not start a session: ${error?.message ?? 'no user returned'}. ` +
        'Anonymous sign-ins must be enabled for this project.',
    );
  }
  return data.user.id;
}

export interface CheckoutDetails {
  customerName: string;
  customerPhone: string;
  deliveryAddress: string;
  notes: string;
}

export interface PlacedOrder {
  order: OrderRow;
  lines: PlacedLine[];
}

export interface PlacedLine {
  id: string;
  name_snapshot: string;
  price_snapshot: number;
  qty: number;
  qty_confirmed: number | null;
  line_total: number;
}

function toLine(row: Record<string, unknown>): PlacedLine {
  return {
    id: String(row.id),
    name_snapshot: String(row.name_snapshot),
    price_snapshot: Number(row.price_snapshot),
    qty: Number(row.qty),
    qty_confirmed: row.qty_confirmed === null ? null : Number(row.qty_confirmed),
    line_total: Number(row.line_total),
  };
}

/**
 * Writes the order and its lines in one call to public.place_order().
 *
 * The cart sends variant ids and quantities and nothing else. Prices, the
 * labels the seller reads, the reference and the total are all produced inside
 * the function from the catalogue rows — a payload price would be a price the
 * buyer chose for themselves.
 */
export async function placeOrder(
  client: ChopChopClient,
  tenantId: string,
  lines: CartLine[],
  details: CheckoutDetails,
): Promise<PlacedOrder> {
  const { data, error } = await client.rpc('place_order', {
    p_tenant_id: tenantId,
    p_lines: lines.map((line) => ({ variant_id: line.variantId, qty: line.qty })),
    p_details: {
      customer_name: details.customerName.trim(),
      customer_phone: details.customerPhone.trim(),
      delivery_address: details.deliveryAddress.trim(),
      notes: details.notes.trim(),
    },
  });

  if (error) throw new Error(error.message.replace(/^place_order:\s*/, ''));

  const placed = data as unknown as { order: OrderRow; lines: Record<string, unknown>[] };
  return { order: placed.order, lines: (placed.lines ?? []).map(toLine) };
}

/**
 * One order for its own buyer.
 *
 * `buyer_id = auth.uid()` is what answers this, which is why the page only
 * works on the device that placed the order. Lines come from `order_items`
 * alone — never joined to `variants`, because a variant retired since the order
 * was placed is filtered out of the buyer's view by policy and the snapshot
 * columns exist precisely so history does not depend on a mutable product row.
 */
export async function loadOrder(
  client: ChopChopClient,
  orderId: string,
): Promise<PlacedOrder | null> {
  const { data: order, error } = await client
    .from('orders')
    .select('*')
    .eq('id', orderId)
    .maybeSingle();

  if (error) throw new Error(`Could not load this order: ${error.message}`);
  if (!order) return null;

  const { data: lines, error: lineError } = await client
    .from('order_items')
    .select('id, name_snapshot, price_snapshot, qty, qty_confirmed, line_total')
    .eq('order_id', orderId)
    .order('name_snapshot');

  if (lineError) throw new Error(`Could not load this order: ${lineError.message}`);

  return { order, lines: (lines ?? []).map((row) => toLine(row as Record<string, unknown>)) };
}
