/**
 * Which tenant is this storefront?
 *
 * The storefront is deployed per client on their own domain, so in production
 * the slug is fixed per deployment and comes from `VITE_TENANT_SLUG`. In
 * development one dev server has to be able to serve both demo tenants — they
 * are configured as opposites deliberately, and a feature that works for one
 * and not the other isn't finished — so a leading path segment overrides it.
 *
 * Path wins over env, which means a production deployment can still be checked
 * against another tenant's slug without a rebuild.
 */
export function resolveSlugFromLocation(pathname: string): string | null {
  const fromPath = pathname.split('/').filter(Boolean)[0];
  if (fromPath) return fromPath;

  const fromEnv = import.meta.env.VITE_TENANT_SLUG;
  return typeof fromEnv === 'string' && fromEnv.trim() ? fromEnv.trim() : null;
}
