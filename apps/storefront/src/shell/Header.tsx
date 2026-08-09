import { useEffect } from 'react';
import { TenantMark, useTenant } from '@chopchop/shared';
import { useCart } from '../cart/CartProvider';
import styles from './Header.module.css';

/**
 * The shop's chrome: the tenant's mark, name and tagline, and the way back to
 * the cart. Every word a buyer reads here is the client's own — the cart is
 * called whatever `branding.labels` says it is called.
 */
export function Header({ onCart }: { onCart?: () => void }) {
  const tenant = useTenant();
  const cart = useCart();

  useEffect(() => {
    document.title = tenant.name;
  }, [tenant.name]);

  return (
    <header className={styles.header}>
      <div className={styles.inner}>
        <TenantMark size={44} />
        <div className={styles.text}>
          <span className={styles.name}>{tenant.name}</span>
          {tenant.branding.tagline && (
            <span className={styles.tagline}>{tenant.branding.tagline}</span>
          )}
        </div>

        {onCart && (
          <button type="button" className={styles.cart} onClick={onCart}>
            {tenant.label('cart', 'Cart')}
            {cart.lines.length > 0 && <span className={styles.count}>{cart.lines.length}</span>}
          </button>
        )}
      </div>
    </header>
  );
}
