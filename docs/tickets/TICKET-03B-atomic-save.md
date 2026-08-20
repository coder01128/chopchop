# TICKET 03B — Atomic save, retired variants, removal clarity

Project: **ChopChop** · follows ticket 03 · small, three changes

Ticket 03 landed with three loose ends. Two are correctness, one is a seller
being told something the interface then contradicts. Worth closing before the
order queue lands in ticket 04.

## Before starting (Brad does this)

- [ ] Ticket 03 committed and pushed

---

## The prompt

> Read `CLAUDE.md` and `SCHEMA.md` first. Three changes to the catalogue, all
> small. No order UI, no import, no storefront work.
>
> ### 1. Atomic save — this one needs a migration
>
> Saving a product currently writes the item, then the variants, then the
> removals, as separate PostgREST calls. A failure halfway leaves a product
> partly saved — an item with some of its variants written, or removals applied
> without the writes that were meant to accompany them. On the screen sellers
> use most, that is quiet corruption nobody notices until a price is wrong on
> the storefront.
>
> Add a migration creating an RPC — `save_product` or similar — that wraps the
> item write, the variant inserts and updates, and the removals in a single
> transaction. It either all happens or none of it does.
>
> Requirements:
> - `SECURITY INVOKER`, so RLS still applies and the caller's tenant scope is
>   enforced exactly as it is today. Do **not** use `SECURITY DEFINER` here and
>   do not let it become a way around the policies.
> - Reject any payload whose `tenant_id` doesn't match the caller's tenant,
>   explicitly, rather than relying on RLS alone to filter silently.
> - Return the saved item with its variants, so the modal can reconcile without
>   a second round trip.
> - `catalogue-data.ts` calls the RPC instead of the current write sequence.
> - The removal-safety classifier stays where it is — the RPC executes decisions,
>   it does not make them.
>
> ### 2. Retired variants get their own block
>
> Today a deactivate-only removal sets `available = false`, the value stays on
> the product, and it reappears **ticked** next time the modal opens. The seller
> unticked it, was told it would be kept and marked unavailable, and then finds
> it ticked again. That reads as the app ignoring them.
>
> Move retired variants out of the ticked value list into a separate **Retired**
> block below the grid. Each entry shows its attribute values, why it was kept
> (appears in past orders), and a **Restore** action that ticks it back into the
> live grid.
>
> Unticked must mean unticked in the interface. The row still exists in the
> database — that is the point — but it is no longer presented as an active
> choice the seller has made.
>
> ### 3. The removal dialog names the blocking orders
>
> When a removal is blocked because a variant appears in open orders, the dialog
> currently says so without saying which. Show them: order `reference`, status,
> and age, so the seller knows what to go and deal with.
>
> A `sent` order is the common case — a buyer who tapped through to WhatsApp and
> never pressed send now holds a variant hostage. Do not auto-cancel it: that
> risks destroying a real order the seller hasn't reached yet. Naming it is
> enough for this ticket; the order queue gains a stale-order dismiss in ticket
> 04.
>
> Do not deep-link to an order screen — it does not exist yet. Reference, status
> and age as text.
>
> ### 4. Tests
>
> - The RPC rolls back cleanly on a mid-save failure: force one, assert the
>   product is unchanged, not partly written.
> - The RPC refuses a payload carrying another tenant's `tenant_id`.
> - A retired variant does not appear as a ticked value on reopen, and Restore
>   returns it to the grid.
> - Existing variant-model tests and the leak test still pass.
>
> Styling is CSS Modules plus CSS custom properties. No colour or tenant name as
> a literal.
>
> Do not print keys. Do not use the SQL editor — the migration goes through
> `supabase db push`. Do not run any Vercel CLI command.
>
> When finished, list what changed and flag anything ambiguous rather than
> resolving it silently.

---

## When you come back

Save a product and confirm nothing about the normal path changed — the RPC
should be invisible when it works.

Then untick a variant that appears in a past order, save, and reopen. It must
appear under Retired, not ticked in the grid. That is the specific behaviour
this ticket exists to fix.

---

## Carried into ticket 04

The order queue needs a stale-order rule: `sent` orders past a staleness window
flagged with a one-tap dismiss. Flagged, never automatic. That closes the
phantom-order window question and unblocks variants held hostage by orders that
were never really placed.
