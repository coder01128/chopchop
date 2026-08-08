import type { ChopChopClient, Database } from '@chopchop/shared';
import type { Cell, VariantRecord } from './variant-model';

export type CategoryRow = Database['public']['Tables']['categories']['Row'];
export type ItemRow = Database['public']['Tables']['items']['Row'];
export type OrderStatus = Database['public']['Enums']['order_status'];

/**
 * Statuses where the order is still live. A `sent` order may be a phantom the
 * buyer never actually sent, but it still references the variant, so deleting
 * one would throw either way.
 */
const OPEN_STATUSES: OrderStatus[] = ['sent', 'received', 'confirmed', 'ready'];

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
    .select('id, attributes, price, stock, available, sku')
    .eq('item_id', itemId);
  if (error) throw new Error(`Could not load variants: ${error.message}`);

  return (data ?? []).map((row) => ({
    id: row.id,
    attributes: (row.attributes ?? {}) as Record<string, string>,
    price: Number(row.price),
    stock: Number(row.stock),
    available: row.available,
    sku: row.sku,
  }));
}

export type RemovalVerdict = 'deletable' | 'deactivate-only' | 'blocked';

export interface VariantUsage {
  verdict: RemovalVerdict;
  orderCount: number;
  openCount: number;
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
    usage[id] = { verdict: 'deletable', orderCount: 0, openCount: 0 };
  }
  if (variantIds.length === 0) return usage;

  const { data, error } = await client
    .from('order_items')
    .select('variant_id, orders!inner(status)')
    .in('variant_id', variantIds);

  if (error) throw new Error(`Could not check order history: ${error.message}`);

  for (const line of data ?? []) {
    const entry = usage[line.variant_id];
    if (!entry) continue;
    entry.orderCount += 1;
    const status = (line.orders as unknown as { status: OrderStatus }).status;
    if (OPEN_STATUSES.includes(status)) entry.openCount += 1;
  }

  for (const entry of Object.values(usage)) {
    if (entry.openCount > 0) entry.verdict = 'blocked';
    else if (entry.orderCount > 0) entry.verdict = 'deactivate-only';
  }

  return usage;
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
  deactivated: number;
}

/**
 * Writes the product and its variants.
 *
 * PostgREST has no transaction across requests, so this is ordered so that a
 * failure part-way leaves something coherent: the item first, then variant
 * writes, then removals last. A half-saved product is recoverable by opening it
 * again; a half-removed one would not be.
 *
 * `stock` is omitted entirely for availability tenants — they are not shown a
 * stock figure, and writing one would either invent data or silently zero what
 * is already there.
 */
export async function saveProduct(
  client: ChopChopClient,
  tenantId: string,
  draft: ItemDraft,
  cells: Cell[],
  removals: { id: string; verdict: RemovalVerdict }[],
  options: { tracksStock: boolean },
): Promise<SaveResult> {
  const itemPayload = {
    tenant_id: tenantId,
    name: draft.name.trim(),
    description: draft.description.trim() || null,
    image_url: draft.imageUrl.trim() || null,
    category_id: draft.categoryId,
    active: draft.active,
  };

  let itemId = draft.id;

  if (itemId) {
    const { error } = await client.from('items').update(itemPayload).eq('id', itemId);
    if (error) throw new Error(`Could not save the product: ${error.message}`);
  } else {
    const { data, error } = await client.from('items').insert(itemPayload).select('id').single();
    if (error) throw new Error(`Could not save the product: ${error.message}`);
    itemId = data.id;
  }

  const inserts = cells
    .filter((cell) => !cell.variantId)
    .map((cell) => ({
      tenant_id: tenantId,
      item_id: itemId,
      attributes: cell.attributes,
      price: Number(cell.price),
      available: cell.available,
      sku: cell.sku.trim() || null,
      ...(options.tracksStock ? { stock: Number(cell.stock || 0) } : {}),
    }));

  if (inserts.length) {
    const { error } = await client.from('variants').insert(inserts);
    if (error) throw new Error(`Could not add the new variants: ${error.message}`);
  }

  for (const cell of cells) {
    if (!cell.variantId) continue;
    const { error } = await client
      .from('variants')
      .update({
        attributes: cell.attributes,
        price: Number(cell.price),
        available: cell.available,
        sku: cell.sku.trim() || null,
        ...(options.tracksStock ? { stock: Number(cell.stock || 0) } : {}),
      })
      .eq('id', cell.variantId);
    if (error) throw new Error(`Could not update a variant: ${error.message}`);
  }

  let deleted = 0;
  let deactivated = 0;

  for (const removal of removals) {
    if (removal.verdict === 'blocked') continue;

    if (removal.verdict === 'deletable') {
      const { error } = await client.from('variants').delete().eq('id', removal.id);
      // Belt and braces: the classification could be a moment stale if an order
      // arrived while the modal was open. Fall back to deactivating rather than
      // surfacing a foreign key violation.
      if (error) {
        const { error: deactivateError } = await client
          .from('variants')
          .update({ available: false })
          .eq('id', removal.id);
        if (deactivateError) throw new Error(`Could not remove a variant: ${deactivateError.message}`);
        deactivated += 1;
      } else {
        deleted += 1;
      }
      continue;
    }

    const { error } = await client.from('variants').update({ available: false }).eq('id', removal.id);
    if (error) throw new Error(`Could not deactivate a variant: ${error.message}`);
    deactivated += 1;
  }

  return { itemId: itemId!, deleted, deactivated };
}
