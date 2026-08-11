import type { ChopChopClient } from '@chopchop/shared';

/**
 * `tenants.listed` — read and written here and nowhere else.
 *
 * It is deliberately not on `TenantConfig`. The storefront must never read it
 * (the `anon` column grant does not include it), and putting it on the shared
 * config would put it one autocomplete away from a buyer-facing screen. One
 * extra round trip on the one screen that owns the setting is the cheaper
 * mistake.
 */
export async function loadListed(client: ChopChopClient, tenantId: string): Promise<boolean> {
  const { data, error } = await client
    .from('tenants')
    .select('listed')
    .eq('id', tenantId)
    .single();

  if (error) throw new Error(error.message);
  return data.listed;
}

export async function setListed(
  client: ChopChopClient,
  tenantId: string,
  listed: boolean,
): Promise<void> {
  const { error } = await client.from('tenants').update({ listed }).eq('id', tenantId);
  if (error) throw new Error(error.message);
}
