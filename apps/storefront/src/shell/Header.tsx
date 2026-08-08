import { useEffect } from 'react';
import { TenantMark, useTenant } from '@chopchop/shared';
import styles from './Header.module.css';

/**
 * The storefront's entire chrome for now: the tenant's mark, name and tagline.
 * The catalogue, cart and checkout are later tickets.
 */
export function Header() {
  const tenant = useTenant();

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
      </div>
    </header>
  );
}
