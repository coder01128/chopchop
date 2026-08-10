import { useEffect, useRef, useState } from 'react';
import {
  IMAGE_ACCEPT_ATTRIBUTE,
  buildLibrary,
  getSupabaseClient,
  getSupabaseUrl,
  publicImageUrl,
  removeImage,
  validateImageFile,
  type LibraryImage,
} from '@chopchop/shared';
import { deleteProductImage, listProductImages, uploadProductImage } from './image-data';
import { resizeImage } from './resize-image';
import { describeCell, type Cell, type ProductShape } from './variant-model';
import styles from './ImageLibrary.module.css';

/**
 * The product's photographs.
 *
 * A library, not a per-variant upload field. Per-variant taken literally means
 * the seller shoots one white sneaker and uploads the same photograph for sizes
 * 7, 8 and 9, then again for black, and gives up on the second product. Upload
 * once; assign to as many variants as it applies to.
 *
 * Two things are written at different times, deliberately:
 *
 *   the object   immediately, on pick — it is in Storage the moment it uploads
 *   the pointers on Save, through save_product with everything else
 *
 * So a seller who uploads and then cancels leaves a file in the library and no
 * row pointing at it, which is harmless and visible. The reverse — a row
 * pointing at a file that was never uploaded — cannot happen.
 *
 * Nothing in this file knows what the client sells. The variant labels come
 * from the product's own attributes, the same as everywhere else.
 */
