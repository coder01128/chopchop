// Product image rules, tested without a browser and without Storage.
//
//   npm run test
//
// These functions are the reason the dashboard and the storefront cannot
// disagree about which photograph a variant shows. Both import the same file,
// so the rule is testable once, here, and the browser pass only has to confirm
// it is wired up.
//
// The tenant-scoped path is the other half of a security boundary — the bucket
// policies enforce it server-side, and the leak test proves that. What is
// checked here is that nothing in the client ever *builds* a path pointing
// somewhere it should not.

import { describe, expect, it } from 'vitest';
import {
  ACCEPTED_IMAGE_TYPES,
  MAX_UPLOAD_BYTES,
  assignImageToVariants,
  buildImagePath,
  buildLibrary,
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
  type ImageItem,
  type ImageVariant,
} from '../packages/shared/src/image-model';

const TENANT_A = '8b3ffcbf-97da-448f-aa89-f4cd820448d3';
const TENANT_B = '5a660b59-7e29-403e-84a8-f1c3407f2d22';
const ITEM = '1f0c2b1a-3d4e-4f5a-8b7c-9d0e1f2a3b4c';
const OBJECT = 'aa11bb22-cc33-4d44-8e55-ff6677889900';
const SUPABASE_URL = 'https://sxzyhqzqavivmolcbdyj.supabase.co';

function item(overrides: Partial<ImageItem> = {}): ImageItem {
  return { imagePath: null, imageUrl: null, ...overrides };
}

