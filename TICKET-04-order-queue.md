# TICKET 04 — Order queue and status flow

Dashboard only. The storefront, cart and wa.me handoff are ticket 05; the buyer
status page is ticket 05. Nothing in this ticket writes an order from a buyer's
side.

Depends on: 01, 01B, 02, 03, 03B — all committed and pushed.

---

## Read before writing anything

`SCHEMA.md` is the contract. Three things in this ticket depend on what is
already there, and this spec deliberately does not assert them:

1. **The `order_status` enum.** The flow is `sent → received → confirmed →
   ready → completed`. A dismissed phantom order needs a terminal value that is
   not `completed`, because metrics run off `completed` only and a dismissed
   order must never touch revenue. Check what the enum actually contains. If
   there is no such value, that is a migration — **stop and flag it before
   writing any UI**, the same way ticket 03B flagged `retired_at`.

2. **`order_items.qty_confirmed`.** The column exists. This ticket assumes it
   holds the actual quantity the seller confirms, which for a `sale_mode =
   weight` tenant differs from what the buyer ordered — 1kg requested, 1.15kg
   cut. If `SCHEMA.md` says otherwise, stop and say so rather than building
   against a guess.

3. **`line_total`.** Whether it is stored or generated decides whether
   confirming a weight order writes it or lets the database do it. Check, don't
   assume.

---

## §1 — Seed orders

There is no code path that creates an order until ticket 05, so the queue has
nothing to render. Write `scripts/seed-orders.mjs` first.

It must produce, across **both** demo tenants:

- at least one order in every status the enum defines
- one `sent` order with `created_at` backdated more than 24 hours, so the
  staleness flag in §3 is visible without waiting a day
- one `sent` order created minutes ago, so the un-flagged case is visible beside it
- multi-line orders, not just single-line ones
- for the weight tenant, an order whose lines are the kind that get adjusted at
  confirmation; for the unit tenant, one that is not

Orders must be created with `name_snapshot`, `price_snapshot` and `line_total`
populated as a real checkout would populate them — `name_snapshot` carries the
full variant label the buyer chose (`Rump Steak — per kg`, not `Rump Steak`).
Ticket 05 inherits this rule; the seed is where it starts being true.

The script must be reversible. Ticket 03B left the seed in its exact original
state and that standard holds: a matching teardown, or a marker on seeded rows
that the teardown selects on.

## §2 — The queue screen

A new route in `apps/dashboard`. Orders for the resolved tenant only.

- Grouped by status, with the statuses that need action first. A seller opening
  this on a phone must see what is waiting on them without scrolling.
- Bottom tabs under 48rem, left rail above — the existing app shell, not a new one.
- Each row: reference, buyer-visible name if the schema carries one, line count,
  total, age. Tapping opens the order.
- The order detail shows every line from `order_items` — `name_snapshot`,
  `price_snapshot`, `qty`, `line_total`. **Never join `variants` to render an
  order line.** A variant retired since the order was placed is filtered out by
  the buyer and anon policies, and the snapshot columns exist precisely so
  history does not depend on a mutable product row.
- Live updates via Realtime, subscribed to `orders` for this tenant. No polling.
  01B tested Realtime end to end; use that mechanism.

## §3 — Status transitions

Forward-only along `sent → received → confirmed → ready → completed`, plus
`sent → dismissed` from §4. No backward moves in v1 — correcting a mis-tap is
out of scope and goes on the open-questions list, it does not get invented here.

**`received` is an acknowledgement, `confirmed` is a promise.** They stay
separate. Do not collapse them, do not offer a control that performs both.

**Confirmation on a weight tenant** is where `qty_confirmed` is entered — the
seller cuts, weighs, enters the actual quantity, and the line total follows. On
a `unit` tenant no quantity-adjustment control appears at all, and no weight
language appears anywhere on the screen. This is the same white-label gate as
the variant editor: a shoe seller seeing a weight field is the product failing.
Verify in both directions before calling this done.

**The 24-hour staleness flag.** A `sent` order older than 24 hours is flagged in
the queue as one to check against WhatsApp. Computed from `created_at` at render
time — no stored column, no cron, no background job. The window is a single
named constant, not a literal repeated across files.

Nothing auto-cancels. Ever. Age is a prompt to look, not a verdict.

## §4 — Dismissal

A flagged `sent` order can be dismissed by the seller, and only by the seller.

- The confirmation dialog names the order reference and its age.
- It states plainly that this is for orders that never arrived on WhatsApp, and
  that dismissing does not notify the buyer.
- Dismissal releases the variants that order was holding — a dismissed order
  must no longer block a variant removal in the ticket 03B classifier. Check the
  classifier's query and update the status set it treats as blocking.

## §5 — Model and tests

Follow the `variant-model.ts` pattern: an `order-model.ts` of pure functions, so
the rules are checkable without a browser.

- allowed transitions from each status, and refusal of every other pair
- staleness: a boundary case either side of the window, using an injected clock,
  never `Date.now()` inside the function
- which statuses block variant removal, asserted against the 03B classifier
- confirmation arithmetic — `qty_confirmed` producing the right `line_total` on
  a weight tenant, and being absent on a unit tenant

Extend the leak test to `orders` and `order_items`: tenant A must not read,
update or transition tenant B's orders, and an anonymous buyer must not read an
order that is not theirs. The leak test is the release gate — Brad runs it and
reads the output.

---

## Out of scope

Metrics · editing an order's lines · adding a line after checkout · notifications
or push · auto-cancel · buyer-facing status page · deep links from the removal
dialog into the queue · order search or date filtering.

## Done means

- `npm test` green, existing 85 still passing
- typecheck and build clean
- seed script runs and reverses cleanly
- verified in a browser on both demo tenants, at phone width and desktop width,
  including the flagged order, a dismissal, and a confirmation on the weight
  tenant with no weight language on the unit tenant
- nothing committed until Brad has run the leak test himself
