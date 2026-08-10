import {
  describeAttributes,
  writableItems,
  type CategoryDecision,
  type ExistingCategory,
  type ImportPlan,
  type PlannedItem,
  type PlannedVariant,
} from './import-model';
import styles from './ReviewStep.module.css';

/**
 * The commit gate. Everything that is about to be written, shown before it is
 * written — and everything that is not, said out loud.
 *
 * One component, two presentations: a table above 48rem, a card per row below
 * it. A forty-row preview table is unusable at 390px, and a seller doing this
 * on their phone in the shop is the expected case, not the edge one.
 *
 * Nothing on this screen removes anything. A product that exists but is absent
 * from the file appears nowhere here, because an import never touches it.
 */

const OUTCOME_LABELS: Record<PlannedVariant['outcome'], string> = {
  new: 'New',
  update: 'Update',
  unchanged: 'Unchanged',
  ambiguous: 'Needs a decision',
};

/**
 * The counters are in **products**, and each one says so.
 *
 * The seller's check here is arithmetic: the number on this screen has to be
 * the number their catalogue grows by. Bare counts in rows meant "7 new" was
 * followed by a catalogue that grew by 5, which reads as an import that
 * dropped two. Errors stay in rows — an error row never became a product —
 * and the unit is named for exactly that reason.
 *
 * The done screen was already right. These match it rather than inventing a
 * third style.
 */
function products(count: number): string {
  return `${count} product${count === 1 ? '' : 's'}`;
}

interface Line {
  item: PlannedItem;
  variant: PlannedVariant;
}

function lines(plan: ImportPlan): Line[] {
  return plan.items
    .flatMap((item) => item.variants.map((variant) => ({ item, variant })))
    .sort((a, b) => a.variant.line - b.variant.line);
}

function changeText(line: Line): string {
  const changes = [...line.item.changes, ...line.variant.changes];
  if (line.variant.outcome === 'ambiguous') return line.variant.reason ?? line.item.reason ?? '';
  if (changes.length === 0) return line.variant.outcome === 'new' ? 'Will be created' : 'No changes';
  return changes.map((change) => `${change.field} ${change.from} → ${change.to}`).join(' · ');
}

