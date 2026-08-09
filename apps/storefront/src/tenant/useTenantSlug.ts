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

/**
 * Path segments that are the storefront's own routes rather than a tenant.
 *
 * Without this, a production deployment resolving its slug from the env would
 * see `/order/<id>` and go looking for a tenant called "order" — the status
 * page would render Not Found on the one domain it matters on.
 */
const RESERVED_SEGMENTS = ['order'];

function firstSegment(pathname: string): string | null {
  const segment = pathname.split('/').filter(Boolean)[0];
  if (!segment || RESERVED_SEGMENTS.includes(segment)) return null;
  return segment;
}

export function resolveSlugFromLocation(pathname: string): string | null {
  const fromPath = firstSegment(pathname);
  if (fromPath) return fromPath;

  const fromEnv = import.meta.env.VITE_TENANT_SLUG;
  return typeof fromEnv === 'string' && fromEnv.trim() ? fromEnv.trim() : null;
}

/**
 * Links inside the storefront have to keep whichever addressing the buyer
 * arrived on: `/demo-shoes/order/…` in development, `/order/…` on a client's
 * own domain. Both are the same shop.
 */
export function orderPath(pathname: string, orderId: string): string {
  const slug = firstSegment(pathname);
  return `${slug ? `/${slug}` : ''}/order/${orderId}`;
}

export function shopPath(pathname: string): string {
  const slug = firstSegment(pathname);
  return slug ? `/${slug}` : '/';
}
