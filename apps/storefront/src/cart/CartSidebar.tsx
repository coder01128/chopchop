import { useTenant } from '@chopchop/shared';
import { formatQty, lineTotal, money, parseQty, quantityStep, totalIsEstimate } from '../storefront-model';
import { useCart } from './CartProvider';
import styles from './CartSidebar.module.css';

export function CartSidebar({ onCheckout }: { onCheckout: () => void }) {
  const tenant = useTenant();
  const cart = useCart();
  const estimate = totalIsEstimate(tenant.saleMode);

  return (
    <div className={styles.panel}>
      <h2 className={styles.title}>{tenant.label('cart', 'Cart')}</h2>

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
                  <div className={styles.qty}>
                    <span className="cc-visually-hidden">Quantity for {line.name}</span>
                    <div className={styles.stepper}>
                      <button
                        type="button"
                        className={styles.stepBtn}
                        aria-label="Decrease"
                        onClick={() => {
                          const decimal = tenant.saleMode === 'weight';
                          const step = decimal ? 0.5 : 1;
                          const min = decimal ? 0.5 : 1;
                          const next = Math.max(min, line.qty - step);
                          const capped = tenant.stockMode === 'counted' ? Math.min(next, line.stock) : next;
                          cart.setQty(line.variantId, decimal ? Number(capped.toFixed(3)) : capped);
                        }}
                      >
                        −
                      </button>
                      <input
                        type="number"
                        inputMode={tenant.saleMode === 'weight' ? 'decimal' : 'numeric'}
                        min={tenant.saleMode === 'weight' ? '0.001' : '1'}
                        max={tenant.stockMode === 'counted' ? line.stock : undefined}
                        step={quantityStep(tenant.saleMode)}
                        value={formatQty(line.qty, tenant.saleMode)}
                        onChange={(event) => {
                          const next = parseQty(event.target.value, tenant.saleMode);
                          if (next === null) return;
                          const capped =
                            tenant.stockMode === 'counted'
                              ? Math.min(next, line.stock)
                              : next;
                          cart.setQty(line.variantId, capped);
                        }}
                      />
                      <button
                        type="button"
                        className={styles.stepBtn}
                        aria-label="Increase"
                        onClick={() => {
                          const decimal = tenant.saleMode === 'weight';
                          const step = decimal ? 0.5 : 1;
                          const next = line.qty + step;
                          const capped = tenant.stockMode === 'counted' ? Math.min(next, line.stock) : next;
                          cart.setQty(line.variantId, decimal ? Number(capped.toFixed(3)) : capped);
                        }}
                      >
                        +
                      </button>
                    </div>
                    {tenant.stockMode === 'counted' && (
                      <span className={styles.stockHint}>{line.stock} available</span>
                    )}
                  </div>
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

          <div className={styles.footer}>
            <p className={styles.total}>
              <span>{estimate ? 'Estimated total' : 'Total'}</span>
              <span className={styles.totalAmount}>{money.format(cart.total)}</span>
            </p>
            {estimate && (
              <p className={styles.estimateNote}>
                Priced once weighed — this figure can move a little.
              </p>
            )}
            <button type="button" className={styles.checkout} onClick={onCheckout}>
              {tenant.label('checkout', 'Checkout')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
