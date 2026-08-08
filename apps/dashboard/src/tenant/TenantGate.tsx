import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { getSupabaseClient, TenantProvider, type TenantRow } from '@chopchop/shared';
import { useAuth } from '../auth/AuthProvider';
import { Notice } from '../ui/Notice';
import { TenantPicker } from './TenantPicker';

type Membership = { tenant_id: string; role: string; tenants: TenantRow | null };

const STORED_TENANT_KEY = 'chopchop.dashboard.tenant';

/**
 * Resolves which business this login belongs to, through `tenant_users`.
 *
 * Nothing inside the shell renders until this settles, because every screen
 * downstream reads its behaviour from the tenant row — sale_mode, stock_mode,
 * attribute_schema. A screen that rendered first would have to guess, and
 * guessing is how vertical-specific logic gets into components.
 */
export function TenantGate({ children }: { children: ReactNode }) {
  const supabase = getSupabaseClient();
  const { session, signOut } = useAuth();
  const userId = session?.user.id;

  const [memberships, setMemberships] = useState<Membership[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    localStorage.getItem(STORED_TENANT_KEY),
  );

  const load = useCallback(async () => {
    if (!userId) return;
    setError(null);

    const { data, error: queryError } = await supabase
      .from('tenant_users')
      .select('tenant_id, role, tenants(*)')
      .eq('user_id', userId);

    if (queryError) {
      // A rejected JWT means the session died between the last refresh and this
      // query. Returning to sign-in is the correct end state, not an error card.
      if (queryError.code === 'PGRST301' || queryError.message.toLowerCase().includes('jwt')) {
        await signOut();
        return;
      }
      setError(queryError.message);
      return;
    }

    setMemberships((data ?? []) as Membership[]);
  }, [supabase, userId, signOut]);

  useEffect(() => {
    setMemberships(null);
    void load();
  }, [load]);

  if (error) {
    return (
      <Notice title="Could not load your business" tone="error" action={{ label: 'Try again', onClick: () => void load() }}>
        {error}
      </Notice>
    );
  }

  if (memberships === null) return <Notice title="Loading…" />;

  const linked = memberships.filter((m): m is Membership & { tenants: TenantRow } => !!m.tenants);

  // A login with no tenant_users row. There is no self-serve path out of this —
  // Brad links the login — so the screen says so plainly instead of offering
  // a button that cannot work.
  if (linked.length === 0) {
    return (
      <Notice
        title="No business linked to this login"
        action={{ label: 'Sign out', onClick: () => void signOut() }}
      >
        This account is not linked to a business yet. Whoever set up your dashboard needs to link
        it before you can sign in.
      </Notice>
    );
  }

  // v1 never hits this — one login, one business — but the schema permits many
  // and a picker is cheaper than discovering the assumption later.
  if (linked.length > 1 && !linked.some((m) => m.tenant_id === selectedId)) {
    return (
      <TenantPicker
        options={linked.map((m) => m.tenants)}
        onPick={(id) => {
          localStorage.setItem(STORED_TENANT_KEY, id);
          setSelectedId(id);
        }}
      />
    );
  }

  const active = linked.find((m) => m.tenant_id === selectedId) ?? linked[0];

  return <TenantProvider tenant={active.tenants}>{children}</TenantProvider>;
}
