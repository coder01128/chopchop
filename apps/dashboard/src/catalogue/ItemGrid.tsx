import type { ItemSummary } from './catalogue-data';
import styles from './ItemGrid.module.css';

const money = new Intl.NumberFormat('en-ZA', {
  style: 'currency',
  currency: 'ZAR',
  minimumFractionDigits: 2,
});

function priceRange(summary: ItemSummary): string {
  if (summary.minPrice === null || summary.maxPrice === null) return 'No price yet';
  if (summary.minPrice === summary.maxPrice) return money.format(summary.minPrice);
  return `${money.format(summary.minPrice)} – ${money.format(summary.maxPrice)}`;
}

export function ItemGrid({
  items,
  hasAnyItems,
  onEdit,
  onToggleActive,
  onAdd,
}: {
  items: ItemSummary[];
  /** Distinguishes "no products yet" from "nothing matched the filter". */
  hasAnyItems: boolean;
  onEdit: (summary: ItemSummary) => void;
  onToggleActive: (summary: ItemSummary) => void;
  onAdd: () => void;
}) {
  if (items.length === 0) {
    return (
      <div className={styles.empty}>
        {hasAnyItems ? (
          <>
            <p className={styles.emptyTitle}>Nothing matches</p>
            <p className={styles.emptyBody}>Try a different category or search term.</p>
          </>
        ) : (
          <>
            <p className={styles.emptyTitle}>No products yet</p>
            <p className={styles.emptyBody}>
              Add your first product, or bring in a price list you already have from the Import
              screen.
            </p>
            <button type="button" className={styles.emptyAction} onClick={onAdd}>
              + Add product
            </button>
          </>
        )}
      </div>
    );
  }

  return (
    <ul className={styles.grid}>
      {items.map((summary) => (
        <li key={summary.item.id}>
          <article className={styles.card} data-inactive={summary.item.active ? undefined : true}>
            <button type="button" className={styles.cardOpen} onClick={() => onEdit(summary)}>
              {/* A missing photo is a neutral block, never a broken image —
                  most clients upload photos late or never. */}
              <span className={styles.thumb} data-empty={summary.item.image_url ? undefined : true}>
                {summary.item.image_url ? (
                  <img
                    src={summary.item.image_url}
                    alt=""
                    loading="lazy"
                    onError={(event) => {
                      const holder = event.currentTarget.parentElement;
                      if (holder) holder.dataset.empty = 'true';
                      event.currentTarget.remove();
                    }}
                  />
                ) : (
                  <span className={styles.thumbMark}>No photo</span>
                )}
              </span>

              <span className={styles.cardBody}>
                <span className={styles.name}>{summary.item.name}</span>
                <span className={styles.meta}>
                  {summary.variantCount} option{summary.variantCount === 1 ? '' : 's'}
                </span>
                <span className={styles.price}>{priceRange(summary)}</span>
                {/* Confirming an order takes stock below zero rather than
                    refusing — the goods have already left the shelf. The count
                    is left negative on purpose, and this is the prompt to
                    recount. No mode check: an availability tenant never
                    decrements, so this never appears for them. */}
                {summary.belowZeroCount > 0 && (
                  <span className={styles.belowZero}>
                    {summary.belowZeroCount} below zero — recount
                  </span>
                )}
              </span>
            </button>

            <label className={styles.activeToggle}>
              <input
                type="checkbox"
                checked={summary.item.active}
                onChange={() => onToggleActive(summary)}
              />
              <span>{summary.item.active ? 'In the shop' : 'Hidden'}</span>
            </label>
          </article>
        </li>
      ))}
    </ul>
  );
}
