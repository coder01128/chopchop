import { useMemo, useState } from 'react';
import { getSupabaseUrl, resolveImageUrl, useTenant } from '@chopchop/shared';
import type { StorefrontItem } from '../storefront-data';
import {
  isSoldOut,
  matchVariant,
  money,
  parseQty,
  quantityStep,
  selectorsFor,
  totalIsEstimate,
  variantLabel,
} from '../storefront-model';
import { useCart } from '../cart/CartProvider';
import styles from './ProductSheet.module.css';

/**
 * One product, and the choice a buyer makes about it.
 *
 * The selectors are generated from the keys on **this product's own variants**,
 * never from the tenant's `attribute_schema`. The palette lists what a business
 * may use; the product says what it does use. Reading the palette instead would
 * sprout an empty selector on every old product the day a client adds an
 * attribute — which is the failure the whole white-label claim rests on
 * avoiding.
 */
export function ProductSheet({
  item,
  onClose,
  onAdded,
}: {
  item: StorefrontItem;
  onClose: () => void;
  onAdded: () => void;
}) {
  const tenant = useTenant();
  const cart = useCart();

  const paletteOrder = useMemo(
    () => tenant.attributeSchema.map((attribute) => attribute.name),
    [tenant.attributeSchema],
  );
  const selectors = useMemo(
    () => selectorsFor(item.variants, paletteOrder),
    [item.variants, paletteOrder],
  );

  // One option each is not a choice — preselect it rather than making the buyer
  // tap something that could not have been anything else.
  const [chosen, setChosen] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      selectors.filter((selector) => selector.values.length === 1).map((s) => [s.name, s.values[0]]),
    ),
  );
  const [qtyText, setQtyText] = useState(tenant.saleMode === 'weight' ? '1' : '1');

  const complete = selectors.every((selector) => chosen[selector.name] !== undefined);
  const variant = complete ? matchVariant(item.variants, chosen) : null;

  // One function, shared with the dashboard: variant photo, else the product
  // primary, else the legacy url, else nothing.
  const imageSrc = resolveImageUrl(getSupabaseUrl(), item, variant);
  const soldOut = variant ? isSoldOut(variant, tenant.stockMode) : false;
  const qty = parseQty(qtyText, tenant.saleMode);

  const decimal = tenant.saleMode === 'weight';
  const attributeLabel = (name: string) =>
    tenant.attributeSchema.find((attribute) => attribute.name === name)?.label || name;

  /** Is any variant carrying this value orderable? Greys the dead options out. */
  function valueAvailable(name: string, value: string): boolean {
    return item.variants.some(
      (candidate) => candidate.attributes[name] === value && !isSoldOut(candidate, tenant.stockMode),
    );
  }

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={styles.sheet} role="dialog" aria-modal="true" aria-label={item.name}>
        <header className={styles.head}>
          <h2 className={styles.title}>{item.name}</h2>
          <button type="button" className={styles.close} onClick={onClose}>
            Close
          </button>
        </header>

        {/* The primary until the buyer picks a variant that has its own photo,
            then that one. A variant with none falls back to the primary, and a
            product with neither renders the neutral block rather than nothing —
            before this the sheet drew no placeholder and no error handler, so a
            path that failed to load left a broken image on the buyer's screen. */}
        <span className={styles.imageHolder} data-empty={imageSrc ? undefined : true}>
          {imageSrc ? (
            <img
              className={styles.image}
              // Keyed on the source so switching variant swaps the picture
              // rather than reusing an element still marked broken.
              key={imageSrc}
              src={imageSrc}
              alt=""
              loading="lazy"
              onError={(event) => {
                const holder = event.currentTarget.parentElement;
                if (holder) holder.dataset.empty = 'true';
                event.currentTarget.remove();
              }}
            />
          ) : (
            <span className={styles.imageMark}>No photo</span>
          )}
        </span>

        {item.description && <p className={styles.blurb}>{item.description}</p>}

        {selectors.map((selector) => (
          <fieldset className={styles.selector} key={selector.name}>
            <legend className={styles.legend}>{attributeLabel(selector.name)}</legend>
            <div className={styles.options}>
              {selector.values.map((value) => {
                const orderable = valueAvailable(selector.name, value);
                return (
                  <button
                    key={value}
                    type="button"
                    className={styles.option}
                    data-on={chosen[selector.name] === value || undefined}
                    data-out={!orderable || undefined}
                    onClick={() => setChosen((current) => ({ ...current, [selector.name]: value }))}
                  >
                    {value}
                  </button>
                );
              })}
            </div>
          </fieldset>
        ))}

        <div className={styles.buy}>
          <label className={styles.qty}>
            <span>{decimal ? 'Quantity (kg)' : 'How many'}</span>
            <input
              type="number"
              inputMode={decimal ? 'decimal' : 'numeric'}
              min={decimal ? '0.001' : '1'}
              step={quantityStep(tenant.saleMode)}
              value={qtyText}
              onChange={(event) => setQtyText(event.target.value)}
            />
          </label>

          <p className={styles.linePrice}>
            {variant ? (
              <>
                <span className={styles.amount}>
                  {money.format(Math.round(variant.price * (qty ?? 0) * 100) / 100)}
                </span>
                {totalIsEstimate(tenant.saleMode) && (
                  <span className={styles.estimate}>estimate — priced once weighed</span>
                )}
              </>
            ) : (
              <span className={styles.amount}>—</span>
            )}
          </p>
        </div>

        <button
          type="button"
          className={styles.add}
          disabled={!variant || soldOut || qty === null}
          onClick={() => {
            if (!variant || qty === null) return;
            const label = variantLabel(variant.attributes, paletteOrder);
            cart.add({
              variantId: variant.id,
              name: label ? `${item.name} — ${label}` : item.name,
              price: variant.price,
              qty,
            });
            onAdded();
          }}
        >
          {soldOut
            ? 'Sold out'
            : complete
              ? `Add to ${tenant.label('cart', 'cart')}`
              : 'Choose an option'}
        </button>
      </div>
    </div>
  );
}