export function ImageLibrary({
  tenantId,
  itemId,
  primaryPath,
  onPrimaryChange,
  cells,
  shape,
  onAssign,
  disabled,
}: {
  tenantId: string;
  /** The saved id, or the one the modal minted for a product being created. */
  itemId: string;
  primaryPath: string;
  onPrimaryChange: (path: string) => void;
  cells: Cell[];
  shape: ProductShape;
  onAssign: (path: string, variantKeys: string[]) => void;
  disabled: boolean;
}) {
  const client = getSupabaseClient();
  const supabaseUrl = getSupabaseUrl();

  const [paths, setPaths] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState<number | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [openAssign, setOpenAssign] = useState<string | null>(null);

  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;

    async function load() {
      setLoading(true);
      try {
        const found = await listProductImages(client, tenantId, itemId);
        if (active) setPaths(found);
      } catch (error) {
        // A product being created has no folder yet, which is not a failure.
        if (active) setFailure(error instanceof Error ? error.message : String(error));
      } finally {
        if (active) setLoading(false);
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [client, tenantId, itemId]);

  // The library view is built in the model, so the dashboard and the storefront
  // agree about which photo belongs to what.
  const library: LibraryImage[] = buildLibrary(
    paths,
    tenantId,
    itemId,
    { imagePath: primaryPath || null, imageUrl: null },
    cells.map((cell) => ({ id: cell.key, imagePath: cell.imagePath })),
  );

  async function onPicked(file: File | undefined) {
    if (!file) return;
    setFailure(null);

    const verdict = validateImageFile({ name: file.name, type: file.type, size: file.size });
    if (!verdict.ok) {
      setFailure(verdict.message);
      return;
    }

    setProgress(0);
    try {
      // Resized before it goes anywhere near the network: a 4 MB phone shot
      // becomes about 300 KB, which is the difference between an upload that
      // finishes on a mobile connection and a seller giving up.
      const resized = await resizeImage(file);

      const { path } = await uploadProductImage({
        client,
        supabaseUrl,
        tenantId,
        itemId,
        blob: resized.blob,
        contentType: resized.contentType,
        onProgress: setProgress,
      });

      setPaths((current) => [...current, path]);
      // The first photo becomes the primary without being asked. A library with
      // no primary is a catalogue of blank tiles over a folder of photographs.
      if (!primaryPath) onPrimaryChange(path);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setProgress(null);
    }
  }

  async function onDelete(path: string) {
    setFailure(null);
    try {
      await deleteProductImage(client, tenantId, path);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
      return;
    }

    setPaths((current) => current.filter((entry) => entry !== path));

    // Clear every reference, in the model, so nothing is left pointing at an
    // object that is gone. Rendering falls back anyway — but a row pointing at
    // a 404 would survive until the next save, and this is that save's input.
    const cleared = removeImage(
      { imagePath: primaryPath || null, imageUrl: null },
      cells.map((cell) => ({ id: cell.key, imagePath: cell.imagePath })),
      path,
    );
    if (cleared.clearedPrimary) onPrimaryChange('');
    if (cleared.clearedVariantIds.length > 0) onAssign(path, []);
    if (openAssign === path) setOpenAssign(null);
  }

  const assignable = cells.filter((cell) => cell.variantId || cell.price.trim() !== '');

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <span className={styles.label}>Photos</span>
        {progress !== null && (
          <span className={styles.progressText} role="status">
            Uploading {Math.round(progress * 100)}%
          </span>
        )}
      </div>

      {progress !== null && (
        <div className={styles.progressTrack}>
          <div className={styles.progressBar} style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}

      <ul className={styles.grid}>
        {library.map((image) => (
          <li key={image.path} className={styles.tile} data-primary={image.isPrimary || undefined}>
            <img
              className={styles.thumb}
              src={publicImageUrl(supabaseUrl, image.path)}
              alt=""
              loading="lazy"
              onError={(event) => {
                const tile = event.currentTarget.closest('li');
                if (tile) tile.dataset.broken = 'true';
                event.currentTarget.remove();
              }}
            />

            <div className={styles.tileActions}>
              {image.isPrimary ? (
                <span className={styles.primaryFlag}>Main photo</span>
              ) : (
                <button
                  type="button"
                  className={styles.tileButton}
                  disabled={disabled}
                  onClick={() => onPrimaryChange(image.path)}
                >
                  Make main
                </button>
              )}

              {assignable.length > 1 && (
                <button
                  type="button"
                  className={styles.tileButton}
                  aria-expanded={openAssign === image.path}
                  onClick={() => setOpenAssign(openAssign === image.path ? null : image.path)}
                >
                  {image.variantIds.length > 0 ? `Used by ${image.variantIds.length}` : 'Use for…'}
                </button>
              )}

              <button
                type="button"
                className={styles.tileButton}
                data-tone="danger"
                disabled={disabled}
                onClick={() => void onDelete(image.path)}
              >
                Delete
              </button>
            </div>

            {/* Collapsed until asked for. A business with one variant per
                product must never meet an assignment grid it will never use. */}
            {openAssign === image.path && (
              <fieldset className={styles.assign}>
                <legend>Which variants use this photo</legend>
                {assignable.map((cell) => (
                  <label key={cell.key} className={styles.assignRow}>
                    <input
                      type="checkbox"
                      checked={cell.imagePath === image.path}
                      onChange={(event) => {
                        const next = assignable
                          .filter((entry) =>
                            entry.key === cell.key
                              ? event.target.checked
                              : entry.imagePath === image.path,
                          )
                          .map((entry) => entry.key);
                        onAssign(image.path, next);
                      }}
                    />
                    <span>{describeCell(cell, shape) || 'This product'}</span>
                  </label>
                ))}
              </fieldset>
            )}
          </li>
        ))}

        <li className={styles.addTile}>
          {/* Two controls on a phone, one on a desktop. A bare file input opens
              the Files picker, which reaches Drive, Dropbox and anything saved
              out of a WhatsApp chat — but a seller photographing stock in their
              shop wants the camera, and `capture` is what opens it directly.
              The camera control is hidden above the phone breakpoint, where it
              would open a webcam nobody is pointing at anything. */}
          <button
            type="button"
            className={styles.cameraButton}
            disabled={disabled || progress !== null}
            onClick={() => cameraInput.current?.click()}
          >
            Take photo
          </button>
          <button
            type="button"
            className={styles.addButton}
            disabled={disabled || progress !== null}
            onClick={() => fileInput.current?.click()}
          >
            {progress !== null ? 'Uploading…' : 'Add photo'}
          </button>

          <input
            ref={cameraInput}
            className={styles.hiddenInput}
            type="file"
            accept={IMAGE_ACCEPT_ATTRIBUTE}
            capture="environment"
            onChange={(event) => {
              void onPicked(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
          <input
            ref={fileInput}
            className={styles.hiddenInput}
            type="file"
            accept={IMAGE_ACCEPT_ATTRIBUTE}
            onChange={(event) => {
              void onPicked(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
        </li>
      </ul>

      {loading && <p className={styles.note}>Loading photos…</p>}
      {!loading && library.length === 0 && progress === null && (
        <p className={styles.note}>No photos yet. Add one and it becomes the main photo.</p>
      )}
      {failure && (
        <p className={styles.failure} role="alert">
          {failure}
        </p>
      )}
    </div>
  );
}
