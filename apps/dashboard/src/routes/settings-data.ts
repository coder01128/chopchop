import { IMAGE_BUCKET, pathBelongsToTenant, type ChopChopClient } from '@chopchop/shared';

/**
 * `tenants.listed` — read and written here and nowhere else.
 *
 * It is deliberately not on `TenantConfig`. The storefront must never read it
 * (the `anon` column grant does not include it), and putting it on the shared
 * config would put it one autocomplete away from a buyer-facing screen. One
 * extra round trip on the one screen that owns the setting is the cheaper
 * mistake.
 */
export async function loadListed(client: ChopChopClient, tenantId: string): Promise<boolean> {
  const { data, error } = await client
    .from('tenants')
    .select('listed')
    .eq('id', tenantId)
    .single();

  if (error) throw new Error(error.message);
  return data.listed;
}

export async function setListed(
  client: ChopChopClient,
  tenantId: string,
  listed: boolean,
): Promise<void> {
  const { error } = await client.from('tenants').update({ listed }).eq('id', tenantId);
  if (error) throw new Error(error.message);
}

export interface CatalogueDeleteResult {
  itemsDeleted: number;
  /** Products kept, hidden, because a variant of theirs is in order history. */
  itemsKept: number;
  variantsDeleted: number;
  variantsRetired: number;
  categoriesDeleted: number;
  importBatchesDeleted: number;
  photosRemoved: number;
  /** Photographs Storage would not remove. The catalogue itself is already gone. */
  photosFailed: number;
}

export type CatalogueDeleteFailure = 'open-orders' | 'not-owner' | 'failed';

export class CatalogueDeleteError extends Error {
  constructor(
    readonly kind: CatalogueDeleteFailure,
    readonly openOrders = 0,
  ) {
    super(kind);
  }
}

/**
 * Delete every category, product, variant and import batch for the tenant,
 * then every photograph.
 *
 * The database half is one call to public.delete_catalogue(), which is a single
 * transaction: it either all happens or none of it does. Orders are never
 * touched. Variants that appear in order history cannot be deleted
 * (`order_items.variant_id` is ON DELETE RESTRICT), so they are retired and
 * their products hidden; the result counts them so the screen can say so
 * instead of claiming a clean slate that is not one.
 *
 * Photographs go second, and a failure there does not fail the whole call. The
 * rows are already gone and nothing references the files, so an orphaned photo
 * costs storage, not correctness. Doing it the other way round would leave
 * products pointing at photographs that no longer exist.
 */
export async function deleteCatalogue(
  client: ChopChopClient,
  tenantId: string,
): Promise<CatalogueDeleteResult> {
  const { data, error } = await client.rpc('delete_catalogue', { p_tenant_id: tenantId });

  if (error) {
    // 55000 is the function's "open orders" refusal; the count is in the message.
    if (error.code === '55000') {
      const count = Number(/(\d+) open order/.exec(error.message)?.[1] ?? 0);
      throw new CatalogueDeleteError('open-orders', count);
    }
    if (error.code === '42501') throw new CatalogueDeleteError('not-owner');
    throw new CatalogueDeleteError('failed');
  }

  const counts = (data ?? {}) as Record<string, number>;
  const photos = await removeAllPhotos(client, tenantId);

  return {
    itemsDeleted: counts.items_deleted ?? 0,
    itemsKept: counts.items_kept ?? 0,
    variantsDeleted: counts.variants_deleted ?? 0,
    variantsRetired: counts.variants_retired ?? 0,
    categoriesDeleted: counts.categories_deleted ?? 0,
    importBatchesDeleted: counts.import_batches_deleted ?? 0,
    ...photos,
  };
}

const LIST_PAGE = 1000;
const REMOVE_BATCH = 100;

/** Every object path under the tenant's prefix: `<tenant>/<item>/<file>`. */
async function listTenantPhotoPaths(client: ChopChopClient, tenantId: string): Promise<string[]> {
  const bucket = client.storage.from(IMAGE_BUCKET);

  async function listAll(prefix: string) {
    const entries: { name: string; id: string | null }[] = [];
    for (let offset = 0; ; offset += LIST_PAGE) {
      const { data, error } = await bucket.list(prefix, { limit: LIST_PAGE, offset });
      if (error) throw new Error(error.message);
      entries.push(...(data ?? []));
      if (!data || data.length < LIST_PAGE) return entries;
    }
  }

  const paths: string[] = [];
  // `list` is one level deep. A null id marks a folder — here, one per product.
  for (const entry of await listAll(tenantId)) {
    if (entry.id === null) {
      for (const file of await listAll(`${tenantId}/${entry.name}`)) {
        if (file.id !== null) paths.push(`${tenantId}/${entry.name}/${file.name}`);
      }
    } else {
      paths.push(`${tenantId}/${entry.name}`);
    }
  }
  return paths;
}

async function removeAllPhotos(
  client: ChopChopClient,
  tenantId: string,
): Promise<{ photosRemoved: number; photosFailed: number }> {
  let paths: string[];
  try {
    // Same client-side guard as deleteProductImage: Storage answers a denied
    // delete with an empty result, so never ask it about a foreign path.
    paths = (await listTenantPhotoPaths(client, tenantId)).filter((path) =>
      pathBelongsToTenant(path, tenantId),
    );
  } catch {
    // Could not even list them. The catalogue is deleted; the count of leftover
    // photographs is unknown, which is reported as zero rather than invented.
    return { photosRemoved: 0, photosFailed: 0 };
  }

  let removed = 0;
  for (let i = 0; i < paths.length; i += REMOVE_BATCH) {
    const batch = paths.slice(i, i + REMOVE_BATCH);
    const { data, error } = await client.storage.from(IMAGE_BUCKET).remove(batch);
    if (!error) removed += data?.length ?? 0;
  }

  return { photosRemoved: removed, photosFailed: paths.length - removed };
}
