import { useMemo, useState } from 'react';
import type { SaleMode, StockMode, TenantAttribute } from '@chopchop/shared';
import {
  activeCells,
  applyBulkFill,
  comboKey,
  describeCell,
  type Cell,
  type CellError,
  type CellStore,
  type ProductShape,
  type VariantRecord,
} from './variant-model';
import styles from './VariantEditor.module.css';

/**
 * The generated variant editor.
 *
 * There is one of these. A butchery gets two priced rows out of it and a shoe
 * shop gets a nine-cell grid, from the same code path — the difference is
 * entirely the tenant's `attribute_schema`, `sale_mode` and `stock_mode`.
 *
 * The only two things in here that branch on tenant config are the attribute
 * list and the row anatomy (wireframe section 06). If a third appears, the
 * abstraction is leaking.
 */
export function VariantEditor({
  palette,
  shape,
  onShapeChange,
  store,
  onStoreChange,
  original,
  saleMode,
  stockMode,
  errors,
  lockedAttributes,
  retired,
  onRestore,
}: {
  palette: TenantAttribute[];
  shape: ProductShape;
  onShapeChange: (shape: ProductShape) => void;
  store: CellStore;
  onStoreChange: (store: CellStore) => void;
  original: CellStore;
  saleMode: SaleMode;
  stockMode: StockMode;
  errors: CellError[];
  /** Attributes already in use by saved variants — cannot be switched off. */
  lockedAttributes: string[];
  /** Removed, but kept because they appear in order history. */
  retired: VariantRecord[];
  onRestore: (variant: VariantRecord) => void;
}) {
  const cells = useMemo(() => activeCells(shape, store), [shape, store]);
  const tracksStock = stockMode === 'counted';
  const decimalQuantities = saleMode === 'weight';

  const errorsByKey = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const error of errors) {
      (map[error.key] ??= []).push(error.message);
    }
    return map;
  }, [errors]);

  function updateCell(cell: Cell, patch: Partial<Cell>) {
    onStoreChange({ ...store, [cell.key]: { ...cell, ...patch } });
  }

  function toggleAttribute(name: string) {
    if (lockedAttributes.includes(name)) return;

    if (shape.names.includes(name)) {
      const names = shape.names.filter((entry) => entry !== name);
      const values = { ...shape.values };
      delete values[name];
      onShapeChange({ names, values });
      return;
    }

    const options = palette.find((attribute) => attribute.name === name)?.options ?? [];
    onShapeChange({
      names: [...shape.names, name],
      // Nothing is ticked by default: generating every combination and asking
      // the seller to delete is the wrong way round (wireframe section 03).
      values: { ...shape.values, [name]: options.length === 1 ? [...options] : [] },
    });
  }

  function toggleValue(name: string, value: string) {
    const current = shape.values[name] ?? [];
    const next = current.includes(value)
      ? current.filter((entry) => entry !== value)
      : [...current, value];
    onShapeChange({ ...shape, values: { ...shape.values, [name]: next } });
  }

  /** True when unticking this value would drop a variant that already exists. */
  function valueHasSavedVariants(name: string, value: string): boolean {
    return Object.values(original).some(
      (cell) => cell.variantId !== null && cell.attributes[name] === value,
    );
  }

  return (
    <section className={styles.editor}>
      <header className={styles.sectionHead}>
        <h3 className={styles.sectionTitle}>Variants</h3>
        {shape.names.length === 0 && palette.length > 0 && (
          <p className={styles.hint}>
            No options chosen — this product will have a single price.
          </p>
        )}
      </header>

      {palette.length > 0 && (
        <fieldset className={styles.attributes}>
          <legend className={styles.legend}>Options this product comes in</legend>
          <div className={styles.chipRow}>
            {palette.map((attribute) => {
              const on = shape.names.includes(attribute.name);
              const locked = lockedAttributes.includes(attribute.name);
              return (
                <label
                  key={attribute.name}
                  className={styles.chip}
                  data-on={on || undefined}
                  data-locked={locked || undefined}
                  title={locked ? 'Already used by saved variants — cannot be switched off.' : undefined}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={locked}
                    onChange={() => toggleAttribute(attribute.name)}
                  />
                  {attribute.label || attribute.name}
                </label>
              );
            })}
          </div>
        </fieldset>
      )}

      {shape.names.map((name) => {
        const attribute = palette.find((entry) => entry.name === name);
        // Values already on saved variants may no longer be in the palette.
        // They still have to be listed, or the seller cannot see what exists.
        const options = [
          ...(attribute?.options ?? []),
          ...(shape.values[name] ?? []).filter((value) => !(attribute?.options ?? []).includes(value)),
        ];

        return (
          <fieldset className={styles.attributes} key={name}>
            <legend className={styles.legend}>{attribute?.label || name} — tick which apply</legend>
            <div className={styles.chipRow}>
              {options.map((value) => {
                const ticked = (shape.values[name] ?? []).includes(value);
                const retired = !(attribute?.options ?? []).includes(value);
                return (
                  <label
                    key={value}
                    className={styles.chip}
                    data-on={ticked || undefined}
                    title={retired ? 'No longer offered by this business, but this product uses it.' : undefined}
                  >
                    <input type="checkbox" checked={ticked} onChange={() => toggleValue(name, value)} />
                    {value}
                    {retired && <span className={styles.retired}>retired</span>}
                    {ticked && valueHasSavedVariants(name, value) && (
                      <span className={styles.saved} aria-label="has saved variants">
                        saved
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          </fieldset>
        );
      })}

      {cells.length > 1 && (
        <BulkFill
          tracksStock={tracksStock}
          onApply={(field, value, overwrite) => {
            const filled = applyBulkFill(cells, field, value, overwrite);
            const next = { ...store };
            for (const cell of filled) next[cell.key] = cell;
            onStoreChange(next);
          }}
        />
      )}

      {cells.length === 0 ? (
        <p className={styles.empty}>
          Tick at least one value above to price this product.
        </p>
      ) : (
        <div className={styles.cells} data-layout={shape.names.length >= 2 ? 'grid' : 'rows'}>
          {cells.map((cell) => {
            const cellErrors = errorsByKey[cell.key] ?? [];
            const heading = describeCell(cell, shape);
            return (
              <article
                key={cell.key}
                className={styles.cell}
                data-new={cell.isNew || undefined}
                data-invalid={cellErrors.length ? true : undefined}
              >
                {shape.names.length > 0 && (
                  <header className={styles.cellHead}>
                    <span className={styles.cellTitle}>{heading}</span>
                    {cell.isNew && <span className={styles.newFlag}>new</span>}
                  </header>
                )}

                <div className={styles.fields}>
                  <label className={styles.field}>
                    <span>{decimalQuantities ? 'Price per unit' : 'Price'}</span>
                    <div className={styles.moneyInput}>
                      <span aria-hidden="true">R</span>
                      <input
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="0.01"
                        value={cell.price}
                        placeholder="0.00"
                        onChange={(event) => updateCell(cell, { price: event.target.value })}
                      />
                    </div>
                  </label>

                  {/* Wireframe section 06: an availability tenant must not see a
                      stock number they believe is being tracked. */}
                  {tracksStock ? (
                    <label className={styles.field}>
                      <span>Stock</span>
                      <input
                        type="number"
                        inputMode={decimalQuantities ? 'decimal' : 'numeric'}
                        min="0"
                        step={decimalQuantities ? '0.001' : '1'}
                        value={cell.stock}
                        placeholder="0"
                        onChange={(event) => updateCell(cell, { stock: event.target.value })}
                      />
                    </label>
                  ) : (
                    <label className={styles.toggleField}>
                      <input
                        type="checkbox"
                        checked={cell.available}
                        onChange={(event) => updateCell(cell, { available: event.target.checked })}
                      />
                      <span>In stock</span>
                    </label>
                  )}

                  <label className={styles.field}>
                    <span>SKU</span>
                    <input
                      type="text"
                      value={cell.sku}
                      placeholder="optional"
                      onChange={(event) => updateCell(cell, { sku: event.target.value })}
                    />
                  </label>
                </div>

                {tracksStock && (
                  <label className={styles.toggleField}>
                    <input
                      type="checkbox"
                      checked={cell.available}
                      onChange={(event) => updateCell(cell, { available: event.target.checked })}
                    />
                    <span>Available to order</span>
                  </label>
                )}

                {cellErrors.map((message) => (
                  <p className={styles.cellError} key={message}>
                    {message}
                  </p>
                ))}
              </article>
            );
          })}
        </div>
      )}

      {retired.length > 0 && (
        <section className={styles.retiredBlock}>
          <h4 className={styles.retiredTitle}>Retired</h4>
          <p className={styles.retiredLead}>
            You removed these, and they appear in past orders — so they were kept rather than
            deleted, to leave order history intact. Buyers cannot see them.
          </p>
          <ul className={styles.retiredList}>
            {retired.map((variant) => (
              <li key={variant.id} className={styles.retiredItem}>
                <span className={styles.retiredName}>
                  {Object.entries(variant.attributes)
                    .map(([name, value]) => `${name} ${value}`)
                    .join(' · ') || 'this product'}
                </span>
                <button
                  type="button"
                  className={styles.restoreButton}
                  onClick={() => onRestore(variant)}
                >
                  Restore
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}

/**
 * Bulk fill. Not a nicety — nine cells of identical price typed by hand is how
 * sellers abandon the screen, and that is worse on a phone, not better, so
 * these controls sit above the stack at every width.
 *
 * Fills empty cells by default. Overwriting is available but has to be asked
 * for: a seller topping up six priced cells should not lose the six.
 */
function BulkFill({
  tracksStock,
  onApply,
}: {
  tracksStock: boolean;
  onApply: (field: 'price' | 'stock', value: string, overwrite: boolean) => void;
}) {
  const [price, setPrice] = useState('');
  const [stock, setStock] = useState('');
  const [overwrite, setOverwrite] = useState(false);

  return (
    <div className={styles.bulk}>
      <div className={styles.bulkRow}>
        <label className={styles.bulkField}>
          <span>Set price for all</span>
          <input
            type="number"
            min="0"
            step="0.01"
            value={price}
            placeholder="0.00"
            onChange={(event) => setPrice(event.target.value)}
          />
        </label>
        <button
          type="button"
          className={styles.bulkButton}
          disabled={price.trim() === ''}
          onClick={() => onApply('price', price.trim(), overwrite)}
        >
          Apply
        </button>
      </div>

      {tracksStock && (
        <div className={styles.bulkRow}>
          <label className={styles.bulkField}>
            <span>Set stock for all</span>
            <input
              type="number"
              min="0"
              step="0.001"
              value={stock}
              placeholder="0"
              onChange={(event) => setStock(event.target.value)}
            />
          </label>
          <button
            type="button"
            className={styles.bulkButton}
            disabled={stock.trim() === ''}
            onClick={() => onApply('stock', stock.trim(), overwrite)}
          >
            Apply
          </button>
        </div>
      )}

      <label className={styles.bulkOverwrite}>
        <input
          type="checkbox"
          checked={overwrite}
          onChange={(event) => setOverwrite(event.target.checked)}
        />
        <span>Overwrite cells that already have a value</span>
      </label>
    </div>
  );
}

export { comboKey };
