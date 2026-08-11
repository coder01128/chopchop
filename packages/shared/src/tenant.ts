import type { Database } from '../types/db';

export type TenantRow = Database['public']['Tables']['tenants']['Row'];
export type SaleMode = Database['public']['Enums']['sale_mode'];
export type StockMode = Database['public']['Enums']['stock_mode'];
export type FulfilmentMode = Database['public']['Enums']['fulfilment_mode'];
export type OrderStatus = Database['public']['Enums']['order_status'];

/**
 * What the storefront can read. `created_at` and `listed` are withheld from
 * the `anon` role by column grant, so asking for either there fails the whole
 * query — not just the column. Keep this list and the grant in
 * `20260808120200_tighten_grants.sql` in step.
 */
export const PUBLIC_TENANT_COLUMNS =
  'id, slug, name, whatsapp_number, branding, attribute_schema, sale_mode, stock_mode, fulfilment_mode, active';

/**
 * The omissions are the grant, expressed as a type: a storefront screen that
 * reaches for `listed` should not compile, never mind fail at runtime.
 */
export type PublicTenant = Omit<TenantRow, 'created_at' | 'listed'>;

/**
 * One attribute in a tenant's `attribute_schema`. The product modal is
 * generated from this list — it is the only thing in the codebase that knows
 * what a client sells.
 */
export interface TenantAttribute {
  name: string;
  label: string;
  options: string[];
}

export interface TenantBranding {
  primary?: string | null;
  logo_url?: string | null;
  tagline?: string | null;
  labels?: Record<string, string> | null;
}

/**
 * The resolved tenant, as every screen sees it. Behaviour is read from here
 * and never from a literal: a component that knows the word `meat` is wrong.
 */
export interface TenantConfig {
  id: string;
  slug: string;
  name: string;
  whatsappNumber: string | null;
  branding: TenantBranding;
  attributeSchema: TenantAttribute[];
  saleMode: SaleMode;
  stockMode: StockMode;
  fulfilmentMode: FulfilmentMode;
  active: boolean;
  /** Label override from `branding.labels`, falling back to the given default. */
  label: (key: string, fallback: string) => string;
}

function asBranding(value: unknown): TenantBranding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as TenantBranding;
}

/**
 * `attribute_schema` is jsonb, so the database guarantees only that it is an
 * array. Anything malformed is dropped rather than allowed to reach the variant
 * editor and crash it — a tenant with a broken schema should render an empty
 * modal, not a white screen.
 */
function asAttributeSchema(value: unknown): TenantAttribute[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is TenantAttribute =>
      !!entry &&
      typeof entry === 'object' &&
      typeof (entry as TenantAttribute).name === 'string' &&
      Array.isArray((entry as TenantAttribute).options),
  );
}

export function toTenantConfig(row: PublicTenant | TenantRow): TenantConfig {
  const branding = asBranding(row.branding);
  const labels = branding.labels ?? {};

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    whatsappNumber: row.whatsapp_number,
    branding,
    attributeSchema: asAttributeSchema(row.attribute_schema),
    saleMode: row.sale_mode,
    stockMode: row.stock_mode,
    fulfilmentMode: row.fulfilment_mode,
    active: row.active,
    label: (key, fallback) => {
      const override = labels[key];
      return typeof override === 'string' && override.trim() ? override : fallback;
    },
  };
}
