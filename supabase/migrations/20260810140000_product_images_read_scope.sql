-- ===========================================================================
-- Ticket 07 — narrow the read policy on product-images
--
-- 20260810120000 created the bucket with:
--
--   create policy product_images_public_read on storage.objects
--     for select to anon, authenticated
--     using (bucket_id = 'product-images');
--
-- That was wrong, and this replaces it.
--
-- The intent was "anyone with the URL may fetch the photograph", which is what
-- a public bucket already does: Supabase serves /object/public/<bucket>/<path>
-- without consulting RLS. The bucket's `public` flag is what makes storefront
-- images work, not that policy.
--
-- What the policy actually did was grant SELECT on the storage.objects ROWS —
-- and rows are what `list()` reads. Any holder of the publishable key could
-- enumerate every tenant's objects: names, sizes, timestamps, one call per
-- prefix. Photographs are not secret, but a full inventory of another client's
-- catalogue is not the same thing as one photograph, and the difference is the
-- whole reason this project is one shared database.
--
-- The replacement scopes SELECT the same way writes are scoped: a seller sees
-- their own tenant's prefix, and nothing else. Consequences, on purpose:
--
--   storefront images         unaffected — public URL path, no RLS involved
--   a seller listing their library   works, own prefix only
--   a seller listing another tenant  returns empty, which is what the leak
--                                    test asserts against service-key truth
--   anon and buyer sessions          cannot list or enumerate anything
--
-- A buyer can still fetch any object whose exact path they hold, because the
-- bucket is public. That is the deliberate trade recorded in SCHEMA.md: object
-- names are uuids, so a path is not guessable, and the alternative — signed
-- URLs — costs CDN and PWA caching plus a signing round-trip per tile.
-- ===========================================================================

drop policy if exists product_images_public_read on storage.objects;

create policy product_images_seller_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'product-images'
    and (storage.foldername(name))[1] in (
      select public.user_tenant_ids()::text
    )
  );

-- Belt and braces, matching the write side: an anonymous auth user holds the
-- `authenticated` role, and permissive policies combine with OR. A buyer has no
-- tenant_users rows, so the policy above already returns nothing for them —
-- this keeps that true if a permissive read policy is ever added here without
-- thinking it through.
drop policy if exists product_images_not_anonymous_select on storage.objects;

create policy product_images_not_anonymous_select on storage.objects
  as restrictive
  for select to authenticated
  using (
    bucket_id <> 'product-images'
    or not public.is_anonymous_user()
  );
