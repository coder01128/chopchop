import { useTenant } from '@chopchop/shared';
import { formatQty, lineTotal, money, parseQty, quantityStep, totalIsEstimate } from '../storefront-model';
import { useCart } from './CartProvider';
import styles from './CartSheet.module.css';

/**
 * What the buyer is about to send.
 *
 * On a weight tenant every figure on this screen is labelled an estimate,
 * because the real one is whatever the seller weighs. On a unit tenant no
 * estimate language appears anywhere — the total is the total.
 */
export function CartSheet({ onClose, onCheckout }: { onClose: () => void; onCheckout: () => void }) {
  const tenant = useTenant();
  const cart = useCart();
  const estimate = totalIsEstimate(tenant.saleMode);

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={styles.sheet} role="dialog" aria-modal="true" aria-label={tenant.label('cart', 'Cart')}>
        <header className={styles.head}>
          <h2 className={styles.title}>{tenant.label('cart', 'Cart')}</h2>
          <button type="button" className={styles.close} onClick={onClose}>
            Close
          </button>
        </header>

        {cart.lines.length === 0 ? (
          <p className={styles.empty}>Nothing in here yet.</p>
        ) : (
          <>
            <ul className={styles.lines}>
              {cart.lines.map((line) => (
                <li key={line.variantId} className={styles.line}>
                  <div className={styles.lineTop}>
                    <span className={styles.name}>{line.name}</span>
                    <span className={styles.amount}>{money.format(lineTotal(line))}</span>
                  </div>
                  <div className={styles.lineBottom}>
                    <label className={styles.qty}>
                      <span className="cc-visually-hidden">Quantity for {line.name}</span>
                      <input
                        type="number"
                        inputMode={tenant.saleMode === 'weight' ? 'decimal' : 'numeric'}
                        min={tenant.saleMode === 'weight' ? '0.001' : '1'}
                        step={quantityStep(tenant.saleMode)}
                        value={formatQty(line.qty, tenant.saleMode)}
                        onChange={(event) => {
                          const next = parseQty(event.target.value, tenant.saleMode);
                          if (next !== null) cart.setQty(line.variantId, next);
                        }}
                      />
                    </label>
                    <span className={styles.unitPrice}>× {money.format(line.price)}</span>
                    <button
                      type="button"
                      className={styles.remove}
                      onClick={() => cart.remove(line.variantId)}
                    >
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ul>

            <p className={styles.total}>
              <span>{estimate ? 'Estimated total' : 'Total'}</span>
              <span className={styles.totalAmount}>{money.format(cart.total)}</span>
            </p>
            {estimate && (
              <p className={styles.estimateNote}>
                Priced once it is weighed, so this figure can move a little either way.
              </p>
            )}

            <button type="button" className={styles.checkout} onClick={onCheckout}>
              {tenant.label('checkout', 'Checkout')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
