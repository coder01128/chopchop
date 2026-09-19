import { getSupabaseUrl, resolveImageUrl, useTenant } from '@chopchop/shared';
import { isSoldOut, money } from '../storefront-model';
import type { CategoryRow, StorefrontItem } from '../storefront-data';
import styles from './CataloguePage.module.css';

export function CataloguePage({
  items,
  categories,
  loading,
  error,
  hasFilters,
  onOpen,
}: {
  items: StorefrontItem[];
  categories: CategoryRow[];
  loading: boolean;
  error: string | null;
  hasFilters: boolean;
  onOpen: (item: StorefrontItem) => void;
}) {
  const tenant = useTenant();

  if (loading) return <p className={styles.loading}>{`Loading…`}</p>;

  if (error) {
    return (
      <p className={styles.error} role="alert">
        {error}
      </p>
    );
  }

  if (items.length === 0) {
    return <p className={styles.empty}>{hasFilters ? 'No products found.' : 'Nothing here yet.'}</p>;
  }

  const grouped = groupByCategory(items, categories);

  return (
    <ul className={styles.grid}>
      {grouped.map((group) => (
        <li key={group.key} className={styles.section}>
          {group.name && <h2 className={styles.sectionHeading}>{group.name}</h2>}
          <ul className={styles.sectionGrid}>
            {group.items.map((item) => {
              const prices = item.variants.map((v) => v.price);
              const from = Math.min(...prices);
              const to = Math.max(...prices);
              const soldOut = item.variants.every((v) => isSoldOut(v, tenant.stockMode));

              return (
                <li key={item.id}>
                  <button
                    type="button"
                    className={styles.card}
                    data-sold-out={soldOut || undefined}
                    onClick={() => onOpen(item)}
                  >
                    <span className={styles.thumb} data-empty={tileSrc(item) ? undefined : true}>
                      {tileSrc(item) ? (
                        <img
                          src={tileSrc(item)!}
                          alt=""
                          loading="lazy"
                          onError={(event) => {
                            const holder = event.currentTarget.parentElement;
                            if (holder) holder.dataset.empty = 'true';
                            event.currentTarget.remove();
                          }}
                        />
                      ) : null}
                      {soldOut && <span className={styles.soldOutFlag}>Sold out</span>}
                    </span>
                    <span className={styles.cardBody}>
                      <span className={styles.name}>{item.name}</span>
                      <span className={styles.price}>
                        {from === to ? money.format(from) : `from ${money.format(from)}`}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ul>
  );
}

interface ItemGroup {
  key: string;
  name: string | null;
  items: StorefrontItem[];
}

function groupByCategory(items: StorefrontItem[], categories: CategoryRow[]): ItemGroup[] {
  const catOrder = new Map(categories.map((c, i) => [c.id, i]));
  const catNames = new Map(categories.map((c) => [c.id, c.name]));
  const groups = new Map<string, StorefrontItem[]>();

  for (const item of items) {
    const key = item.categoryId ?? '__uncategorized';
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }

  return [...groups.entries()]
    .sort(([a], [b]) => {
      const aIdx = a === '__uncategorized' ? Infinity : (catOrder.get(a) ?? Infinity);
      const bIdx = b === '__uncategorized' ? Infinity : (catOrder.get(b) ?? Infinity);
      return aIdx - bIdx;
    })
    .map(([key, groupItems]) => ({
      key,
      name: key === '__uncategorized' ? null : (catNames.get(key) ?? null),
      items: groupItems,
    }));
}

function tileSrc(item: StorefrontItem): string | null {
  return resolveImageUrl(getSupabaseUrl(), item);
}