function variant(id: string, imagePath: string | null = null): ImageVariant {
  return { id, imagePath };
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

describe('image paths', () => {
  it('builds a tenant-scoped path from tenant and item', () => {
    const path = buildImagePath(TENANT_A, ITEM, OBJECT, 'image/jpeg');
    expect(path).toBe(`${TENANT_A}/${ITEM}/${OBJECT}.jpg`);
    expect(imagePrefix(TENANT_A, ITEM)).toBe(`${TENANT_A}/${ITEM}`);
  });

  it('never puts a foreign tenant id in a path', () => {
    const path = buildImagePath(TENANT_A, ITEM, OBJECT, 'image/png');
    expect(path.startsWith(`${TENANT_A}/`)).toBe(true);
    expect(path).not.toContain(TENANT_B);
    expect(pathBelongsToTenant(path, TENANT_A)).toBe(true);
    expect(pathBelongsToTenant(path, TENANT_B)).toBe(false);
    expect(pathBelongsToItem(path, TENANT_B, ITEM)).toBe(false);
  });

  it('uses the extension the content type maps to, not the file name', () => {
    expect(buildImagePath(TENANT_A, ITEM, OBJECT, 'image/webp')).toMatch(/\.webp$/);
    expect(Object.keys(ACCEPTED_IMAGE_TYPES)).toEqual([
      'image/jpeg',
      'image/png',
      'image/webp',
    ]);
  });

  it('refuses to build a path for an unaccepted type or a non-uuid segment', () => {
    expect(() => buildImagePath(TENANT_A, ITEM, OBJECT, 'image/svg+xml')).toThrow(
      /content type/,
    );
    expect(() => buildImagePath('../other-tenant', ITEM, OBJECT, 'image/jpeg')).toThrow(
      /tenant id is not a uuid/,
    );
    expect(() => buildImagePath(TENANT_A, '../..', OBJECT, 'image/jpeg')).toThrow(
      /item id is not a uuid/,
    );
  });

  it('derives a public url without signing', () => {
    const path = `${TENANT_A}/${ITEM}/${OBJECT}.jpg`;
    expect(publicImageUrl(SUPABASE_URL, path)).toBe(
      `${SUPABASE_URL}/storage/v1/object/public/product-images/${path}`,
    );
    // A trailing slash on the project URL must not produce a double slash.
    expect(publicImageUrl(`${SUPABASE_URL}/`, path)).not.toContain('co//storage');
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('file validation', () => {
  it('accepts the three photo types', () => {
    for (const [type, extension] of Object.entries(ACCEPTED_IMAGE_TYPES)) {
      const result = validateImageFile({
        name: `stock.${extension}`,
        type,
        size: 900_000,
      });
      expect(result.ok).toBe(true);
    }
  });

  it('refuses a wrong type with a named reason', () => {
    const result = validateImageFile({ name: 'price-list.pdf', type: 'application/pdf', size: 10 });
    expect(result).toMatchObject({ ok: false, reason: 'extension' });
    expect(result.ok === false && result.message).toContain('price-list.pdf');
  });

  it('refuses a photo extension carrying the wrong content type', () => {
    // A renamed file. The extension passes; the type is what catches it.
    const result = validateImageFile({ name: 'shoe.jpg', type: 'application/x-msdownload', size: 4000 });
    expect(result).toMatchObject({ ok: false, reason: 'type' });
  });

  it('refuses an oversized file with a named reason and both sizes', () => {
    const result = validateImageFile({
      name: 'braai.jpg',
      type: 'image/jpeg',
      size: MAX_UPLOAD_BYTES + 1,
    });
    expect(result).toMatchObject({ ok: false, reason: 'size' });
    expect(result.ok === false && result.message).toContain('5.0');
  });

  it('refuses an empty file', () => {
    expect(validateImageFile({ name: 'shoe.jpg', type: 'image/jpeg', size: 0 })).toMatchObject({
      ok: false,
      reason: 'empty',
    });
  });

  it('accepts a file exactly on the cap', () => {
    expect(
      validateImageFile({ name: 'shoe.jpg', type: 'image/jpeg', size: MAX_UPLOAD_BYTES }).ok,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

describe('resolution', () => {
  const primaryPath = `${TENANT_A}/${ITEM}/${OBJECT}.jpg`;
  const variantPath = `${TENANT_A}/${ITEM}/bb22cc33-dd44-4e55-8f66-001122334455.jpg`;

  it('resolves a variant with an assigned image to that image', () => {
    const source = resolveImageSource(item({ imagePath: primaryPath }), variant('v1', variantPath));
    expect(source).toEqual({ kind: 'variant', path: variantPath });
    expect(resolveImageUrl(SUPABASE_URL, item({ imagePath: primaryPath }), variant('v1', variantPath))).toBe(
      publicImageUrl(SUPABASE_URL, variantPath),
    );
  });

  it('resolves a variant with no assigned image to the product primary', () => {
    const source = resolveImageSource(item({ imagePath: primaryPath }), variant('v1'));
    expect(source).toEqual({ kind: 'primary', path: primaryPath });
  });

  it('resolves one photo for three variants that share it', () => {
    const shared = [variant('s7', variantPath), variant('s8', variantPath), variant('s9', variantPath)];
    const product = item({ imagePath: primaryPath });

    for (const size of shared) {
      expect(resolveImageSource(product, size)).toEqual({ kind: 'variant', path: variantPath });
    }
    expect(variantsUsingImage(shared, variantPath)).toHaveLength(3);
  });

  it('falls back to the legacy image_url when there is no uploaded image', () => {
    const source = resolveImageSource(item({ imageUrl: '/products/rump.svg' }), variant('v1'));
    expect(source).toEqual({ kind: 'legacy', url: '/products/rump.svg' });
    // Legacy values are served by the app itself, so they pass through whole.
    expect(resolveImageUrl(SUPABASE_URL, item({ imageUrl: '/products/rump.svg' }))).toBe(
      '/products/rump.svg',
    );
  });

  it('prefers an uploaded primary over the legacy url', () => {
    const source = resolveImageSource(item({ imagePath: primaryPath, imageUrl: '/products/rump.svg' }));
    expect(source).toEqual({ kind: 'primary', path: primaryPath });
  });

  it('resolves a product with no images at all to the empty state, never undefined', () => {
    expect(resolveImageSource(item())).toEqual({ kind: 'empty' });
    expect(resolveImageUrl(SUPABASE_URL, item())).toBeNull();
    expect(resolveImageSource(null)).toEqual({ kind: 'empty' });
    expect(resolveImageSource(undefined, variant('v1'))).toEqual({ kind: 'empty' });
    // Blank strings are the same as absent — an emptied text field must not
    // hand an <img> a src of ''.
    expect(resolveImageSource(item({ imagePath: '  ', imageUrl: '' }))).toEqual({ kind: 'empty' });
  });
});

// ---------------------------------------------------------------------------
// Library and assignment
// ---------------------------------------------------------------------------

describe('library and assignment', () => {
  const one = `${TENANT_A}/${ITEM}/${OBJECT}.jpg`;
  const two = `${TENANT_A}/${ITEM}/bb22cc33-dd44-4e55-8f66-001122334455.jpg`;

  it('builds the library from objects under the product prefix', () => {
    const variants = [variant('s7', two), variant('s8', two), variant('s9')];
    const library = buildLibrary(
      [
        one,
        two,
        // Not this product, not this tenant, and not an image. All dropped.
        `${TENANT_A}/${OBJECT}/other.jpg`,
        `${TENANT_B}/${ITEM}/${OBJECT}.jpg`,
        `${TENANT_A}/${ITEM}/notes.txt`,
      ],
      TENANT_A,
      ITEM,
      item({ imagePath: one }),
      variants,
    );

    expect(library.map((image) => image.path)).toEqual([one, two]);
    expect(library[0]).toMatchObject({ isPrimary: true, variantIds: [] });
    expect(library[1]).toMatchObject({ isPrimary: false, variantIds: ['s7', 's8'] });
  });

  it('assigns one image to an exact set of variants', () => {
    const variants = [variant('s7'), variant('s8'), variant('s9', one)];
    const assigned = assignImageToVariants(variants, two, ['s7', 's8']);

    expect(assigned.map((v) => v.imagePath)).toEqual([two, two, one]);
  });

  it('clears variants dropped from the set, and leaves other images alone', () => {
    const variants = [variant('s7', two), variant('s8', two), variant('s9', one)];
    const assigned = assignImageToVariants(variants, two, ['s7']);

    expect(assigned.map((v) => v.imagePath)).toEqual([two, null, one]);
  });

  it('sets and clears the primary', () => {
    expect(setPrimaryImage(item(), one).imagePath).toBe(one);
    expect(setPrimaryImage(item({ imagePath: one }), null).imagePath).toBeNull();
  });

  it('deleting an image clears its assignments and the affected variants fall back', () => {
    const product = item({ imagePath: one, imageUrl: '/products/court.svg' });
    const variants = [variant('s7', two), variant('s8', two), variant('s9')];

    const removal = removeImage(product, variants, two);

    expect(removal.clearedVariantIds).toEqual(['s7', 's8']);
    expect(removal.clearedPrimary).toBe(false);
    expect(removal.variants.map((v) => v.imagePath)).toEqual([null, null, null]);
    // Falling back, not breaking.
    expect(resolveImageSource(removal.item, removal.variants[0])).toEqual({
      kind: 'primary',
      path: one,
    });
  });

  it('deleting the primary clears it and the product falls back to legacy, then empty', () => {
    const product = item({ imagePath: one, imageUrl: '/products/court.svg' });
    const afterPrimary = removeImage(product, [variant('s7', one)], one);

    expect(afterPrimary.clearedPrimary).toBe(true);
    expect(afterPrimary.clearedVariantIds).toEqual(['s7']);
    expect(resolveImageSource(afterPrimary.item, afterPrimary.variants[0])).toEqual({
      kind: 'legacy',
      url: '/products/court.svg',
    });

    const noLegacy = removeImage(item({ imagePath: one }), [variant('s7', one)], one);
    expect(resolveImageSource(noLegacy.item, noLegacy.variants[0])).toEqual({ kind: 'empty' });
  });

  it('does not mutate what it is given', () => {
    const variants = [variant('s7', two)];
    const product = item({ imagePath: one });

    removeImage(product, variants, two);
    assignImageToVariants(variants, one, ['s7']);
    setPrimaryImage(product, two);

    expect(variants[0].imagePath).toBe(two);
    expect(product.imagePath).toBe(one);
  });
});
