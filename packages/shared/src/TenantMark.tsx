import { useState } from 'react';
import { initialsFor, safeLogoUrl } from './branding';
import { useTenant } from './TenantProvider';
import styles from './TenantMark.module.css';

/**
 * The tenant's logo, or an initials block when there isn't one.
 *
 * Both apps use this, and the wireframe is explicit that the rail must survive
 * a tenant with no logo uploaded. `onError` covers the third case the schema
 * allows and the storefront will meet in practice: a `logo_url` that is set but
 * broken.
 */
export function TenantMark({ size = 36 }: { size?: number }) {
  const tenant = useTenant();
  const [failed, setFailed] = useState(false);
  const src = safeLogoUrl(tenant.branding.logo_url);

  if (!src || failed) {
    return (
      <span
        className={styles.initials}
        style={{ width: size, height: size, fontSize: size * 0.38 }}
        aria-hidden="true"
      >
        {initialsFor(tenant.name)}
      </span>
    );
  }

  return (
    <img
      className={styles.logo}
      src={src}
      alt=""
      width={size}
      height={size}
      onError={() => setFailed(true)}
    />
  );
}
