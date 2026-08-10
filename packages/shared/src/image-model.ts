/**
 * Product images, as pure functions.
 *
 * This file lives in `shared` rather than in either app on purpose. The
 * dashboard decides which photo a variant carries and the storefront renders
 * it; if the two answered that question separately they would eventually
 * disagree, and the seller would be looking at a different picture from their
 * buyer. One resolution function, imported by both.
 *
 * From SCHEMA.md, the whole model in four lines:
 *
 *   variant.image_path -> item.image_path -> item.image_url -> empty
 *
 * `image_path` is a Storage object path, never a URL. The public URL is derived
 * at render time, so changing the Supabase project ref does not invalidate
 * every row in the database.
 *
 * `items.image_url` is legacy and read-only. It holds root-relative paths to
 * the SVGs committed under `apps/*\/public/products/`, written before Storage
 * existed. Nothing writes it again; it stays as the last stop before the empty
 * state so the seeded catalogue keeps rendering without a data migration.
 *
 * There is no images table. A product's library is whatever objects exist under
 * `<tenant_id>/<item_id>/` in the bucket, so an object and a row can never
 * disagree about what exists.
 */

export const IMAGE_BUCKET = 'product-images';

/**
 * Accepted content types, and the extension each is stored under.
 *
 * The same three are declared on the bucket itself, so a client that skips this
 * check is refused by Storage. Both halves are wanted: this one produces a
 * sentence the seller can act on, the bucket produces the guarantee.
 */
export const ACCEPTED_IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** What the file input advertises, so the OS picker filters to photographs. */
export const IMAGE_ACCEPT_ATTRIBUTE = Object.keys(ACCEPTED_IMAGE_TYPES).join(',');

/**
 * Extensions accepted on the way in. Checked alongside the content type, not
 * instead of it — a renamed `.exe` carries the wrong type, and a browser that
 * reports no type at all still has a name.
 */
const ACCEPTED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp']);

/**
 * 5 MB, matching `file_size_limit` on the bucket.
 *
 * Not the working limit — the client resizes first and a resized catalogue
 * photo lands well under 500 KB. This is the backstop for a resize that failed
 * or was bypassed, set above a modern phone's 3-6 MB raw shot so the friendly
 * error comes from here rather than a 413 from Storage.
 */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/**
 * Client-side resize target.
 *
 * 1600px on the long edge covers the largest place a photo is shown — the
 * product sheet on a desktop storefront — at 2x. A catalogue tile is 200px.
 * JPEG at 0.82 is where the artefacts stop being visible on a photograph of a
 * physical object; below 0.75 the flat areas of a studio-lit shoe start
 * banding. A 4 MB phone shot lands around 250-400 KB, which is the difference
 * between a usable upload and a seller giving up on a mobile connection.
 */
export const RESIZE_MAX_EDGE = 1600;
export const RESIZE_QUALITY = 0.82;
export const RESIZE_OUTPUT_TYPE = 'image/jpeg';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * The folder holding one product's library.
 *
 * The tenant id is the first segment because the bucket policies derive access
 * from exactly that, using the same `user_tenant_ids()` helper the table
 * policies use. Anything that builds a path some other way is a second source
 * of truth about who owns a folder, and the two will drift.
 */
export function imagePrefix(tenantId: string, itemId: string): string {
  requireUuid(tenantId, 'tenant id');
  requireUuid(itemId, 'item id');
  return `${tenantId}/${itemId}`;
}

/**
 * A path for a new object. `objectId` is supplied rather than generated inside,
 * so the caller can log it and the tests can assert on it.
 */
export function buildImagePath(
  tenantId: string,
  itemId: string,
  objectId: string,
  contentType: string,
): string {
  const extension = ACCEPTED_IMAGE_TYPES[contentType];
  if (!extension) {
    throw new Error(`Refusing to build a path for content type ${contentType}`);
  }
  requireUuid(objectId, 'object id');
  return `${imagePrefix(tenantId, itemId)}/${objectId}.${extension}`;
}

/**
 * Whether a path sits under a tenant's own prefix.
 *
 * Storage refuses a cross-tenant write on its own, by policy. This is the
 * dashboard's half: a path that failed this check never reaches the network, so
 * the seller gets a sentence instead of a 400, and anything that reads a path
 * out of a list can filter before rendering it.
 */
