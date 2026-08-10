export type { Database, Json } from '../types/db';

export { getSupabaseClient, getSupabaseUrl, type ChopChopClient } from './supabase';

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

export {
  ACCEPTED_IMAGE_TYPES,
  IMAGE_ACCEPT_ATTRIBUTE,
  IMAGE_BUCKET,
  MAX_UPLOAD_BYTES,
  RESIZE_MAX_EDGE,
  RESIZE_OUTPUT_TYPE,
  RESIZE_QUALITY,
  assignImageToVariants,
  buildImagePath,
  buildLibrary,
  imageSrc,
  imagePrefix,
  pathBelongsToItem,
  pathBelongsToTenant,
  publicImageUrl,
  removeImage,
  resolveImageSource,
  resolveImageUrl,
  setPrimaryImage,
  validateImageFile,
  variantsUsingImage,
  type FileRejection,
  type ImageItem,
  type ImageRemoval,
  type ImageSource,
  type ImageVariant,
  type LibraryImage,
  type PickedFile,
} from './image-model';

export { TenantProvider, useTenant, useTenantOrNull } from './TenantProvider';

export { TenantMark } from './TenantMark';