export function ReviewStep({
  plan,
  decisions,
  categories,
  committing,
  onDecisionChange,
  onResolveAsNew,
  onCommit,
  onCancel,
}: {
  plan: ImportPlan;
  decisions: CategoryDecision[];
  categories: ExistingCategory[];
  committing: boolean;
  onDecisionChange: (key: string, action: CategoryDecision['action'], categoryId: string | null) => void;
  onResolveAsNew: (key: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const rows = lines(plan);
  const ambiguousItems = plan.items.filter((item) => item.outcome === 'ambiguous');
  // Counted from the same function the commit loops over, so the button cannot
  // promise a number the commit does not write.
  const writes = writableItems(plan).length;

  return (
    <div className={styles.step}>
      <header className={styles.head}>
        <div>
          <p className="cc-eyebrow">Step 3 of 3</p>
          <h2 className={styles.heading}>Review before it is written</h2>
        </div>
      </header>

      <ul className={styles.counts}>
        <li data-tone="new">
          <strong>{plan.counts.newProducts}</strong> new product
          {plan.counts.newProducts === 1 ? '' : 's'}
        </li>
        <li data-tone="update">
          <strong>{plan.counts.updatedProducts}</strong> updated product
          {plan.counts.updatedProducts === 1 ? '' : 's'}
        </li>
        <li>
          <strong>{plan.counts.unchangedProducts}</strong> unchanged product
          {plan.counts.unchangedProducts === 1 ? '' : 's'}
        </li>
        <li data-tone={plan.counts.ambiguousProducts > 0 ? 'warn' : undefined}>
          <strong>{plan.counts.ambiguousProducts}</strong>{' '}
          {plan.counts.ambiguousProducts === 1 ? 'needs' : 'need'} a decision
        </li>
        <li data-tone={plan.counts.errorRows > 0 ? 'error' : undefined}>
          <strong>{plan.counts.errorRows}</strong> row
          {plan.counts.errorRows === 1 ? ' with an error' : 's with errors'}
        </li>
      </ul>

      <p className={styles.promise}>
        Nothing is removed by an import. Products already in the catalogue that are not in this file
        are left exactly as they are.
      </p>

      {decisions.length > 0 && (
        <section className={styles.block}>
          <h3 className={styles.blockHeading}>Categories</h3>
          <ul className={styles.decisions}>
            {decisions.map((decision) => (
              <li key={decision.key} className={styles.decision}>
                <div className={styles.decisionName}>
                  <span>{decision.name}</span>
                  <span className={styles.decisionCount}>
                    {decision.rowCount} row{decision.rowCount === 1 ? '' : 's'}
                  </span>
                </div>
                <label className={styles.select}>
                  <span className="cc-visually-hidden">Target for {decision.name}</span>
                  <select
                    value={decision.action === 'create' ? 'create' : (decision.categoryId ?? 'create')}
                    onChange={(event) =>
                      event.target.value === 'create'
                        ? onDecisionChange(decision.key, 'create', null)
                        : onDecisionChange(decision.key, 'attach', event.target.value)
                    }
                  >
                    <option value="create">Create “{decision.name}”</option>
                    {categories.map((category) => (
                      <option key={category.id} value={category.id}>
                        Add to {category.name}
                      </option>
                    ))}
                  </select>
                </label>
              </li>
            ))}
          </ul>
        </section>
      )}

      {ambiguousItems.length > 0 && (
        <section className={styles.block}>
          <h3 className={styles.blockHeading}>
            Needs a decision — {products(ambiguousItems.length)}
          </h3>
          <ul className={styles.ambiguous}>
            {ambiguousItems.map((item) => (
              <li key={item.key}>
                <p className={styles.ambiguousName}>{item.name}</p>
                <p className={styles.ambiguousReason}>{item.reason}</p>
                <button type="button" className={styles.ghost} onClick={() => onResolveAsNew(item.key)}>
                  Import as a new product
                </button>
                <span className={styles.ambiguousNote}>
                  Left alone, these rows are skipped and nothing is changed.
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className={styles.block}>
        {/*
          Named, because this list visibly disagrees with the counters above
          it: one product with four variants is one product up there and four
          lines down here.
        */}
        <h3 className={styles.blockHeading}>Rows — one line per variant</h3>

        {/* Desktop. Same data as the cards below — one component, two presentations. */}
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Row</th>
                <th scope="col">Product</th>
                <th scope="col">Variant</th>
                <th scope="col">Price</th>
                <th scope="col">Outcome</th>
                <th scope="col">Change</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((line) => (
                <tr key={`${line.item.key}-${line.variant.line}`}>
                  <td className={styles.line}>{line.variant.line}</td>
                  <td>{line.item.name}</td>
                  <td className={styles.variant}>{describeAttributes(line.variant.attributes)}</td>
                  <td className={styles.money}>{line.variant.price.toFixed(2)}</td>
                  <td>
                    <span className={styles.badge} data-outcome={line.variant.outcome}>
                      {OUTCOME_LABELS[line.variant.outcome]}
                    </span>
                  </td>
                  <td className={styles.change}>{changeText(line)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Phone. */}
        <ul className={styles.cards}>
          {rows.map((line) => (
            <li key={`${line.item.key}-${line.variant.line}`} className={styles.card}>
              <div className={styles.cardHead}>
                <span className={styles.cardName}>{line.item.name}</span>
                <span className={styles.badge} data-outcome={line.variant.outcome}>
                  {OUTCOME_LABELS[line.variant.outcome]}
                </span>
              </div>
              <p className={styles.cardMeta}>
                Row {line.variant.line} · {describeAttributes(line.variant.attributes)} ·{' '}
                {line.variant.price.toFixed(2)}
              </p>
              <p className={styles.cardChange}>{changeText(line)}</p>
            </li>
          ))}
        </ul>
      </section>

      {plan.errorRows.length > 0 && (
        <section className={styles.block}>
          <h3 className={styles.blockHeading}>Skipped</h3>
          <p className={styles.blockBlurb}>
            These rows are not imported. Everything else still is.
          </p>
          <ul className={styles.errors}>
            {plan.errorRows.map((row) => (
              <li key={row.line}>
                <span className={styles.line}>Row {row.line}</span> {row.name || '(no name)'} —{' '}
                {row.errors.join(' ')}
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className={styles.actions}>
        <button type="button" className={styles.ghost} onClick={onCancel} disabled={committing}>
          Cancel — write nothing
        </button>
        <button
          type="button"
          className={styles.primary}
          onClick={onCommit}
          disabled={committing || writes === 0}
        >
          {committing ? 'Writing…' : `Commit ${products(writes)}`}
        </button>
      </div>
    </div>
  );
}
