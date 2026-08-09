import type { ChopChopClient, Database } from '@chopchop/shared';
import { BLOCKING_STATUSES } from '../orders/order-model';
import type { Cell, VariantRecord } from './variant-model';

export type CategoryRow = Database['public']['Tables']['categories']['Row'];
export type ItemRow = Database['public']['Tables']['items']['Row'];
export type OrderStatus = Database['public']['Enums']['order_status'];

/**
 * Statuses where the order is still live, and therefore still holds its
 * variants. A `sent` order may be a phantom the buyer never actually sent, but
 * it still references the variant, so deleting one would throw either way —
 * which is why the queue lets the seller dismiss it.
 *
 * Imported, not redeclared: `cancelled` dropping out of this set is exactly
 * what makes dismissal release a variant. Two copies of the list would drift,
 * and the symptom would be a seller unable to delete a variant with nothing on
 * screen to explain why.
 */
const OPEN_STATUSES = BLOCKING_STATUSES;

export interface ItemSummary {
  item: ItemRow;
  variantCount: number;
  minPrice: number | null;
  maxPrice: number | null;
}

export async function loadCategories(
  client: ChopChopClient,
  tenantId: string,
): Promise<CategoryRow[]> {
  const { data, error } = await client
    .from('categories')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('sort_order')
    .order('name');
  if (error) throw new Error(`Could not load categories: ${error.message}`);
  return data ?? [];
}

/**
 * Items plus the price range and variant count each card shows.
 *
 * Two queries and a client-side join rather than a view: v1 scope explicitly
 * excludes catalogues in the thousands, and a view would be a migration.
 */
export async function loadItems(
  client: ChopChopClient,
  tenantId: string,
): Promise<ItemSummary[]> {
  const [items, variants] = await Promise.all([
    client.from('items').select('*').eq('tenant_id', tenantId).order('sort_order').order('name'),
    client.from('variants').select('item_id, price').eq('tenant_id', tenantId),
  ]);

  if (items.error) throw new Error(`Could not load products: ${items.error.message}`);
  if (variants.error) throw new Error(`Could not load prices: ${variants.error.message}`);

  const byItem = new Map<string, number[]>();
  for (const variant of variants.data ?? []) {
    const prices = byItem.get(variant.item_id) ?? [];
    prices.push(Number(variant.price));
    byItem.set(variant.item_id, prices);
  }

  return (items.data ?? []).map((item) => {
    const prices = byItem.get(item.id) ?? [];
    return {
      item,
      variantCount: prices.length,
      minPrice: prices.length ? Math.min(...prices) : null,
      maxPrice: prices.length ? Math.max(...prices) : null,
    };
  });
}

export async function loadVariants(
  client: ChopChopClient,
  itemId: string,
): Promise<VariantRecord[]> {
  const { data, error } = await client
    .from('variants')
    .select('id, attributes, price, stock, available, sku, retired_at')
    .eq('item_id', itemId);
  if (error) throw new Error(`Could not load variants: ${error.message}`);

  return (data ?? []).map((row) => ({
    id: row.id,
    attributes: (row.attributes ?? {}) as Record<string, string>,
    price: Number(row.price),
    stock: Number(row.stock),
    available: row.available,
    sku: row.sku,
    retiredAt: row.retired_at,
  }));
}

export type RemovalVerdict = 'deletable' | 'retire-only' | 'blocked';

/** An order standing in the way of a removal, named so the seller can go and deal with it. */
export interface BlockingOrder {
  reference: string;
  status: OrderStatus;
  createdAt: string;
}

export interface VariantUsage {
  verdict: RemovalVerdict;
  orderCount: number;
  openCount: number;
  /** Open orders only — the ones the seller can actually act on. */
  blockingOrders: BlockingOrder[];
}

/**
 * Can this variant be removed?
 *
 * `order_items.variant_id` is ON DELETE RESTRICT, so a delete on an ordered
 * variant throws a foreign key violation. The seller must never see that, so
 * the question is asked before the control is offered rather than after it is
 * pressed.
 */
