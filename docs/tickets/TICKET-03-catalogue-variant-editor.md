# TICKET 03 — Catalogue and the generated variant editor

Project: **ChopChop** · follows ticket 02 · dashboard only, no orders, no import

The screen the white-label claim rests on. A butchery and a shoe shop must get
completely different product forms out of the same component, with no branch in
the code for either.

Wireframe: `chopchop-variant-editor-wireframe.html` — read it before starting.
Section numbers below refer to it.

## Before starting (Brad does this)

- [ ] Ticket 02 committed and pushed
- [ ] Dashboard nav labels no longer routed through `tenant.label()` — that
      override is storefront-only per `CLAUDE.md`
- [ ] `retry: 2` confirmed as scoped to the single Realtime test case, not global

---

## The prompt

> Read `CLAUDE.md`, `SCHEMA.md` and `chopchop-variant-editor-wireframe.html`
> first. Build the dashboard catalogue: categories, item list, and the product
> modal with its generated variant editor. **No order UI, no import, no
> storefront work.**
>
> This is the longest ticket so far. If something is ambiguous, stop and flag it
> rather than guessing — a wrong abstraction here is expensive to unpick.
>
> ### 1. Categories
>
> Sidebar list of the tenant's categories with add, rename, reorder and
> deactivate. `items.category_id` is `on delete set null`, so deleting a category
> orphans its items rather than destroying them — surface that in the confirm
> dialog with the count of affected items.
>
> ### 2. Item list
>
> Card grid per wireframe section 03 of the dashboard wireframe: name, variant
> count, price range, active toggle. Cards must render legibly with
> `image_url` null — a neutral block, never a broken image. Empty state for a
> tenant with no items yet. Filter by category, search by name.
>
> ### 3. Product modal — universal half
>
> Name, description, category, image, active. Identical for every tenant, no
> branching. Image optional and it stays optional.
>
> ### 4. The variant editor — the core of this ticket
>
> **`attribute_schema` is a palette, not a mandate.** Read the Buyer identity and
> attribute_schema sections of `SCHEMA.md` before writing a line of this. Which
> attributes a product uses is derived from the keys on that product's own
> variants — not from the tenant row. A product created before a tenant gained a
> new attribute keeps its own shape and stays valid forever.
>
> For a **new** product, the seller picks which of the tenant's available
> attributes this product uses, then ticks which values apply. For an
> **existing** product, the editor derives the shape from its variants.
>
> Render per the wireframe:
> - **Zero attributes** (section 01) — one unlabelled row: price, stock, sku. The
>   seller should not be able to tell a variant system exists.
> - **One attribute** (section 02) — a row per ticked value. A row can be marked
>   "not sold", which writes no variant row at all — not a zero-priced one.
> - **Two attributes** (section 03) — the seller ticks applicable values *first*,
>   then the grid generates from the cross product. Do not generate all
>   combinations and ask them to delete.
> - **Bulk fill** — "set price for all" and "set stock for all". Not optional;
>   nine cells typed by hand is how sellers abandon the screen.
>
> ### 5. Adding a value to an existing product (section 04)
>
> New variants appear alongside existing ones. Existing prices, stock and SKUs
> are untouched. New cells render visibly empty and flagged as new, and the
> product will not save until each has a price. **Never write a variant with a
> null or inherited price** — the storefront would render it.
>
> ### 6. Removing a value (section 05)
>
> `order_items.variant_id` is `on delete restrict`. A variant that appears in any
> order cannot be deleted and Postgres will throw if you try. Check before
> offering the control:
> - never ordered → delete allowed
> - has order history → offer deactivate instead, explain why
> - open orders reference it → blocked, with the reason named
>
> The seller must never see a raw Postgres error from this path.
>
> ### 7. Row rendering by mode (section 06)
>
> The only place beyond the attribute list that branches on tenant config:
> - `sale_mode: unit` → whole-number quantities
> - `sale_mode: weight` → decimal, price labelled per unit
> - `stock_mode: counted` → stock number field
> - `stock_mode: availability` → in-stock toggle, **no stock number at all**
>
> An availability tenant must not see a number they believe is being tracked.
>
> ### 8. Mobile (section 07)
>
> Below the breakpoint the grid becomes a stacked card list, one card per
> variant, attribute values as the heading. Same component, same data, same
> bulk-fill controls pinned above the stack. Bulk fill matters more here, not
> less.
>
> ### 9. Validation (section 08)
>
> Postgres does not police the jsonb column, so this is the only thing preventing
> `navy` and `Navy` becoming separate variants forever.
> - every attribute value validated against the tenant's declared list
> - every enabled variant must carry a price
> - duplicate attribute combinations blocked
> - errors name the offending cell — "size 9 · red needs a price", never "please
>   check your input"
>
> ### 10. Verify against both demo tenants
>
> Drive it in a browser, do not reason about it. `demo-butchery` must produce two
> priced rows on an item; `demo-shoes` must produce a nine-cell grid. Add a value
> to an existing shoe product and confirm existing cells keep their prices.
> Attempt to delete a variant that appears in a seeded order and confirm you get
> the deactivate path, not an error.
>
> Styling is CSS Modules plus CSS custom properties, per `CLAUDE.md`. No
> framework, no component library. No colour or tenant name as a literal.
>
> Do not print keys. Do not use the SQL editor. Do not run any Vercel CLI
> command. Do not add a migration — if you believe one is needed, stop and say
> why.
>
> When finished, list what you built and flag anything ambiguous rather than
> resolving it silently.

---

## Deliberately not decided — do not let CC resolve these silently

- **SKU generation** — hand-typed, auto-generated from attributes, or blank.
  Default to a plain optional text field.
- **Bulk-fill scope** — overwrite filled cells, or fill empty ones only. Default
  to filling empty only, with an explicit "overwrite all" if it's cheap.
- **Per-variant images** — out of scope. `image_url` is on `items`, and moving it
  is a migration.

---

## When you come back

Open the modal as each demo seller. If the butchery seller sees anything
resembling a size or colour control, or the shoe seller sees anything about
weight, the abstraction has leaked and that is the whole ticket failing.

Then add a value to an existing product and check the existing prices survived.
That is the case most likely to be quietly wrong.
