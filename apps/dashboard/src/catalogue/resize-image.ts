import { RESIZE_MAX_EDGE, RESIZE_OUTPUT_TYPE, RESIZE_QUALITY } from '@chopchop/shared';

/**
 * The only file that knows what a photograph is, in the same way `parse-file.ts`
 * is the only file that knows what a spreadsheet is.
 *
 * A phone camera produces 3-6 MB per shot and a catalogue tile is 200px wide.
 * Uploading the original wastes the seller's data — the thing they are most
 * price-sensitive about — and makes the storefront slow for every buyer
 * afterwards. Resizing happens here, before the upload, so the network only
 * ever carries the size that is actually used.
 *
 * `imageOrientation: 'from-image'` matters more than it looks: a photo taken
 * holding a phone upright carries its rotation in EXIF, and a canvas draw
 * without this flag bakes in the wrong one — every shot sideways, which is
 * exactly the sort of thing a seller blames the whole product for.
 */
export interface ResizedImage {
  blob: Blob;
  contentType: string;
  width: number;
  height: number;
}

export async function resizeImage(file: Blob): Promise<ResizedImage> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });

  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height, RESIZE_MAX_EDGE);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser could not prepare the photo.');

    // A JPEG has no transparency, so a PNG with one would composite onto black.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, RESIZE_OUTPUT_TYPE, RESIZE_QUALITY),
    );
    if (!blob) throw new Error('This browser could not prepare the photo.');

    return { blob, contentType: RESIZE_OUTPUT_TYPE, width, height };
  } finally {
    bitmap.close();
  }
}

/** Scale to fit the long edge. Never scales up — a small photo stays small. */
function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };

  const scale = maxEdge / longest;
  return {
    width: Math.round(width * scale),
    height: Math.round(height * scale),
  };
}