export function pathBelongsToTenant(path: string, tenantId: string): boolean {
  if (!path) return false;
  return path.split('/')[0] === tenantId;
}

export function pathBelongsToItem(path: string, tenantId: string, itemId: string): boolean {
  return path.startsWith(`${imagePrefix(tenantId, itemId)}/`);
}

function requireUuid(value: string, label: string): void {
  if (!UUID_PATTERN.test(value ?? '')) {
    throw new Error(`Refusing to build an image path: ${label} is not a uuid`);
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type FileRejection =
  | { ok: true }
  | { ok: false; reason: 'type' | 'extension' | 'size' | 'empty'; message: string };

/** The shape this needs from a `File`, so tests do not need one. */
export interface PickedFile {
  name: string;
  type: string;
  size: number;
}

/**
 * Type and size, refused with a named reason.
 *
 * The reason is part of the return value rather than a thrown error because
 * every caller shows it to a seller standing in their shop, and "something went
 * wrong" is what makes them stop trying.
 */
export function validateImageFile(file: PickedFile): FileRejection {
  if (!file || file.size === 0) {
    return { ok: false, reason: 'empty', message: 'That file is empty.' };
  }

  const extension = extensionOf(file.name);
  if (!ACCEPTED_EXTENSIONS.has(extension)) {
    return {
      ok: false,
      reason: 'extension',
      message: `${file.name} is not a photo. Use a JPG, PNG or WEBP.`,
    };
  }

  if (!ACCEPTED_IMAGE_TYPES[file.type]) {
    return {
      ok: false,
      reason: 'type',
      message: `${file.name} is not a JPG, PNG or WEBP.`,
    };
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      reason: 'size',
      message: `${file.name} is ${megabytes(file.size)} MB. The limit is ${megabytes(
        MAX_UPLOAD_BYTES,
      )} MB.`,
    };
  }

  return { ok: true };
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

function megabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

// ---------------------------------------------------------------------------
// Public URLs
// ---------------------------------------------------------------------------

/**
 * The public URL for an object path.
 *
 * The bucket is public-read, so this is a plain URL with no signing and no
 * expiry — it caches in the CDN and in the PWA, which is the reason the bucket
 * is not private. Built here rather than through `storage.getPublicUrl()` so a
 * model function can be tested without a Supabase client.
 */
export function publicImageUrl(supabaseUrl: string, path: string): string {
  const base = supabaseUrl.replace(/\/+$/, '');
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return `${base}/storage/v1/object/public/${IMAGE_BUCKET}/${encoded}`;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** What resolution needs from a product. */
export interface ImageItem {
  imagePath: string | null;
  /** Legacy. Written before Storage existed; never written again. */
  imageUrl: string | null;
}

/** What resolution needs from a variant. Null path means "use the product's". */
export interface ImageVariant {
  id: string;
  imagePath: string | null;
}

/**
 * Where a rendered image came from.
 *
 * `empty` is a value, not an absence. A component that receives it draws the
 * neutral block; nothing anywhere has to decide what `undefined` means, and no
 * `<img>` is ever handed a null src.
 */
export type ImageSource =
  | { kind: 'variant'; path: string }
  | { kind: 'primary'; path: string }
  | { kind: 'legacy'; url: string }
  | { kind: 'empty' };

/**
 * The one resolution rule, used by the dashboard and the storefront both.
 *
 * A variant with its own photo wins. Without one it falls back to the product
 * primary — which is what makes a single upload cover sizes 7, 8 and 9 without
 * the seller assigning it three times. `variant` is optional because the
 * catalogue tile resolves before a buyer has chosen anything.
 */
export function resolveImageSource(
  item: ImageItem | null | undefined,
  variant?: ImageVariant | null,
): ImageSource {
  if (!item) return { kind: 'empty' };

  const variantPath = nonEmpty(variant?.imagePath);
  if (variantPath) return { kind: 'variant', path: variantPath };

  const primary = nonEmpty(item.imagePath);
  if (primary) return { kind: 'primary', path: primary };

  const legacy = nonEmpty(item.imageUrl);
  if (legacy) return { kind: 'legacy', url: legacy };

  return { kind: 'empty' };
}

/**
 * The resolved source as something an `<img>` can take, or null for the empty
 * state. Legacy values are root-relative paths served by the app itself, so
 * they pass through untouched.
 */
export function imageSrc(source: ImageSource, supabaseUrl: string): string | null {
  switch (source.kind) {
    case 'variant':
    case 'primary':
      return publicImageUrl(supabaseUrl, source.path);
    case 'legacy':
      return source.url;
    case 'empty':
      return null;
  }
}

/** The two steps together, which is what a component actually wants. */
export function resolveImageUrl(
  supabaseUrl: string,
  item: ImageItem | null | undefined,
  variant?: ImageVariant | null,
): string | null {
  return imageSrc(resolveImageSource(item, variant), supabaseUrl);
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

// ---------------------------------------------------------------------------
// The library and its assignments
// ---------------------------------------------------------------------------

/**
 * One image in a product's library. `path` is the identity — there is no row
 * and no id of its own.
 */
export interface LibraryImage {
  path: string;
  /** True when this is the product's primary. */
  isPrimary: boolean;
  /** Ids of the variants assigned to it. Empty is the ordinary case. */
  variantIds: string[];
}

/**
 * Build the library view from the objects under a product's prefix.
 *
 * Storage is the source of truth for which images exist; the rows only say what
 * points at them. Anything under the prefix that is not a recognised image, and
 * anything not under the prefix at all, is dropped rather than rendered — a
 * listing is data from outside, and a path that fails the tenant check should
 * never reach an `<img>`.
 */
export function buildLibrary(
  objectPaths: string[],
  tenantId: string,
  itemId: string,
  item: ImageItem,
  variants: ImageVariant[],
): LibraryImage[] {
  const primary = nonEmpty(item.imagePath);

  return objectPaths
    .filter((path) => pathBelongsToItem(path, tenantId, itemId))
    .filter((path) => ACCEPTED_EXTENSIONS.has(extensionOf(path)))
    .map((path) => ({
      path,
      isPrimary: path === primary,
      variantIds: variantsUsingImage(variants, path).map((variant) => variant.id),
    }));
}

export function variantsUsingImage(variants: ImageVariant[], path: string): ImageVariant[] {
  return variants.filter((variant) => nonEmpty(variant.imagePath) === path);
}

/**
 * Set the product primary.
 *
 * The primary is what the catalogue grid and the product tile show, so a
 * product with a library and no primary would be a grid of neutral blocks over
 * a folder full of photographs. Callers set the first upload as primary for
 * that reason; this function is what they call.
 */
export function setPrimaryImage(item: ImageItem, path: string | null): ImageItem {
  return { ...item, imagePath: nonEmpty(path) };
}

/**
 * Assign one image to an exact set of variants.
 *
 * The control is per-image — "which variants use this photo" — because that is
 * the direction where one upload covers three sizes. Per-variant would mean the
 * seller shoots one shoe and uploads it three times.
 *
 * Variants not in `variantIds` that currently point at this path are cleared,
 * so the set given is the set that results. Variants pointing at some other
 * image are untouched.
 */
export function assignImageToVariants(
  variants: ImageVariant[],
  path: string,
  variantIds: string[],
): ImageVariant[] {
  const wanted = new Set(variantIds);
  return variants.map((variant) => {
    if (wanted.has(variant.id)) return { ...variant, imagePath: path };
    if (nonEmpty(variant.imagePath) === path) return { ...variant, imagePath: null };
    return variant;
  });
}

/** What a delete changes, before anything is written. */
export interface ImageRemoval {
  item: ImageItem;
  variants: ImageVariant[];
  /** Variants that were pointing at it and now fall back. */
  clearedVariantIds: string[];
  /** True when the deleted image was the primary. */
  clearedPrimary: boolean;
}

/**
 * Remove every reference to an image.
 *
 * Deleting the object without this leaves rows pointing at a 404, and a broken
 * `<img>` on a buyer's screen is worse than no photograph. Both apps fall back
 * through the same chain afterwards, so a cleared variant shows the primary and
 * a cleared primary shows the legacy value or the empty state.
 */
export function removeImage(
  item: ImageItem,
  variants: ImageVariant[],
  path: string,
): ImageRemoval {
  const cleared = variantsUsingImage(variants, path).map((variant) => variant.id);
  const clearedPrimary = nonEmpty(item.imagePath) === path;

  return {
    item: clearedPrimary ? { ...item, imagePath: null } : item,
    variants: variants.map((variant) =>
      nonEmpty(variant.imagePath) === path ? { ...variant, imagePath: null } : variant,
    ),
    clearedVariantIds: cleared,
    clearedPrimary,
  };
}
