import {
  IMAGE_BUCKET,
  buildImagePath,
  imagePrefix,
  pathBelongsToTenant,
  type ChopChopClient,
} from '@chopchop/shared';

/**
 * The Storage calls, and nothing else.
 *
 * Every rule about what a path may be, what a file may be and which photo a
 * variant shows lives in `image-model.ts` in `shared`, where both apps read it
 * and a test can reach it without a network. This file is the seam where those
 * decisions meet Supabase.
 *
 * The bucket is the source of truth for what exists. There is no images table,
 * so listing a product's library is a `list()` on its prefix — an object and a
 * row can never disagree about whether a photograph is there.
 */

/** Newest last, matching the order the tiles are laid out in. */
export async function listProductImages(
  client: ChopChopClient,
  tenantId: string,
  itemId: string,
): Promise<string[]> {
  const prefix = imagePrefix(tenantId, itemId);

  const { data, error } = await client.storage.from(IMAGE_BUCKET).list(prefix, {
    limit: 100,
    sortBy: { column: 'created_at', order: 'asc' },
  });

  // A denied read comes back as an empty list rather than an error — Storage
  // does not distinguish "not yours" from "not there". That is fine here
  // (a seller listing their own prefix) but it is why the leak test asserts
  // against service-key truth rather than against an error.
  if (error) throw new Error(`Could not load photos: ${error.message}`);

  return (data ?? [])
    // `list` returns a placeholder row for the folder itself on some paths.
    .filter((object) => object.id !== null)
    .map((object) => `${prefix}/${object.name}`);
}

export interface UploadResult {
  path: string;
}

/**
 * Upload one already-resized image, reporting progress.
 *
 * Sent with XMLHttpRequest rather than `storage.upload()` deliberately: the
 * supabase-js client is built on fetch, which cannot report upload progress. A
 * seller on a South African mobile connection watching a control that looks
 * frozen taps it again, and the second tap is a second object. The request goes
 * to the same Storage endpoint with the same session token, so the same bucket
 * policies apply — nothing here is a way around them.
 */
export async function uploadProductImage(options: {
  client: ChopChopClient;
  supabaseUrl: string;
  tenantId: string;
  itemId: string;
  blob: Blob;
  contentType: string;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}): Promise<UploadResult> {
  const { client, supabaseUrl, tenantId, itemId, blob, contentType, onProgress, signal } = options;

  const path = buildImagePath(tenantId, itemId, crypto.randomUUID(), contentType);

  const { data: session } = await client.auth.getSession();
  const token = session.session?.access_token;
  if (!token) throw new Error('Your session has expired. Sign in again to upload photos.');

  const endpoint = `${supabaseUrl.replace(/\/+$/, '')}/storage/v1/object/${IMAGE_BUCKET}/${path}`;

  await new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', endpoint, true);
    request.setRequestHeader('Authorization', `Bearer ${token}`);
    request.setRequestHeader('Content-Type', contentType);
    // Objects are addressed by a fresh uuid every time, so an overwrite is
    // never intended; a collision means something is wrong and should say so.
    request.setRequestHeader('x-upsert', 'false');

    request.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total);
    };

    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        onProgress?.(1);
        resolve();
        return;
      }
      // Storage answers a policy refusal with 400 and a body naming it. The
      // seller does not need the body; the console does.
      console.error('Storage upload failed', request.status, request.responseText);
      reject(
        new Error(
          request.status === 413
            ? 'That photo is too large.'
            : 'That photo could not be uploaded. Try again.',
        ),
      );
    };

    request.onerror = () => reject(new Error('The connection dropped while uploading.'));
    request.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));

    signal?.addEventListener('abort', () => request.abort(), { once: true });

    request.send(blob);
  });

  return { path };
}

/**
 * Delete an object.
 *
 * The tenant check is a client-side guard on top of the bucket policy, not
 * instead of it: Storage answers a denied delete with an empty result and no
 * error, so a path from outside the tenant would otherwise look like it
 * succeeded and the UI would remove a tile that is still there.
 */
export async function deleteProductImage(
  client: ChopChopClient,
  tenantId: string,
  path: string,
): Promise<void> {
  if (!pathBelongsToTenant(path, tenantId)) {
    throw new Error('That photo does not belong to this business.');
  }

  const { data, error } = await client.storage.from(IMAGE_BUCKET).remove([path]);
  if (error) throw new Error(`Could not delete the photo: ${error.message}`);

  if (!data || data.length === 0) {
    throw new Error('That photo could not be deleted.');
  }
}
