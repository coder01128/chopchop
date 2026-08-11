// How a URL becomes a tenant, without a browser.
//
//   npx vitest run tests/storefront-routing.test.ts
//
// One deployment serves every client off the apex at /<slug>, so these four
// functions decide which shop a buyer is standing in. They are also what
// decides that the bare apex renders a holding page rather than a client's
// catalogue, which is the one wrong answer that would be a real problem.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isBareRoot,
  orderPath,
  resolveSlugFromLocation,
  shopPath,
} from '../apps/storefront/src/tenant/useTenantSlug';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveSlugFromLocation', () => {
  it('takes the first path segment', () => {
    expect(resolveSlugFromLocation('/demo-butchery')).toBe('demo-butchery');
    expect(resolveSlugFromLocation('/demo-shoes/')).toBe('demo-shoes');
  });

  it('ignores deeper segments', () => {
    expect(resolveSlugFromLocation('/demo-shoes/order/abc-123')).toBe('demo-shoes');
  });

  it('returns null on the bare root with no env fallback', () => {
    expect(resolveSlugFromLocation('/')).toBeNull();
    expect(resolveSlugFromLocation('')).toBeNull();
  });

  // `order` is the storefront's own route. Without the reserved list a
  // per-client deployment would go looking for a tenant called "order" and
  // the buyer's status page would render Not Found on the one domain that
  // matters.
  it('does not read a reserved segment as a slug', () => {
    expect(resolveSlugFromLocation('/order/abc-123')).toBeNull();
  });

  it('falls back to VITE_TENANT_SLUG only when the path has no slug', () => {
    vi.stubEnv('VITE_TENANT_SLUG', 'client-own-domain');
    expect(resolveSlugFromLocation('/')).toBe('client-own-domain');
    expect(resolveSlugFromLocation('/order/abc-123')).toBe('client-own-domain');
    // Path still wins, so a per-client deployment can be checked against
    // another tenant without a rebuild.
    expect(resolveSlugFromLocation('/demo-shoes')).toBe('demo-shoes');
  });

  it('treats a blank env slug as unset', () => {
    vi.stubEnv('VITE_TENANT_SLUG', '   ');
    expect(resolveSlugFromLocation('/')).toBeNull();
  });
});

describe('isBareRoot', () => {
  // The whole point of this function: the front door and a broken link must
  // not render the same screen.
  it('is true only when there is no path segment at all', () => {
    expect(isBareRoot('/')).toBe(true);
    expect(isBareRoot('')).toBe(true);
    expect(isBareRoot('/demo-butchery')).toBe(false);
    expect(isBareRoot('/order/abc-123')).toBe(false);
    expect(isBareRoot('/not-a-shop')).toBe(false);
  });
});

describe('links keep the addressing the buyer arrived on', () => {
  it('keeps the slug when there is one', () => {
    expect(orderPath('/demo-shoes', 'abc-123')).toBe('/demo-shoes/order/abc-123');
    expect(shopPath('/demo-shoes/order/abc-123')).toBe('/demo-shoes');
  });

  it('drops it on a client-owned domain', () => {
    expect(orderPath('/', 'abc-123')).toBe('/order/abc-123');
    expect(shopPath('/order/abc-123')).toBe('/');
  });
});
