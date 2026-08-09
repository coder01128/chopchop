import { useEffect, useMemo, useState } from 'react';
import { getSupabaseClient, useTenant } from '@chopchop/shared';
import { loadCatalogue, type Catalogue, type StorefrontItem } from '../storefront-data';
import { isSoldOut, money } from '../storefront-model';
import styles from './CataloguePage.module.css';

/**
 * The shop, on a phone, opened from a WhatsApp group.
 *
 * Categories are rows in a table and so are products — nothing here is
 * hardcoded, and no component knows what this client sells. What a card shows
 * about stock is decided by the tenant's `stock_mode`; the count itself is
 * never shown, because that is the seller's working figure and not a promise.
 */
export function CataloguePage({ onOpen }: { onOpen: (item: StorefrontItem) => void }) {
  const tenant = useTenant();
  const client = getSupabaseClient();

  const [catalogue, setCatalogue] = useState<Catalogue>({ categories: [], items: [] });
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    loadCatalogue(client, tenant.id)
      .then((loaded) => {
        if (active) setCatalogue(loaded);
      })
      .catch((loadError) => {
        if (active) setError(loadError instanceof Error ? loadError.message : String(loadError));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, tenant.id]);

  const visible = useMemo(
    () =>
      categoryId === null
        ? catalogue.items
        : catalogue.items.filter((item) => item.categoryId === categoryId),
    [catalogue.items, categoryId],
  );

  if (loading) return <p className={styles.loading}>Loading…</p>;

  if (error) {
    return (
      <p className={styles.error} role="alert">
        {error}
      </p>
    );
  }

  return (
    <section className={styles.page}>
      <h1 className={styles.heading}>{tenant.label('catalogue', 'Catalogue')}</h1>

      {catalogue.categories.length > 0 && (
        <nav className={styles.rail} aria-label={tenant.label('catalogue', 'Catalogue')}>
          <button
            type="button"
            className={styles.chip}
            data-on={categoryId === null || undefined}
            onClick={() => setCategoryId(null)}
          >
            All
          </button>
          {catalogue.categories.map((category) => (
            <button
              key={category.id}
              type="button"
              className={styles.chip}
              data-on={categoryId === category.id || undefined}
              onClick={() => setCategoryId(category.id)}
            >
              {category.name}
            </button>
          ))}
        </nav>
      )}

      {visible.length === 0 ? (
        <p className={styles.empty}>Nothing here yet.</p>
      ) : (
        <ul className={styles.grid}>
          {visible.map((item) => {
            const prices = item.variants.map((variant) => variant.price);
            const from = Math.min(...prices);
            const to = Math.max(...prices);
            // Sold out only when every option is: a shoe out of one size is
            // still a shoe you can buy.
            const soldOut = item.variants.every((variant) => isSoldOut(variant, tenant.stockMode));

            return (
              <li key={item.id}>
                <button
                  type="button"
                  className={styles.card}
                  data-sold-out={soldOut || undefined}
                  onClick={() => onOpen(item)}
                >
                  <span className={styles.thumb} data-empty={item.imageUrl ? undefined : true}>
                    {item.imageUrl ? (
                      <img
                        src={item.imageUrl}
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
      )}
    </section>
  );
}
