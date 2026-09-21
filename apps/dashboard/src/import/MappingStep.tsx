import {
  attributeTarget,
  ignoredHeaders,
  mappedColumn,
  mappingProblems,
  normalise,
  targetAttributeName,
  type AttributeLabels,
  type ColumnTarget,
  type Mapping,
  type SheetTable,
} from './import-model';
import styles from './MappingStep.module.css';

const PREVIEW_ROWS = 5;

const SIMPLE_LABELS: { target: ColumnTarget; label: string }[] = [
  { target: 'name', label: 'Product name' },
  { target: 'price', label: 'Price' },
  { target: 'category', label: 'Category' },
  { target: 'stock', label: 'Stock' },
  { target: 'sku', label: 'SKU' },
  { target: 'description', label: 'Description' },
  { target: 'image', label: 'Image URL' },
];

function enforceUnique(current: Mapping, index: number, target: ColumnTarget): Mapping {
  return current.map((existing, position) => {
    if (position === index) return target;
    if (target !== 'ignore' && existing === target) return 'ignore' as ColumnTarget;
    return existing;
  });
}

export function MappingStep({
  table,
  mapping,
  attributeLabels,
  trackStock,
  onChange,
  onBack,
  onContinue,
}: {
  table: SheetTable;
  mapping: Mapping;
  attributeLabels: AttributeLabels;
  trackStock: boolean;
  onChange: (mapping: Mapping, labels: AttributeLabels) => void;
  onBack: () => void;
  onContinue: () => void;
}) {
  const problems = mappingProblems(mapping);
  const ignored = ignoredHeaders(table, mapping);
  const stockColumn = mappedColumn(mapping, 'stock');

  function selectChange(index: number, value: string) {
    if (value === 'filterable') {
      const header = table.headers[index];
      const name = normalise(header) || `column_${index + 1}`;
      const target = attributeTarget(name);
      onChange(
        enforceUnique(mapping, index, target),
        { ...attributeLabels, [name]: header || name },
      );
    } else {
      const target = value as ColumnTarget;
      const oldName = targetAttributeName(mapping[index]);
      const nextMapping = enforceUnique(mapping, index, target);

      let nextLabels = attributeLabels;
      if (oldName && !nextMapping.some((t) => targetAttributeName(t) === oldName)) {
        nextLabels = { ...attributeLabels };
        delete nextLabels[oldName];
      }

      onChange(nextMapping, nextLabels);
    }
  }

  function labelChange(index: number, newLabel: string) {
    const oldName = targetAttributeName(mapping[index]);
    if (!oldName) return;

    const newName = normalise(newLabel) || oldName;
    const nextLabels = { ...attributeLabels };

    if (newName !== oldName) {
      const nextMapping = enforceUnique(mapping, index, attributeTarget(newName));
      delete nextLabels[oldName];
      nextLabels[newName] = newLabel;
      onChange(nextMapping, nextLabels);
    } else {
      nextLabels[oldName] = newLabel;
      onChange(mapping, nextLabels);
    }
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
        {table.headers.map((header, index) => {
          const attrName = targetAttributeName(mapping[index]);
          const selectValue = attrName !== null ? 'filterable' : mapping[index];

          return (
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
                  value={selectValue}
                  onChange={(event) => selectChange(index, event.target.value)}
                >
                  <option value="ignore">Ignore this column</option>
                  {SIMPLE_LABELS.map((entry) => (
                    <option key={entry.target} value={entry.target}>
                      {entry.label}
                    </option>
                  ))}
                  <option value="filterable">Filterable attribute</option>
                </select>
              </label>

              {attrName !== null && (
                <input
                  type="text"
                  className={styles.attrLabel}
                  value={attributeLabels[attrName] ?? ''}
                  placeholder="Attribute label"
                  aria-label={`Label for ${header}`}
                  onChange={(e) => labelChange(index, e.target.value)}
                />
              )}
            </li>
          );
        })}
      </ul>

      {ignored.length > 0 && (
        <p className={styles.note}>
          Ignored, and not imported: {ignored.join(', ')}.
        </p>
      )}

      {!trackStock && stockColumn >= 0 && (
        <p className={styles.note}>
          The stock column "{table.headers[stockColumn] || '(no heading)'}" will be ignored. This
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

      {mapping.every((target) => targetAttributeName(target) === null) && (
        <p className={styles.note}>
          No column is a filterable attribute, so every product gets one variant.
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
