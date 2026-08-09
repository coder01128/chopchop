import { useEffect, useMemo, useRef, useState } from 'react';
import { getSupabaseClient, useTenant } from '@chopchop/shared';
import {
  classifyVariants,
  describeAge,
  loadVariants,
  saveProduct,
  type CategoryRow,
  type ItemDraft,
  type ItemRow,
  type RemovalVerdict,
  type VariantUsage,
} from './catalogue-data';
import {
  activeCells,
  deriveShape,
  droppedVariantIds,
  restoreVariant,
  retiredVariants,
  storeFromVariants,
  validateCells,
  type CellError,
  type CellStore,
  type ProductShape,
  type VariantRecord,
} from './variant-model';
import { VariantEditor } from './VariantEditor';
import styles from './ProductModal.module.css';

const EMPTY_DRAFT: ItemDraft = {
  id: null,
  name: '',
  description: '',
  imageUrl: '',
  categoryId: null,
  active: true,
};

interface Removal {
  id: string;
  label: string;
  usage: VariantUsage;
}

/**
 * Add / edit product.
 *
 * The top half is identical for every tenant on earth — name, description,
 * category, image, active. The bottom half is generated. Nothing above the
 * variant editor branches on what the client sells.
 */
export function ProductModal({
  item,
  categories,
  onClose,
  onSaved,
}: {
  item: ItemRow | null;
  categories: CategoryRow[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const tenant = useTenant();
  const client = getSupabaseClient();
  const dialogRef = useRef<HTMLDivElement>(null);

  const [draft, setDraft] = useState<ItemDraft>(EMPTY_DRAFT);
  const [shape, setShape] = useState<ProductShape>({ names: [], values: {} });
  const [store, setStore] = useState<CellStore>({});
  const [original, setOriginal] = useState<CellStore>({});
  const [retired, setRetired] = useState<VariantRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [removals, setRemovals] = useState<Removal[] | null>(null);

  useEffect(() => {
    let active = true;

    async function load() {
      setLoading(true);
      setFailure(null);

      if (!item) {
        setDraft(EMPTY_DRAFT);
        setShape({ names: [], values: {} });
        setStore({});
        setOriginal({});
        setRetired([]);
        setLoading(false);
        return;
      }

      setDraft({
        id: item.id,
        name: item.name,
        description: item.description ?? '',
        imageUrl: item.image_url ?? '',
        categoryId: item.category_id,
        active: item.active,
      });

      try {
        const variants = await loadVariants(client, item.id);
        if (!active) return;
        // Palette, not mandate: the shape comes from this product's own
        // variants, never from the tenant row. A product created before the
        // business gained an attribute keeps its own shape.
        setShape(deriveShape(variants, tenant.attributeSchema));
        const built = storeFromVariants(variants);
        setStore(built);
        setOriginal(built);
        // Retired variants are excluded from both of the above — they are not a
        // choice the seller currently has made, so they render as their own
        // block rather than as ticked values.
        setRetired(retiredVariants(variants));
      } catch (error) {
        if (active) setFailure(error instanceof Error ? error.message : String(error));
      } finally {
        if (active) setLoading(false);
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [item, client, tenant.attributeSchema]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape' && !saving) onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, saving]);

  const cells = useMemo(() => activeCells(shape, store), [shape, store]);

  const errors: CellError[] = useMemo(() => {
    const list = validateCells(cells, shape, tenant.attributeSchema, original);
    if (!draft.name.trim()) {
      list.unshift({ key: '__name', message: 'This product needs a name.' });
    }
    return list;
  }, [cells, shape, tenant.attributeSchema, original, draft.name]);

  const newCellCount = cells.filter((cell) => cell.isNew).length;
  const missingPrices = cells.filter((cell) => cell.isNew && cell.price.trim() === '').length;

  /** Attributes already carried by saved variants cannot be switched off. */
  const lockedAttributes = useMemo(
    () =>
      Array.from(
        new Set(
          Object.values(original)
            .filter((cell) => cell.variantId)
            .flatMap((cell) => Object.keys(cell.attributes)),
        ),
      ),
    [original],
  );

  async function onSubmit() {
    setShowErrors(true);
    setFailure(null);
    if (errors.length > 0) return;

    const dropped = droppedVariantIds(original, shape);

    if (dropped.length > 0) {
      // ON DELETE RESTRICT: ask Postgres what is safe before offering a control
      // that would otherwise throw a foreign key violation at the seller.
      try {
        const usage = await classifyVariants(client, dropped);
        setRemovals(
          dropped.map((id) => {
            const cell = Object.values(original).find((entry) => entry.variantId === id)!;
            return {
              id,
              label: Object.entries(cell.attributes)
                .map(([name, value]) => `${name} ${value}`)
                .join(' · '),
              usage: usage[id],
            };
          }),
        );
      } catch (error) {
        setFailure(error instanceof Error ? error.message : String(error));
      }
      return;
    }

    await commit([]);
  }

  async function commit(confirmedRemovals: { id: string; verdict: RemovalVerdict }[]) {
    setSaving(true);
    setFailure(null);
    try {
      const result = await saveProduct(client, tenant.id, draft, cells, confirmedRemovals);

      const parts = [`Saved ${draft.name.trim()}`];
      if (result.deleted) parts.push(`${result.deleted} variant(s) deleted`);
      if (result.retired) parts.push(`${result.retired} retired but kept for order history`);
      onSaved(`${parts.join(' · ')}.`);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
      setSaving(false);
      setRemovals(null);
    }
  }

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-label={item ? 'Edit product' : 'Add product'} ref={dialogRef}>
        <header className={styles.head}>
          <h2 className={styles.title}>{item ? 'Edit product' : 'Add product'}</h2>
          <div className={styles.headActions}>
            <button type="button" className={styles.ghost} onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="button" className={styles.primary} onClick={() => void onSubmit()} disabled={saving || loading}>
              {saving ? 'Saving…' : 'Save product'}
            </button>
          </div>
        </header>

        {loading ? (
          <p className={styles.loading}>Loading…</p>
        ) : (
          <div className={styles.body}>
            {/* ── the universal half ── */}
            <div className={styles.universal}>
              <div className={styles.leftColumn}>
                <label className={styles.field}>
                  <span>Name</span>
                  <input
                    type="text"
                    value={draft.name}
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                    aria-invalid={showErrors && !draft.name.trim() ? true : undefined}
                  />
                </label>

                <label className={styles.field}>
                  <span>Description</span>
                  <textarea
                    rows={3}
                    value={draft.description}
                    onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                  />
                </label>

                <label className={styles.field}>
                  <span>Category</span>
                  <select
                    value={draft.categoryId ?? ''}
                    onChange={(event) =>
                      setDraft({ ...draft, categoryId: event.target.value || null })
                    }
                  >
                    <option value="">No category</option>
                    {categories.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                        {category.active ? '' : ' (hidden)'}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className={styles.rightColumn}>
                <label className={styles.field}>
                  <span>Image URL</span>
                  <input
                    type="url"
                    value={draft.imageUrl}
                    placeholder="optional"
                    onChange={(event) => setDraft({ ...draft, imageUrl: event.target.value })}
                  />
                </label>
                {/* Optional, and it stays optional — most clients upload photos
                    late or never. */}
                <div className={styles.preview} data-empty={draft.imageUrl.trim() ? undefined : true}>
                  {draft.imageUrl.trim() ? (
                    <img src={draft.imageUrl} alt="" onError={(event) => event.currentTarget.remove()} />
                  ) : (
                    <span>No photo</span>
                  )}
                </div>
                <label className={styles.toggle}>
                  <input
                    type="checkbox"
                    checked={draft.active}
                    onChange={(event) => setDraft({ ...draft, active: event.target.checked })}
                  />
                  <span>Visible in the shop</span>
                </label>
              </div>
            </div>

            {/* ── the generated half ── */}
            {newCellCount > 0 && missingPrices > 0 && (
              <p className={styles.banner}>
                {missingPrices === 1
                  ? '1 new variant needs a price before this product saves.'
                  : `${missingPrices} new variants need a price before this product saves.`}
              </p>
            )}

            <VariantEditor
              palette={tenant.attributeSchema}
              shape={shape}
              onShapeChange={setShape}
              store={store}
              onStoreChange={setStore}
              original={original}
              saleMode={tenant.saleMode}
              stockMode={tenant.stockMode}
              errors={showErrors ? errors : []}
              lockedAttributes={lockedAttributes}
              retired={retired}
              onRestore={(variant) => {
                const next = restoreVariant(shape, store, variant, tenant.attributeSchema);
                setShape(next.shape);
                setStore(next.store);
                setRetired((current) => current.filter((entry) => entry.id !== variant.id));
              }}
            />

            {showErrors && errors.length > 0 && (
              <div className={styles.errorList} role="alert">
                <p className={styles.errorHead}>This product cannot be saved yet:</p>
                <ul>
                  {errors.map((error) => (
                    <li key={`${error.key}${error.message}`}>{error.message}</li>
                  ))}
                </ul>
              </div>
            )}

            {failure && (
              <p className={styles.failure} role="alert">
                {failure}
              </p>
            )}
          </div>
        )}
      </div>

      {removals && (
        <RemovalDialog
          removals={removals}
          onCancel={() => setRemovals(null)}
          onConfirm={(confirmed) => void commit(confirmed)}
        />
      )}
    </div>
  );
}

/**
 * What happens to variants the seller has just unticked.
 *
 * Three outcomes, and the seller sees which applies to each before anything is
 * written. They never see a foreign key violation.
 */
function RemovalDialog({
  removals,
  onCancel,
  onConfirm,
}: {
  removals: Removal[];
  onCancel: () => void;
  onConfirm: (confirmed: { id: string; verdict: RemovalVerdict }[]) => void;
}) {
  const deletable = removals.filter((entry) => entry.usage.verdict === 'deletable');
  const retire = removals.filter((entry) => entry.usage.verdict === 'retire-only');
  const blocked = removals.filter((entry) => entry.usage.verdict === 'blocked');

  return (
    <div className={styles.confirmBackdrop} role="presentation">
      <div className={styles.confirm} role="dialog" aria-modal="true" aria-label="Confirm variant removal">
        <h3 className={styles.confirmTitle}>
          {removals.length} variant{removals.length === 1 ? '' : 's'} removed from this product
        </h3>

        {deletable.length > 0 && (
          <section className={styles.confirmGroup}>
            <p className={styles.confirmLead}>Never ordered — these will be deleted:</p>
            <ul>
              {deletable.map((entry) => (
                <li key={entry.id}>{entry.label}</li>
              ))}
            </ul>
          </section>
        )}

        {retire.length > 0 && (
          <section className={styles.confirmGroup}>
            <p className={styles.confirmLead}>
              These appear in completed orders, so they cannot be deleted without rewriting order
              history. They will be retired instead — kept, hidden from buyers, and listed under
              Retired where you can restore them:
            </p>
            <ul>
              {retire.map((entry) => (
                <li key={entry.id}>
                  {entry.label}{' '}
                  <span className={styles.count}>{entry.usage.orderCount} order line(s)</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {blocked.length > 0 && (
          <section className={styles.confirmGroup} data-tone="blocked">
            <p className={styles.confirmLead}>
              These are on orders that are still open, so nothing will change for them yet. Deal
              with the orders first — an order that was never really placed can be cancelled:
            </p>
            <ul>
              {blocked.map((entry) => (
                <li key={entry.id}>
                  {entry.label}
                  {/* Naming the orders, not counting them: "1 open order" tells
                      the seller nothing they can act on. */}
                  <ul className={styles.orderList}>
                    {entry.usage.blockingOrders.map((order) => (
                      <li key={order.reference}>
                        <span className={styles.orderRef}>{order.reference}</span>
                        <span className={styles.count}>
                          {order.status} · {describeAge(order.createdAt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className={styles.confirmActions}>
          <button type="button" className={styles.ghost} onClick={onCancel}>
            Go back
          </button>
          <button
            type="button"
            className={styles.primary}
            onClick={() =>
              onConfirm(removals.map((entry) => ({ id: entry.id, verdict: entry.usage.verdict })))
            }
          >
            Save anyway
          </button>
        </div>
      </div>
    </div>
  );
}
