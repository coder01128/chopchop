import type { TenantAttribute } from '@chopchop/shared';
import {
  attributeTarget,
  ignoredHeaders,
  mappedColumn,
  mappingProblems,
  targetAttributeName,
  type ColumnTarget,
  type Mapping,
  type SheetTable,
} from './import-model';
import styles from './MappingStep.module.css';

/**
 * Column mapping.
 *
 * This screen consumes a headers-plus-rows table and nothing else — it cannot
 * tell a `.csv` from an `.xlsx` from ticket 06B's vision extraction, which is
 * the point of the seam.
 *
 * The attribute targets are the one place `attribute_schema` is read as a
 * palette. It offers what this business *can* record; what a product's
 * selectors render from is still the keys on that product's own variants.
 */

const PREVIEW_ROWS = 5;

const SIMPLE_LABELS: { target: ColumnTarget; label: string }[] = [
  { target: 'name', label: 'Product name' },
  { target: 'price', label: 'Price' },
  { target: 'category', label: 'Category' },
  { target: 'stock', label: 'Stock' },
  { target: 'sku', label: 'SKU' },
];

export function MappingStep({
  table,
  mapping,
  palette,
  trackStock,
  onChange,
  onBack,
  onContinue,
}: {
  table: SheetTable;
  mapping: Mapping;
  palette: TenantAttribute[];
  trackStock: boolean;
  onChange: (mapping: Mapping) => void;
  onBack: () => void;
  onContinue: () => void;
}) {
  const problems = mappingProblems(mapping);
  const ignored = ignoredHeaders(table, mapping);
  const stockColumn = mappedColumn(mapping, 'stock');

  function setTarget(index: number, target: ColumnTarget) {
    // One target, one column. Choosing a target that is already in use moves
    // it rather than mapping two columns to the same field.
    const next = mapping.map((current, position) => {
      if (position === index) return target;
      if (target !== 'ignore' && current === target) return 'ignore';
      return current;
    });
    onChange(next);
  }

  return (
    <div className={styles.step}>
      <header className={styles.head}>
        <div>
          <p className="cc-eyebrow">Step 2 of 3</p>
          <h2 className={styles.heading}>Match the columns</h2>
        </div>
        <p className={styles.count}>
          {table.rows.length} row{table.rows.length === 1 ? '' : 's'} · {table.headers.length} columns
        </p>
      </header>

      <p className={styles.blurb}>
        One row is one variant. Rows with the same product name become one product with several
        variants.
      </p>

      <ul className={styles.columns}>
        {table.headers.map((header, index) => (
          <li key={`${header}-${index}`} className={styles.column}>
            <div className={styles.columnHead}>
              <span className={styles.header}>{header || <em>(no heading)</em>}</span>
              <span className={styles.sample}>
                {table.rows
                  .slice(0, PREVIEW_ROWS)
                  .map((row) => row[index])
                  .filter((value) => (value ?? '').trim() !== '')
                  .slice(0, 3)
                  .join(' · ') || '—'}
              </span>
            </div>

            <label className={styles.select}>
              <span className="cc-visually-hidden">Map column {header}</span>
              <select
                value={mapping[index]}
                onChange={(event) => setTarget(index, event.target.value as ColumnTarget)}
              >
                <option value="ignore">Ignore this column</option>
                {SIMPLE_LABELS.map((entry) => (
                  <option key={entry.target} value={entry.target}>
                    {entry.label}
                  </option>
                ))}
                {palette.map((attribute) => (
                  <option key={attribute.name} value={attributeTarget(attribute.name)}>
                    {attribute.label || attribute.name}
                  </option>
                ))}
              </select>
            </label>
          </li>
        ))}
      </ul>

      {ignored.length > 0 && (
        <p className={styles.note}>
          Ignored, and not imported: {ignored.join(', ')}.
        </p>
      )}

      {/*
        An availability tenant gets no stock figure written — save_product reads
        the mode off the tenant row. The seller mapped that column, so they are
        told where it goes, and the column is named.
      */}
      {!trackStock && stockColumn >= 0 && (
        <p className={styles.note}>
          The stock column “{table.headers[stockColumn] || '(no heading)'}” will be ignored. This
          business works on an in-stock switch, not a count, so no stock figure is stored.
        </p>
      )}

      {problems.length > 0 && (
        <ul className={styles.problems} role="alert">
          {problems.map((problem) => (
            <li key={problem.message}>{problem.message}</li>
          ))}
        </ul>
      )}

      {mapping.some((target) => targetAttributeName(target) !== null) === false && palette.length > 0 && (
        <p className={styles.note}>
          No column is mapped to a variant option, so every product gets one variant.
        </p>
      )}

      <div className={styles.actions}>
        <button type="button" className={styles.ghost} onClick={onBack}>
          Choose another file
        </button>
        <button
          type="button"
          className={styles.primary}
          disabled={problems.length > 0}
          onClick={onContinue}
        >
          Review {table.rows.length} rows
        </button>
      </div>
    </div>
  );
}
