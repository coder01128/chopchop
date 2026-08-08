import { useEffect } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { TenantMark, useTenant } from '@chopchop/shared';
import { useAuth } from '../auth/AuthProvider';
import styles from './Shell.module.css';

/**
 * Section 00 of the wireframe: persistent tenant-branded chrome.
 *
 * Mobile-first — a bottom tab bar under the breakpoint, a left rail above it —
 * because the seller is on a phone behind a counter far more often than at a
 * desk. Both are the same nav list rendered twice by CSS, not two components.
 *
 * Name, mark and accent come from the tenant row. The nav labels deliberately
 * do not: `branding.labels` is the client's customer-facing vocabulary —
 * "Spyskaart", "Mandjie" — and it applies to the storefront only. The dashboard
 * is Brad's product, not the client's brand surface, so its nav and controls
 * use fixed wording. A customer-facing word leaking into an internal tool is a
 * bug. If a translated dashboard is ever wanted, that is a locale field, not a
 * branding override.
 */
const NAV = [
  { to: '/orders', label: 'Orders' },
  { to: '/catalogue', label: 'Catalogue' },
  { to: '/import', label: 'Import' },
  { to: '/settings', label: 'Settings' },
] as const;

export function Shell() {
  const tenant = useTenant();
  const { session, signOut } = useAuth();

  // One deployment serves every tenant, so even the tab title is tenant data.
  useEffect(() => {
    document.title = `${tenant.name} · ChopChop`;
  }, [tenant.name]);

  const nav = NAV.map((entry) => (
    <NavLink
      key={entry.to}
      to={entry.to}
      className={({ isActive }) => (isActive ? `${styles.navLink} ${styles.navLinkActive}` : styles.navLink)}
    >
      {entry.label}
    </NavLink>
  ));

  return (
    <div className={styles.layout}>
      <header className={styles.topbar}>
        <div className={styles.brand}>
          <TenantMark size={32} />
          <span className={styles.brandName}>{tenant.name}</span>
        </div>
        <div className={styles.account}>
          <span className={styles.email}>{session?.user.email}</span>
          <button className={styles.signOut} type="button" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </header>

      <nav className={styles.rail} aria-label="Sections">
        {nav}
      </nav>

      <main className={styles.content}>
        <Outlet />
      </main>

      <nav className={styles.tabbar} aria-label="Sections">
        {nav}
      </nav>
    </div>
  );
}
