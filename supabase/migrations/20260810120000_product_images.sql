-- ===========================================================================
-- Ticket 07 — product images
--
-- Adds image_path to items and variants, creates the product-images bucket,
-- and gates writes to it on the same helper the table policies use.
--
-- Two columns, not one, and neither replaces image_url:
--
--   items.image_path     the product's primary photo
--   variants.image_path  the photo for this variant, when it has its own
--   items.image_url      legacy. Seed data. Read-only from here on.
--
-- Resolution order, implemented once in image-model.ts and used by both apps:
--   variant.image_path -> item.image_path -> item.image_url -> empty
--
-- image_url is not migrated and not dropped. It holds root-relative paths to
-- SVGs committed under apps/storefront/public/products/ and
-- apps/dashboard/public/products/ — both copies load-bearing, because a
-- relative path resolves against whichever app is serving. Leaving the column
-- as the last stop before the empty state is what keeps the seeded catalogue
-- rendering without touching a single row.
--
-- There is no images table. A product's library is the set of objects under
-- <tenant_id>/<item_id>/ in the bucket. Nothing tracks them separately, so an
-- object and a row cannot disagree about what exists. The cost is that
-- "which variants use this photo" is answered by variants.image_path itself,
-- which is the direction that lets one upload cover three sizes.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------

alter table public.items
  add column if not exists image_path text;

comment on column public.items.image_path is
  'Storage object path of the product primary image: <tenant_id>/<item_id>/<uuid>.<ext>. Not a URL — the public URL is derived at render time so a project ref change does not invalidate every row. Uploads write this; image_url is legacy and is never written again.';

comment on column public.items.image_url is
  'LEGACY, read-only. Root-relative paths to the seeded SVGs (/products/rump.svg), written before Storage existed. Last stop before the empty state in image-model resolution. Nothing writes this column any more.';

alter table public.variants
  add column if not exists image_path text;

comment on column public.variants.image_path is
  'Storage object path of the photo assigned to this variant, or null to use the product primary. Several variants may carry the SAME path deliberately — one photograph of a white sneaker covers sizes 7, 8 and 9. Storage holds one object; three rows point at it.';

-- ---------------------------------------------------------------------------
-- 2. The bucket
--
-- Public read. Catalogue rows are already anon-readable by policy, so the
-- photographs of them carry no secret. Signed URLs would expire, which defeats
-- CDN and PWA caching and adds a signing round-trip per tile on a South
-- African mobile connection; object names are uuids, so there is nothing to
-- enumerate. Public here means unauthenticated GET and nothing else — every
-- write still falls to the policies below.
--
-- The size cap is 5 MB. The client resizes before upload and a resized
-- catalogue photo lands well under 500 KB, so the cap is not the working
-- limit — it is the backstop for a client that fails or is bypassed, set above
-- a modern phone's 3-6 MB raw shot so the browser-side path is what reports the
-- friendly error, not a 413 from Storage.
--
-- allowed_mime_types is the server-side half of the type check. image-model.ts
-- checks extension and content type before upload; this refuses anything that
-- gets past it.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'product-images',
  'product-images',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public            = excluded.public,
      file_size_limit   = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- 3. Bucket policies
--
-- Tenant ownership is the first path segment, and it is resolved with
-- public.user_tenant_ids() — the same SECURITY DEFINER helper every table
-- policy uses. A separate mapping of folders to sellers would be a second
-- source of truth, and the two would drift.
--
-- The comparison is on text, not uuid. `(storage.foldername(name))[1]::uuid`
-- raises 22P02 invalid input syntax on any path whose first segment is not a
-- uuid, which surfaces a raw Postgres error instead of a denial. Comparing
-- user_tenant_ids() cast to text denies the same paths quietly.
--
-- storage.foldername('a/b/c.jpg') returns {a,b} — the object name minus the
-- final segment — so [1] is the tenant folder.
-- ---------------------------------------------------------------------------

drop policy if exists product_images_public_read on storage.objects;
drop policy if exists product_images_seller_insert on storage.objects;
drop policy if exists product_images_seller_update on storage.objects;
drop policy if exists product_images_seller_delete on storage.objects;
drop policy if exists product_images_not_anonymous_insert on storage.objects;
drop policy if exists product_images_not_anonymous_update on storage.objects;
drop policy if exists product_images_not_anonymous_delete on storage.objects;

-- Read: the catalogue is public information and so are its photographs. Scoped
-- to this bucket, so a later private bucket does not inherit it.
create policy product_images_public_read on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'product-images');

-- Write: own prefix only.
create policy product_images_seller_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'product-images'
    and (storage.foldername(name))[1] in (
      select public.user_tenant_ids()::text
    )
  );

-- Update covers overwrite and rename. Both sides checked: a seller may not
-- move an object out of their own prefix, and may not move one in.
create policy product_images_seller_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'product-images'
    and (storage.foldername(name))[1] in (
      select public.user_tenant_ids()::text
    )
  )
  with check (
    bucket_id = 'product-images'
    and (storage.foldername(name))[1] in (
      select public.user_tenant_ids()::text
    )
  );

create policy product_images_seller_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'product-images'
    and (storage.foldername(name))[1] in (
      select public.user_tenant_ids()::text
    )
  );

-- Belt and braces, the same pairing every dashboard table carries. A buyer
-- signed in with signInAnonymously() holds the `authenticated` role, and
-- permissive policies combine with OR. user_tenant_ids() returns nothing for a
-- buyer, so the write policies above already refuse them — this restrictive
-- policy means that stays true even if a permissive write policy is ever added
-- to this bucket without thinking it through.
--
-- Written per write command rather than FOR ALL, so SELECT is untouched: a
-- buyer who has checked out arrives as an anonymous authenticated user on every
-- later visit, and must still see product photographs.
create policy product_images_not_anonymous_insert on storage.objects
  as restrictive
  for insert to authenticated
  with check (
    bucket_id <> 'product-images'
    or not public.is_anonymous_user()
  );

create policy product_images_not_anonymous_update on storage.objects
  as restrictive
  for update to authenticated
  using (
    bucket_id <> 'product-images'
    or not public.is_anonymous_user()
  )
  with check (
    bucket_id <> 'product-images'
    or not public.is_anonymous_user()
  );

create policy product_images_not_anonymous_delete on storage.objects
  as restrictive
  for delete to authenticated
  using (
    bucket_id <> 'product-images'
    or not public.is_anonymous_user()
  );
