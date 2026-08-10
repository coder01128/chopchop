import type { ChopChopClient } from '@chopchop/shared';
import {
  batchRows,
  nextSortOrders,
  normalise,
  toSavePayload,
  writableItems,
  type CategoryDecision,
  type ExistingCatalogue,
  type ImportPlan,
  type ParsedRow,
  type PlanOptions,
} from './import-model';

/**
 * The Supabase calls behind import. Decisions live in `import-model.ts`; this
 * file only executes them.
 *
 * Two rules it exists to keep:
 *
 * - **Every product write goes through `save_product`.** That RPC is
 *   SECURITY INVOKER, so RLS applies exactly as it would to a PostgREST call,
 *   and it already solves atomicity, the tenant check and stock-mode
 *   resolution. Reimplementing the inserts here would fork all three.
 * - **Nothing is ever removed.** There is no delete, no retire, no deactivate
 *   in this file, and `save_product` is called with no removals at all.
 */

export async function loadExisting(
  client: ChopChopClient,
  tenantId: string,
): Promise<ExistingCatalogue> {
  const [items, variants, categories] = await Promise.all([
    client
      .from('items')
      .select('id, name, description, image_url, category_id, active')
      .eq('tenant_id', tenantId),
    client
      .from('variants')
      .select('id, item_id, attributes, price, stock, sku, available, retired_at')
      .eq('tenant_id', tenantId),
    client.from('categories').select('id, name, sort_order').eq('tenant_id', tenantId),
  ]);

  if (items.error) throw new Error(`Could not read the catalogue: ${items.error.message}`);
  if (variants.error) throw new Error(`Could not read the catalogue: ${variants.error.message}`);
  if (categories.error) throw new Error(`Could not read categories: ${categories.error.message}`);

  return {
    items: (items.data ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      imageUrl: row.image_url,
      categoryId: row.category_id,
      active: row.active,
    })),
    variants: (variants.data ?? []).map((row) => ({
      id: row.id,
      itemId: row.item_id,
      attributes: (row.attributes ?? {}) as Record<string, string>,
      price: Number(row.price),
      stock: Number(row.stock),
      sku: row.sku,
      available: row.available,
      retiredAt: row.retired_at,
    })),
    categories: (categories.data ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      sortOrder: row.sort_order,
    })),
  };
}

/**
 * The batch row, written when the review screen opens — before anything is
 * committed, so a seller who closes the tab leaves a `pending` row behind
 * rather than no trace at all.
 */
export async function openBatch(
  client: ChopChopClient,
  tenantId: string,
  rows: ParsedRow[],
): Promise<string> {
  const { data, error } = await client
    .from('import_batches')
    .insert({
      tenant_id: tenantId,
      source: 'spreadsheet',
      raw: batchRows(rows),
      status: 'pending',
    })
    .select('id')
    .single();

  if (error) throw new Error(`Could not record the import: ${error.message}`);
  return data.id;
}

/**
 * `applied` means the batch was applied, not that every row in it succeeded —
 * a partial commit is deliberate and stays `applied`. `discarded` is the
 * seller cancelling.
 */
export async function closeBatch(
  client: ChopChopClient,
  batchId: string,
  status: 'applied' | 'discarded',
): Promise<void> {
  const { error } = await client.from('import_batches').update({ status }).eq('id', batchId);
  if (error) throw new Error(`Could not close the import batch: ${error.message}`);
}

export interface ItemFailure {
  name: string;
  message: string;
}

export interface CommitResult {
  categoriesCreated: number;
  itemsWritten: number;
  variantsWritten: number;
  failures: ItemFailure[];
}

/**
 * Creates the categories the seller chose to create, then writes one product
 * per `save_product` call.
 *
 * Per-item failures are collected and reported rather than rolled back: a
 * seller who imported 190 of 200 rows wants the 190. Re-importing the same file
 * is the recovery path — the 190 come back as unchanged.
 */
export async function commitPlan(
  client: ChopChopClient,
  tenantId: string,
  plan: ImportPlan,
  decisions: CategoryDecision[],
  existing: ExistingCatalogue,
  options: PlanOptions,
): Promise<CommitResult> {
  const result: CommitResult = {
    categoriesCreated: 0,
    itemsWritten: 0,
    variantsWritten: 0,
    failures: [],
  };

  // ── categories first, so items have something to attach to ────────────
  const categoryIds = new Map<string, string>();
  for (const decision of decisions) {
    if (decision.action === 'attach' && decision.categoryId) {
      categoryIds.set(decision.key, decision.categoryId);
    }
  }

  const orders = nextSortOrders(decisions, existing.categories);
  const toCreate = decisions.filter((decision) => decision.action === 'create');

  if (toCreate.length > 0) {
    const { data, error } = await client
      .from('categories')
      .insert(
        toCreate.map((decision) => ({
          tenant_id: tenantId,
          name: decision.name,
          sort_order: orders[decision.key] ?? 0,
        })),
      )
      .select('id, name');

    if (error) throw new Error(`Could not create the categories: ${error.message}`);

    for (const row of data ?? []) {
      categoryIds.set(normalise(row.name), row.id);
    }
    result.categoriesCreated = (data ?? []).length;
  }

  // ── one save_product call per product ─────────────────────────────────
  const itemsById = new Map(existing.items.map((item) => [item.id, item]));
  const variantsByItem = new Map<string, typeof existing.variants>();
  for (const variant of existing.variants) {
    variantsByItem.set(variant.itemId, [...(variantsByItem.get(variant.itemId) ?? []), variant]);
  }

  for (const planned of writableItems(plan)) {
    const categoryId =
      planned.categoryName !== null
        ? (categoryIds.get(normalise(planned.categoryName)) ?? null)
        : null;

    const payload = toSavePayload(
      planned,
      planned.itemId ? (itemsById.get(planned.itemId) ?? null) : null,
      planned.itemId ? (variantsByItem.get(planned.itemId) ?? []) : [],
      categoryId,
      options,
    );

    const { error } = await client.rpc('save_product', {
      p_tenant_id: tenantId,
      p_item: payload.item,
      p_variants: payload.variants,
      // Never. An import removes nothing, under any circumstances.
      p_removals: [],
    });

    if (error) {
      result.failures.push({ name: planned.name, message: error.message });
      continue;
    }

    result.itemsWritten += 1;
    result.variantsWritten += payload.variants.length;
  }

  return result;
}
