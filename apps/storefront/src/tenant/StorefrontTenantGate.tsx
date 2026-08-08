import { useEffect, useState, type ReactNode } from 'react';
import {
  getSupabaseClient,
  PUBLIC_TENANT_COLUMNS,
  TenantProvider,
  type PublicTenant,
} from '@chopchop/shared';
import { NotFound } from './NotFound';
import { resolveSlugFromLocation } from './useTenantSlug';

type State =
  | { status: 'loading' }
  | { status: 'ready'; tenant: PublicTenant }
  | { status: 'missing' };

/**
 * Resolves the tenant from the URL slug, as the `anon` role.
 *
 * It deliberately does NOT call signInAnonymously(). Per SCHEMA.md that happens
 * lazily at checkout, when the buyer needs an identity to own an order and
 * subscribe to its status. Doing it here would mint an auth user for every
 * passer-by who never orders, and those accumulate in auth.users.
 *
 * The column list is `PUBLIC_TENANT_COLUMNS`, not `*`: `anon` has a
 * column-level grant that withholds `created_at`, and asking for a column you
 * cannot read fails the entire query rather than omitting it.
 */
export function StorefrontTenantGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const slug = resolveSlugFromLocation(window.location.pathname);

  useEffect(() => {
    let active = true;

    if (!slug) {
      setState({ status: 'missing' });
      return;
    }

    const supabase = getSupabaseClient();

    void supabase
      .from('tenants')
      .select(PUBLIC_TENANT_COLUMNS)
      .eq('slug', slug)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!active) return;
        // An inactive tenant is filtered out by RLS before it reaches here, so
        // "switched off" and "never existed" arrive as the same empty result —
        // which is the right amount to tell a stranger either way.
        if (error || !data) {
          setState({ status: 'missing' });
          return;
        }
        setState({ status: 'ready', tenant: data as PublicTenant });
      });

    return () => {
      active = false;
    };
  }, [slug]);

  if (state.status === 'loading') return null;
  if (state.status === 'missing') return <NotFound slug={slug} />;

  return <TenantProvider tenant={state.tenant}>{children}</TenantProvider>;
}
