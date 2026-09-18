import { useEffect } from 'react';
import { TenantMark, useTenant } from '@chopchop/shared';
import styles from './Header.module.css';

export function Header({
  onMenuToggle,
  activeCategoryName,
}: {
  onMenuToggle?: () => void;
  activeCategoryName?: string | null;
}) {
  const tenant = useTenant();

  useEffect(() => {
    document.title = tenant.name;
  }, [tenant.name]);

  return (
    <header className={styles.header}>
      <div className={styles.inner}>
        {onMenuToggle && (
          <button
            type="button"
            className={styles.hamburger}
            onClick={onMenuToggle}
            aria-label="Open categories"
          >
            <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
              <line x1="2" y1="5" x2="18" y2="5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <line x1="2" y1="10" x2="18" y2="10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <line x1="2" y1="15" x2="18" y2="15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        )}
        <TenantMark size={44} />
        <div className={styles.text}>
          <span className={styles.name}>{tenant.name}</span>
          {tenant.branding.tagline && (
            <span className={styles.tagline}>{tenant.branding.tagline}</span>
          )}
        </div>
        {activeCategoryName && (
          <span className={styles.activeCategory}>{activeCategoryName}</span>
        )}
      </div>
    </header>
  );
}
