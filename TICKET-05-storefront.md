# TICKET 05 — Storefront, cart, wa.me handoff, buyer status page

The first buyer-facing code in the project. Everything before this was the
seller's side; this is the half a client's customers actually touch, on a phone,
usually from a WhatsApp group link.

Depends on: 02 (slug resolution), 03/03B (catalogue and variants), 04/04B (the
queue this feeds), all committed and pushed.

---

## Read before writing anything

`SCHEMA.md` is the contract. Three things this ticket needs and does not assert:

1. **The tenant's WhatsApp number** — the column name and the stored format
   (with or without `+`, with or without the country code). `wa.me` requires
   digits only, no `+`, no spaces. Read it, don't guess it.
2. **The shape of `branding.labels`** — which keys exist and what each one
   labels. This is the app those labels were built for; getting the shape wrong
   here is the whole feature failing silently.
3. **`orders.reference`** — its format and whether anything already generates
   one. `(tenant_id, reference)` is unique, so generation and collision handling
   have to live somewhere; §1 puts them in the RPC.
4. **Which columns hold the buyer's name and the delivery address**, and whether
   the address is a column or lives inside a jsonb. §4 collects both; this ticket
   does not say where they land because it does not know. If no column exists for
   something §4 collects, stop and flag it — that is a migration decision, not a
   field to improvise into `notes`.

Also confirm what the leak test already proved: **the `anon` role has no `orders`
grant at all.** Anonymous sign-in must therefore complete *before* the order
insert, not alongside it. A checkout that inserts first will fail outright.

---

## §1 — `place_order` RPC

One migration. Same pattern as `save_product` and `confirm_order` — do not
invent a third.

`public.place_order(tenant_id, lines, fulfilment_details)` — `tenant_id`, not
the slug, so the signature matches the two RPCs already in the repo. The
storefront has resolved the tenant by slug before checkout; pass what it
resolved.

- **`SECURITY INVOKER`**, called by the buyer's anonymous authenticated session.
- Writes the order header and every line in **one transaction**. A header
  without lines would surface in the seller's queue as an empty order, which is
  worse than no order.
- **Prices are read from `variants` inside the RPC, never taken from the
  payload.** The buyer's session can insert order lines; if it also supplied
  `price_snapshot`, a buyer could set their own price. This is the security
  point of the whole ticket.
