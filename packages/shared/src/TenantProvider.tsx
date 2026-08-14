import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { applyBranding } from './branding';
import { toTenantConfig, type PublicTenant, type TenantConfig, type TenantRow } from './tenant';

/**
 * The context every later screen reads behaviour from.
 *
 * How a tenant is *resolved* differs by app — the dashboard goes through
 * `tenant_users`, the storefront through a URL slug — so that lives in each
 * app. What a resolved tenant *is* lives here, once, for both.
 */
const TenantContext = createContext<TenantConfig | null>(null);

export function TenantProvider({
  tenant,
  children,
  skipColour,
}: {
  tenant: PublicTenant | TenantRow;
  children: ReactNode;
  skipColour?: boolean;
}) {
  const config = useMemo(() => toTenantConfig(tenant), [tenant]);

  useEffect(() => {
    applyBranding(config.branding, skipColour ? { skipColour: true } : undefined);
  }, [config.branding, skipColour]);

  return <TenantContext.Provider value={config}>{children}</TenantContext.Provider>;
}

export function useTenant(): TenantConfig {
  const tenant = useContext(TenantContext);
  if (!tenant) {
    throw new Error('useTenant() called outside a <TenantProvider>. Nothing renders before the tenant resolves.');
  }
  return tenant;
}

/** For chrome that renders either side of tenant resolution. */
export function useTenantOrNull(): TenantConfig | null {
  return useContext(TenantContext);
}
