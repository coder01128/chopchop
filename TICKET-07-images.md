# TICKET 07 — Product images

Dashboard-only. The seller uploads their own photos and assigns them to
products and variants. The storefront renders them.

This is the last thing standing between the build and a client handover. A
catalogue of grey NO PHOTO tiles is not sellable.

Read `CLAUDE.md` and `SCHEMA.md` first. This ticket does not restate the schema;
where it needs a column it says so as a pre-check, not as an assumption.

---

## Pre-checks — run these and report before writing any code

Do not assume any of the following. Read them, state what you found, and stop if
anything contradicts this ticket.

1. **Does `variants` have an image column?** If not, this ticket adds one and
   `SCHEMA.md` is updated first.
2. **What `items.image_url` currently holds** across both demo tenants, now that
   the seed points at committed SVGs under `apps/storefront/public/products/`.
   Report the exact form of the values — relative paths, absolute, or a mix.
3. **Does the project have any Storage bucket?** Report its name, public/private
   setting and policies. If there is none, this ticket creates the first one.
4. **What the storefront currently does when an image is missing or fails to
   load.** Report the actual fallback, not the intended one.
5. **Whether the seeded SVGs are still needed** once uploads exist, or whether
   they become dead weight in the repo. Report; do not delete anything.

---

## Why per-variant, and why a library

Per-variant is required — a shoe in white and a shoe in black are different
photographs, and the storefront should change picture when the buyer picks a
colour.

But images vary by *some* attributes, not all. A canvas sneaker in white comes in
sizes 7, 8 and 9: three variants, one photograph. A per-variant upload control
taken literally means the seller shoots one shoe and uploads it three times, then
again for black, and gives up on the second product.

So the model is **an image library per product**. Upload once, assign to as many
variants as it applies to. Storage holds one file; three variant rows point at
it.

---

## Scope

### 1. Storage

One private bucket. Objects are addressed by a **tenant-scoped path**:

```
<tenant_id>/<item_id>/<uuid>.<ext>
```

Bucket policies must enforce that a seller can read, write and delete only under
their own tenant's prefix, derived from `user_tenant_ids()` — the same helper the
table policies use, not a second source of truth. A seller writing into another
tenant's folder is the same class of failure as a cross-tenant row read, and it
gets the same treatment in the leak test.

Buyers do not authenticate as sellers, so storefront reads go through signed URLs
or a public read policy scoped to the bucket — pick one, state which and why in
the report, and do not make the bucket world-writable under any circumstance.

Accept `image/jpeg`, `image/png`, `image/webp`. Reject anything else by
extension and by content type. Cap file size; state the cap you chose and the
reason.

### 2. Upload control

On the product edit modal, replacing the bare IMAGE URL field.

- A tile grid of the images already uploaded for this product, plus an empty
  **Add photo** tile.
- Add photo opens the device picker. On mobile the same control must offer the
  camera — a seller photographing stock in their shop is the expected case, not
  an edge case.
- Show upload progress. A phone on a South African mobile connection uploading a
  4 MB photo is not instant, and a control that looks frozen gets tapped again.
- Resize client-side before upload. A modern phone camera produces 3–6 MB per
  shot; a catalogue tile does not need it. State the dimensions and quality you
  chose.
- Delete removes the object and clears every reference to it. A variant pointing
  at a deleted object must fall back, never render broken.

The existing IMAGE URL text field stays, unlabelled as legacy — it is how the
seeded SVG paths still work, and removing it would strand them. Do not migrate
the seed data in this ticket.

### 3. Assignment

- One image on the product is the **primary**. It is what the catalogue grid and
  the product tile show.
- Any image in the library can be assigned to any number of variants. The
  control is per-image — "which variants use this photo" — not per-variant,
  because that is the direction that makes one upload cover three sizes.
- Assignment is optional. A tenant that does not care sets a primary and never
  opens the control.
- The control stays collapsed until the seller opens it. The butchery must not
  meet a variant-assignment grid it will never use.

### 4. Storefront

- The product tile shows the primary.
- The product sheet shows the primary until the buyer selects a variant. When
  the selected variant has an assigned image, the sheet shows that image.
- When it does not, the sheet falls back to the primary. A missing image never
  renders a broken tile.
- Order snapshots are unaffected. `order_items` carries no image and gains none —
  a photo changing later must not alter what a buyer sees on a past order, and
  the cheapest way to guarantee that is to keep images out of the snapshot
  entirely.

---

## Out of scope

- Image editing, cropping, rotation
- Bulk upload of many photos at once
- Images carried by the spreadsheet import
- Migrating the seeded SVGs to Storage
- Alt text and image SEO — worth doing, not now
- Self-serve anything

---

## Code shape

Follow the existing pattern: rules as pure functions in a model file, screens
holding no logic.

- `image-model.ts` — path construction, type and size validation, primary and
  fallback resolution, assignment rules
- `image-data.ts` — the Storage calls
- Upload control lives with the product modal; the storefront resolves its image
  through the same model functions the dashboard uses, so the two cannot
  disagree about which photo a variant shows

---

## Tests

Extend the existing suite; do not start a new pattern.

`image-model` unit tests, at minimum:

- a tenant-scoped path is built from tenant and item, and a foreign tenant id
  never appears in a path
- rejected file types and oversized files are refused with a named reason
- a variant with an assigned image resolves to it
- a variant with no assigned image resolves to the product primary
- a product with no images at all resolves to the documented empty state, not
  undefined
- an image assigned to three variants resolves for all three
- deleting an image clears its assignments and the affected variants fall back

Leak test additions:

- a seller cannot write an object under another tenant's prefix
- a seller cannot read another tenant's objects
- a seller cannot delete another tenant's objects
- `anon` cannot write to the bucket at all
- a buyer session cannot write to the bucket at all

Report the new total against the current 216 and confirm `skipped 0`.

---

## Definition of done

- A photo taken on a phone reaches a product tile without leaving the dashboard
- One upload can be assigned to several variants
- The storefront changes picture when a buyer selects a variant that has one
- Nothing renders broken when an image is missing or deleted
- Both demo tenants still render correctly with their existing seeded SVGs
- Tests pass, typecheck clean, both apps build clean
- Nothing committed until Brad has run the leak test himself and read the output
  with `--reporter=verbose`