- **`name_snapshot` is composed inside the RPC** from the item name and the
  variant's own attribute values — the full label the buyer chose, `Rump Steak —
  per kg`, not `Rump Steak`. Ticket 04's queue and §5's status page both render
  from this and never join `variants`.
- **Rejects a retired or unavailable variant**, and rejects any variant not
  belonging to the resolved tenant. A cart held open while the seller edited the
  catalogue must fail cleanly, naming which line, not write a nonsense order.
- **Rejects an inactive tenant.**
- **Sets `status` to `sent` and stamps nothing else.** `confirmed_at` and
  `completed_at` are the seller's to set — RLS already refuses a buyer who tries.
- **Generates `reference` server-side** and retries on collision, since
  `(tenant_id, reference)` is unique. Short and human-sayable: a seller reads
  these aloud on WhatsApp.
- **Returns the order with its lines**, so checkout composes the WhatsApp text
  from what was actually written rather than from cart state.

**Stock is not checked here and not decremented here.** Decrement happens once,
at confirm, and that decision stands. Two buyers can order the last box; the
seller resolves it on WhatsApp, which is what they do today.

Grants: `authenticated` only. Revoked from `public` and `anon`.

## §2 — Storefront catalogue

`apps/storefront`, on the slug resolution built in 02.

- Categories, then items. Phone-first: this is opened from a WhatsApp group on a
  mid-range Android, not a desktop.
- **Every selector renders from the keys on that item's own variants, never from
  `attribute_schema`.** The palette lists what a tenant *may* use; the product
  says what it *does* use. This is the rule the whole white-label claim rests on.
- **`branding.labels` are used throughout.** If the tenant calls it a Spyskaart,
  the storefront says Spyskaart. Colours and fonts come from the `branding`
  values as CSS custom properties, as established in 03.
- **Sold-out rendering depends on `stock_mode`**, read from the tenant row:
  `counted` shows a variant with stock at or below zero as unavailable;
  `availability` uses the `available` flag alone. Never show a raw stock number
  to a buyer — that is the seller's figure.
- Retired variants never appear. The policies already filter them; do not add a
  second client-side filter that could drift from the policy.

## §3 — Cart

- Held in local state, not the database. Nothing is written until checkout.
- **Quantity input follows `sale_mode`**: `weight` takes decimals to three
  places, matching `variants.stock` (numeric, scale 3); `unit` takes whole
  numbers only, with no decimal control anywhere on screen.
- **On a `weight` tenant, every total is labelled an estimate**, in the tenant's
  own language, because the real figure is whatever the seller weighs. A buyer
  who is surprised at collection is a buyer the client loses. On a `unit`
  tenant, no estimate language appears anywhere — the total is the total.

## §4 — Checkout and the wa.me handoff

Order of operations, and it matters:

1. Collect what the order needs — the buyer's name, and a delivery address
   **only when `fulfilment_mode` is `local_delivery`**. A collect tenant must
   never see an address field.
2. **Sign in anonymously.** Lazily, here, at checkout — not on page load. This
   is why `auth.users` grows with orders rather than traffic.
3. **Call `place_order`.** The order exists in the database before the buyer
   leaves the page. This is deliberate: it is what gives the seller a queue, and
   the phantom orders it produces are what `sent`, the 24-hour flag and
   dismissal exist to handle.
4. **Then open `wa.me`.** Compose the text from the RPC's return value. It must
   carry the reference first, then each line as its `name_snapshot` with
   quantity, then the total — estimate-labelled on a weight tenant — then the
   fulfilment detail. The seller matches this against the queue by reference, so
   the reference must be unmissable.
5. **Send the buyer to their status page**, so the tab they return to is theirs,
   not the checkout form.

Encode the message text properly: newlines and Afrikaans characters both have to
survive the URL.

**The `wa.me` navigation must happen on the buyer's own tap**, not from code
running after an await. A browser blocks a window opened from an async
continuation, and a blocked handoff means the seller never gets the message while
the order sits in their queue as a phantom — the worst possible failure here.
Build it so the tap that submits is the tap that opens WhatsApp, and route the
underlying tab to the status page.

## §5 — Buyer status page

- Reached by order id in the URL. The buyer's own session reads it through
  `buyer_id = auth.uid()`, which is the only per-row mechanism RLS can express
  here.
- **Renders from `name_snapshot`, `price_snapshot`, `qty` and `line_total`
  only. Never joins `variants`.** A variant retired since the order was placed
  is filtered out of the buyer's view by policy, and the snapshot columns exist
  precisely so history doesn't depend on a mutable product row.
- **Live via Realtime**, which 01B proved end to end for a buyer's own order. A
  buyer watching this page sees the seller move it without refreshing.
- Status shown in buyer language, not the enum. `cancelled` is the delicate one:
  it is the seller dismissing an order that never reached them, so it must read
  as "we didn't receive this" and point back to WhatsApp — not as an accusation
  and not as a system error.
- **On a weight order, show both figures once confirmed** — what was ordered and
  what was weighed, and the total that follows from the weighed figure. This is
  the moment the estimate becomes real and it should be legible, not a silently
  changed number.
- **The page works on the device that placed the order and nowhere else.** The
  anonymous session lives in that browser. Say so plainly on the page. Do not
  invent magic links, email recovery or account creation to work around it —
  buyer accounts are out of v1.

## §6 — Seed images

The seed's `images.example.com` placeholders have thrown `ERR_NAME_NOT_RESOLVED`
since ticket 03. They were cosmetic in the dashboard; on a buyer-facing
storefront a broken image on every product is the demo failing.

Replace them with image files committed into the storefront's public assets and
referenced by relative path. No external image host — a client demo cannot
depend on someone else's uptime.

## §7 — Tests

New RPC test file, in the pattern of `confirm-order-rpc.test.ts`:

- writes header and lines in one transaction; a bad line writes neither
- **ignores a `price_snapshot` supplied in the payload and stores the price from
  `variants`** — the buyer-sets-own-price case, asserted explicitly
- composes `name_snapshot` as the full variant label
- refuses a retired variant, an unavailable variant, a variant from another
  tenant, and an inactive tenant, naming the offending line
- generates a unique reference, and survives a forced collision
- sets `status` to `sent` and leaves `confirmed_at` and `completed_at` null

Pure functions in a storefront model file, browser-free:

- cart arithmetic, including decimal quantities to three places
- estimate labelling present on `weight`, absent on `unit`
- sold-out determination under each `stock_mode`
- the wa.me text composition, asserted as a string

Extend the leak test: a buyer session cannot call `place_order` against another
tenant's variants, and cannot read another buyer's order through the status
page's query path.

## Out of scope

Payments · delivery slots or time windows · buyer accounts or login · web push ·
buyer-side cancellation · order editing after send · search · courier
integration · anything touching the dashboard.

## Done means

- `npm test` green, existing 125 still passing
- typecheck and build clean
- verified in a browser at phone width on **both** demo tenants:
  - demo-butchery (weight + availability): decimal quantities, estimate
    language, its own `branding.labels`, no stock numbers shown
  - demo-shoes (unit + counted): whole numbers only, no estimate or weight
    language anywhere, sold-out rendering on a zero-stock variant
- one full run per tenant: cart → checkout → order visible in the seller's queue
  as `sent` with correct lines and total → wa.me text correct → status page
  live-updates when the order is moved from the dashboard
- a status page opened on an order containing a since-retired variant still
  renders its line correctly
- seed left in its exact original state
- nothing committed until Brad has run the leak test himself
