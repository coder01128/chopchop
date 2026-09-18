import { useTenant } from '@chopchop/shared';
import { money, totalIsEstimate } from '../storefront-model';
import { useCart } from './CartProvider';
import styles from './MobileCartBar.module.css';

export function MobileCartBar({ onTap }: { onTap: () => void }) {
  const tenant = useTenant();
  const cart = useCart();
  const estimate = totalIsEstimate(tenant.saleMode);

  if (cart.lines.length === 0) return null;

  return (
    <button type="button" className={styles.bar} onClick={onTap}>
      <span className={styles.count}>
        {cart.lines.length} {cart.lines.length === 1 ? 'item' : 'items'}
      </span>
      <span className={styles.dot}>{'·'}</span>
      <span className={styles.total}>
        {estimate ? '~' : ''}{money.format(cart.total)}
      </span>
      <span className={styles.label}>{tenant.label('cart', 'Cart')}</span>
    </button>
  );
}