export async function classifyVariants(
  client: ChopChopClient,
  variantIds: string[],
): Promise<Record<string, VariantUsage>> {
  const usage: Record<string, VariantUsage> = {};
  for (const id of variantIds) {
    usage[id] = { verdict: 'deletable', orderCount: 0, openCount: 0, blockingOrders: [] };
  }
  if (variantIds.length === 0) return usage;

  const { data, error } = await client
    .from('order_items')
    .select('variant_id, orders!inner(reference, status, created_at)')
    .in('variant_id', variantIds);

  if (error) throw new Error(`Could not check order history: ${error.message}`);

  for (const line of data ?? []) {
    const entry = usage[line.variant_id];
    if (!entry) continue;
    entry.orderCount += 1;

    const order = line.orders as unknown as {
      reference: string;
      status: OrderStatus;
      created_at: string;
    };

    if (OPEN_STATUSES.includes(order.status)) {
      entry.openCount += 1;
      // Named, not counted: "1 open order" tells the seller nothing they can
      // act on. A47 · sent · 2 days ago tells them where to look.
      if (!entry.blockingOrders.some((existing) => existing.reference === order.reference)) {
        entry.blockingOrders.push({
          reference: order.reference,
          status: order.status,
          createdAt: order.created_at,
        });
      }
    }
  }

  for (const entry of Object.values(usage)) {
    entry.blockingOrders.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (entry.openCount > 0) entry.verdict = 'blocked';
    else if (entry.orderCount > 0) entry.verdict = 'retire-only';
  }

  return usage;
}

/** "2 days ago" — enough for a seller to judge whether an order is a phantom. */
export function describeAge(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export interface ItemDraft {
  id: string | null;
  name: string;
  description: string;
  imageUrl: string;
  categoryId: string | null;
  active: boolean;
}

export interface SaveResult {
  itemId: string;
  deleted: number;
  retired: number;
  variants: VariantRecord[];
}

/**
 * Writes the product, its variants and its removals — in one transaction.
 *
 * This is a single call to public.save_product(), which is SECURITY INVOKER, so
 * RLS applies exactly as it did to the sequence of PostgREST calls this
 * replaced. It either all happens or none of it does: a failure part-way used
 * to leave an item with some of its variants written, which is the kind of
 * corruption nobody notices until a price is wrong on the storefront.
 *
 * The RPC executes decisions; it does not make them. `classifyVariants` above
 * decides what may be deleted and what must be retired, because that question
 * is about order history and belongs with the code that explains it to the
 * seller. Blocked removals are dropped here and never reach the database.
 */
export async function saveProduct(
  client: ChopChopClient,
  tenantId: string,
  draft: ItemDraft,
  cells: Cell[],
  removals: { id: string; verdict: RemovalVerdict }[],
): Promise<SaveResult> {
  const actionable = removals
    .filter((removal) => removal.verdict !== 'blocked')
    .map((removal) => ({
      id: removal.id,
      action: removal.verdict === 'deletable' ? 'delete' : 'retire',
    }));

  const { data, error } = await client.rpc('save_product', {
    p_tenant_id: tenantId,
    p_item: {
      id: draft.id,
      name: draft.name.trim(),
      description: draft.description.trim(),
      image_url: draft.imageUrl.trim(),
      category_id: draft.categoryId,
      active: draft.active,
    },
    p_variants: cells.map((cell) => ({
      id: cell.variantId,
      attributes: cell.attributes,
      price: Number(cell.price),
      // Sent regardless; the RPC ignores it for an availability tenant rather
      // than trusting the client to know which mode the business is in.
      stock: cell.stock.trim() === '' ? null : Number(cell.stock),
      available: cell.available,
      sku: cell.sku.trim(),
    })),
    p_removals: actionable,
  });

  if (error) throw new Error(`Could not save the product: ${error.message}`);

  const saved = data as unknown as {
    item: ItemRow;
    variants: {
      id: string;
      attributes: unknown;
      price: number | string;
      stock: number | string;
      available: boolean;
      sku: string | null;
      retired_at: string | null;
    }[];
  };

  // Counted from what came back, not from what was asked for: a delete whose
  // variant was ordered in the seconds the modal was open falls back to a
  // retire inside the RPC, and the seller should be told what happened.
  const survivors = new Set(saved.variants.map((row) => row.id));

  return {
    itemId: saved.item.id,
    deleted: actionable.filter((removal) => !survivors.has(removal.id)).length,
    retired: actionable.filter((removal) => survivors.has(removal.id)).length,
    variants: saved.variants.map((row) => ({
      id: row.id,
      attributes: (row.attributes ?? {}) as Record<string, string>,
      price: Number(row.price),
      stock: Number(row.stock),
      available: row.available,
      sku: row.sku,
      retiredAt: row.retired_at,
    })),
  };
}
