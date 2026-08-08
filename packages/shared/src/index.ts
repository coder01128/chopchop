export type { Database, Json } from '../types/db';

export { getSupabaseClient, type ChopChopClient } from './supabase';

export {
  PUBLIC_TENANT_COLUMNS,
  toTenantConfig,
  type FulfilmentMode,
  type OrderStatus,
  type PublicTenant,
  type SaleMode,
  type StockMode,
  type TenantAttribute,
  type TenantBranding,
  type TenantConfig,
  type TenantRow,
} from './tenant';

export {
  DEFAULT_ACCENT,
  applyBranding,
  initialsFor,
  inkOn,
  safeAccent,
  safeLogoUrl,
} from './branding';

export { TenantProvider, useTenant, useTenantOrNull } from './TenantProvider';

export { TenantMark } from './TenantMark';
