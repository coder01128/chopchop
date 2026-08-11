/**
 * Which tenant is this storefront?
 *
 * One deployment serves every client, on the apex, at `/<slug>` — ticket 08.
 * So in production the slug is the first path segment, and the same addressing
 * runs in development, where one dev server has to serve both demo tenants:
 * they are configured as opposites deliberately, and a feature that works for
 * one and not the other isn't finished.
 *
 * `VITE_TENANT_SLUG` is the fallback for the case that does not exist yet — a
 * client on their own domain, where there is no slug segment to read. It is
 * unset on the apex deployment. Path wins over env, so a per-client deployment
 * can still be checked against another tenant without a rebuild.
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

/**
 * The bare apex — `chopchoporder.co.za` with no path at all.
 *
 * Distinct from an unknown slug, and the two must not render the same screen.
 * A stranger typing the domain after seeing a link is not looking at a broken
 * shop; they are looking at the front door, and it renders a holding page.
 * `/order/<id>` with no slug *is* a broken link and stays on Not Found.
 */
export function isBareRoot(pathname: string): boolean {
  return pathname.split('/').filter(Boolean).length === 0;
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
