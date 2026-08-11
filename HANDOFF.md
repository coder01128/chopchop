# HANDOFF — ChopChop

Context for picking this up cold in a new session. `CLAUDE.md` is the rules for
the build agent; `SCHEMA.md` is the database contract. **This file is the why.**

Last updated: 11 Aug 2026, after ticket 08 deployment. `DEPLOY-HANDOFF.md`
holds the Vercel, DNS and Supabase account setup.

---

## What ChopChop is

A white-label catalogue and order platform: one codebase, one shared Supabase
project, many client businesses. A butchery selling by weight and a shoe shop
selling by size and colour run identical code. The only difference is their
`tenants` row.

It is **an expansion of the OneShot Web offering** — Brad builds and hands over
site + PWA + dashboard as a paid upgrade on a site build. It is **not** a
self-serve SaaS. Sellers never sign themselves up, never build their own
storefront, never configure their own schema. If a suggestion implies signup
flows, trials or self-onboarding, it is off-track — this has been raised and
rejected firmly.

Target buyers: home businesses and individuals already selling through WhatsApp
groups, plus small shopfronts.

---

## Why it exists in this shape

**It replaces fork-per-client.** ChowNow and Rembrandt are two near-identical
schemas on two separate Supabase projects, diverging by accident. That model
costs $25/month per client beyond the second and ships every bug fix N times.
Per-client hosting cost was the dealbreaker that moved this to a single shared
instance at a flat ~$45/month regardless of client count.

**Built clean from scratch.** Deliberately not layered on ChowNow or Rembrandt —
those two are already entangled and copying code across is what caused it. Look
at them for UI patterns, rewrite against this schema.

**Rembrandt had zero rows in every table**, so nothing was lost by starting over.
It is a shipped-but-dormant build, not a live business being migrated.

---

## Decisions already made — and the reasoning, so they don't get relitigated

| decision | why |
|---|---|
| One Supabase project, tenant column + RLS | Flat infra cost regardless of client count. Per-client projects cost $25/mo each. |
| Variants table with a jsonb `attributes` column | One shape covers meat by weight, shoes by size × colour, meals by portion, vacuum cleaners with no variants. No per-vertical columns, ever. |
| Four switches on `tenants` | `attribute_schema`, `sale_mode`, `stock_mode`, `fulfilment_mode`. Adding a client is a row, not a code change. |
| `wa.me` handoff, no payments | Matches what these sellers already do. Cloud API rejected: a number on it can no longer be used in the WhatsApp Business app, which is the seller's actual workplace. |
| Order written to DB *before* the wa.me link | Otherwise the dashboard has no order queue and half the product's value disappears. Cost is phantom orders from buyers who never press send — hence the `sent` status and dismissal. |
| `received` ≠ `confirmed` | Received is an acknowledgement, confirmed is a promise. Collapsing them means sellers promise stock they haven't checked. |
| Metrics run off `completed` only | Confirmed-but-never-collected orders would inflate revenue and the client stops trusting the numbers. |
| Buyers are anonymous auth users, signed in lazily at checkout | RLS can't express "read one order if you know its id" — any policy permissive enough returns all of them. `buyer_id = auth.uid()` is per-row, so Realtime works. Lazy so `auth.users` grows with orders, not traffic. |
| `stock_mode` defaults to `counted` | These sellers trade only through orders, so a count stays accurate. `availability` is for the minority who also sell over a counter, where walk-ins make any count wrong within hours. |
| Import is IN v1 | Brad pushed back hard when it was proposed for deferral — a seller importing their existing price list is a large part of why the package is worth buying. Mobile-capable; review renders as a table on desktop, card stack on phones. |
| CSS Modules + CSS custom properties | Branding is already runtime values from a DB row; custom properties are that mechanism. Tailwind would mean maintaining a theme config on top of the same vars. Cost: no shadcn/ui. |
| `attribute_schema` is a palette, not a mandate | It lists attributes *available* to a tenant. Which attributes a product uses comes from the keys on that product's own variants, so a tenant gaining a new attribute never regenerates or migrates existing products. **Both apps render selectors from the item's own variant keys, never from `attribute_schema`.** |
| `branding.labels` is storefront-only | "Spyskaart" is the client's word for their customers. The dashboard is Brad's product, so its nav stays English. A customer-facing word in an internal tool is a bug. |
| Palette validation strict on new, lenient on old | A product saved before the palette changed carries values no longer in it. Strict-everywhere would make old products permanently unsaveable. |
| Attributes can be added to a product, never removed | Removing one would drop every variant on the product in one click. Rare enough to stay manual — delete and rebuild. |
| `sent` orders block variant deletion, and that stands | A phantom order holding a variant hostage is bad, but auto-cancelling risks destroying a real order the seller hasn't reached. Surface it, let the seller dismiss it. |
| `retired_at` is its own column, not `available = false` | `available` is also the everyday in-stock toggle and the only stock signal for an availability tenant. Overloading it made "retired" unrepresentable. |
| Orders render from snapshots, never by joining `variants` | `order_items` carries `name_snapshot`, `price_snapshot` and `line_total`. A retired variant is filtered from buyer views by policy, and a price edit today must not rewrite what a buyer was charged last week. |
| Stock decrements once, at `confirm` | Not at `sent` — a phantom order would eat stock it never took. Not at `ready` or `completed`. Nothing restores it on a later transition; by confirm the goods have left the shelf. |
| A confirm never fails on insufficient stock | The count goes negative and the catalogue says "N below zero — recount". The seller has already cut the meat; a refusal doesn't un-cut it, it just leaves them unable to record what happened. |
| Staleness flag at 24 hours, nothing auto-cancels | Age measures whether the seller has *looked at the dashboard*, not whether an order is phantom. A shorter window flags real overnight orders and trains the seller to distrust the flag. |
| Status transitions are forward-only | `sent → received → confirmed → ready → completed`, plus `sent → cancelled` (dismissal). Correcting a mis-tap has no path — that is an open question, not an invented feature. |
| Order references are random, not sequential | A counter needs a `SECURITY DEFINER` helper granted to `authenticated`, which lets any buyer session read a client's order count. 5 characters from `23456789ABCDEFGHJKMNPQRSTVWXYZ`, unique index decides, 12 attempts then `40001`. |
| `place_order` reads prices from `variants`, never the payload | The buyer's session can insert order lines. If it also supplied `price_snapshot`, a buyer could set their own price. |
| Delivery address is plain `text` | jsonb buys structure nothing in v1 reads, and the dashboard needs one readable block a seller can copy into Maps. Real SA addresses are gate codes and landmarks, which is what free text is. |
| Import counters count products, errors count rows | The seller's check is arithmetic — the number on review must be the number their catalogue grows by. A variant-level count reads as lost products. The commit button counts new + updated, because a price-only import would otherwise read zero and disable itself. |
| A row matching a retired variant imports as new | Matching it would make `save_product` clear `retired_at` and resurrect something the seller removed by hand. Cost: a duplicate sits alongside the retired one, visible on review. |
| One storefront deployment on the apex, every client at `/<slug>` | Per-client deployments meant a Vercel project, a domain and an env var per client — the fork-per-client cost this whole product exists to remove, reintroduced at the hosting layer. `VITE_TENANT_SLUG` survives as the fallback for a client who later wants their own domain; it is unset on the apex. Path wins over env, so both work from one bundle. |
| **The storefront gets no manifest and no install prompt** | Deliberate, and the reason is written out below so nobody "fixes" it. |
| The dashboard ships a service worker that caches nothing | Chrome dropped the service-worker requirement for menu-install (v108 mobile, v112 desktop), but `beforeinstallprompt` still needs a fetch handler — so without one there is no in-app Install button and a seller has to find the browser menu behind their counter. Caching is the part that was refused: a cached order queue shows an order as unconfirmed an hour after the seller confirmed it. |
| The secret-key check is key-shaped, not a literal grep | supabase-js's own prefix check puts the literal `sb_secret_` in every bundle. A literal grep fails every build, gets switched off, and leaves no control. Verified in both directions — it passes a clean build and fails an injected key. |
| `tenants.listed` exists with no directory to feed | So every client from the first is already in the data with an answer they were asked for, rather than a listing appearing later and a client discovering it was done to them. Not granted to `anon`: the grant lands with the surface that justifies it, which is the mistake recorded twice below. |
| A refused order read renders as "we cannot find that order" | To a buyer, no session and not-your-order are the same fact: this device cannot see it. It was rendering `permission denied for table orders` — Postgres's words in front of a customer. |

---

## Build state

Done, committed and pushed:
- **01** — 8 tables, enums, indexes, RLS on everything, seed with two
  deliberately opposite demo tenants, leak test.
- **01B** — buyer auth, `orders.buyer_id`, unique `(tenant_id, reference)`,
  restrictive not-anonymous policies on all eight tables, Realtime tested.
- **02** — npm workspaces monorepo, `apps/dashboard`, `apps/storefront`,
  `packages/shared`. Seller sign-in, tenant resolution via `tenant_users`, app
  shell (bottom tabs under 48rem, left rail above), storefront slug resolution.
- **03** — categories, item grid, product modal, generated variant editor.
  `variant-model.ts` holds every rule as pure functions.
- **03B** — `save_product` atomic RPC, `variants.retired_at`, removal dialog
  naming blocking orders.
- **04** — order queue, forward-only status flow, 24-hour staleness flag,
  dismissal, `order-model.ts`, reversible `scripts/seed-orders.mjs`.
- **04B** — `confirm_order` RPC. Decrements by `coalesce(qty_confirmed, qty)`
  read from `order_items` not the payload, `select … for update` so a double-tap
  serialises, `received` only, re-confirm returns unchanged. Negative counts
  surface in the catalogue.
- **05** — `place_order` RPC, storefront catalogue, cart, checkout, wa.me
  handoff, buyer status page. `delivery_address` added. 10 SVG product images
  committed locally, so the old `images.example.com` console errors are gone.

- **Random references + definer guard** — `place_order` draws a random code;
  `next_order_reference` dropped; `public.security_definer_functions` is a view
  over `pg_proc` (granted `service_role` only) exposing `security_definer`,
  `anon_can_execute` and `authenticated_can_execute`. The guard test asserts a
  per-function privilege map and was mutation-checked, not trusted on a green run.

Built, not yet committed at the time of writing:
- **06** — spreadsheet import. `import-model.ts` holds every rule as pure
  functions; `parse-file.ts` is the only file that knows what a spreadsheet is,
  and it hands over a headers-plus-rows table — the seam 06B enters at.
  SheetJS is pinned to the CDN tarball (`xlsx-0.20.3`, npm's `xlsx` is
  abandoned at 0.18.5) and dynamically imported, so it is a separate chunk
  fetched only when a file is picked. Commit is one `save_product` call per
  product, no direct inserts, no removals ever. `import_batches` follows the
  lifecycle it already had — `pending` on opening review, `applied` on commit,
  `discarded` on cancel; `applied` does not mean every row succeeded. Verified
  in the browser against both demo tenants: butchery's mapping screen offers
  only `Sold by` and names the stock column it is ignoring, shoes' offers only
  `Size` and `Colour` and honours the count. Re-import of a grown list took the
  butchery catalogue 12 → 15 with no duplicates and left the omitted product
  untouched.

- **07** — product images. One Storage bucket, `product-images`: public read,
  writes scoped to the seller's own prefix. Objects at
  `<tenant_id>/<item_id>/<uuid>.<ext>`, and the bucket policies derive tenant
  access from `user_tenant_ids()` — the same helper every table policy uses, not
  a second source of truth. `image_path` on both `items` and `variants`;
  `items.image_url` becomes legacy and read-only, which is how the seeded SVGs
  keep rendering with no data migration. Resolution is one function in
  `packages/shared/src/image-model.ts` — variant path, product primary, legacy
  url, empty — imported by both apps, so the seller's dashboard and the buyer's
  sheet cannot disagree about which photo a variant shows. **The library is not
  a table**: a product's images are the objects under its prefix, so a row and
  an object can never disagree about what exists. The upload control resizes
  client-side to 1600px / JPEG 0.82 (a 4 MB phone shot lands 250–400 KB),
  reports progress over XHR because fetch cannot, and offers the camera below
  the 48rem breakpoint. `save_product` carries image paths, refuses one outside
  the caller's tenant prefix, and treats an **absent** key as unchanged against
  a **present-but-empty** key as cleared — which is what stops a spreadsheet
  re-import stripping a seller's photographs. A product being created mints its
  own id (`new_id`), because the object path contains the item id and a photo
  may be taken before the first save.

- **08** — deployment. Both apps live on `chopchoporder.co.za` and
  `app.chopchoporder.co.za`; the account setup, DNS zone and every dashboard
  reading are in `DEPLOY-HANDOFF.md`. In the repo: an SPA rewrite per app
  (without it a hard refresh on `/demo-butchery` is a 404 from the CDN, which
  is what a client reads as "my shop is broken"), the bundle secret check wired
  into both build scripts, the bare-apex holding page, dashboard PWA, `listed`
  on `tenants`, and `RUNBOOK.md`. `supabase/config.toml` was corrected —
  see traps.

Remaining to v1: **06B vision import**. Metrics deliberately unscheduled until
a client has traded.

Test count: 267 across 10 files — tenant-leak, save-product-rpc,
confirm-order-rpc, place-order-rpc, variant-model, order-model,
storefront-model, storefront-routing, import-model, image-model.

Repo: `C:\ccode\git-repos\chopchop`, GitHub `coder01128/chopchop` (private —
Claude cannot read it; the GitHub connector has been failing). Docs in the root:
`CLAUDE.md`, `SCHEMA.md`, `HANDOFF.md`, the tickets, two wireframes and
`chopchop-glossary.html`. Supabase project ref `sxzyhqzqavivmolcbdyj`, free tier,
region Europe. Uses the **new** Supabase API keys (`sb_publishable_` /
`sb_secret_`), not the legacy JWT pair.

Demo tenants: `demo-butchery` is weight + availability + collect;
`demo-shoes` is unit + counted + local_delivery. **No demo tenant covers
weight + counted**, which is the combination a real butchery that counts
kilograms would use — that path is covered by the RPC test, never in a browser.
`variants.stock` is `numeric` scale 3, so fractional decrements are safe.

---

## Traps

**The variant editor and the storefront are the load-bearing white-label
screens.** If a butchery seller ever sees a size or colour control, or a shoe
seller sees anything about weight or an estimate, the abstraction has leaked and
that is the product failing. Verify in both directions, every time.

**`order_items.variant_id` is `ON DELETE RESTRICT`.** The editor must classify
before offering a control — never ordered means delete, has history means
retire, open orders means blocked with the reason named. A seller must never see
a raw Postgres error.

**Never join `variants` to render an order line.** Snapshots exist for this.

**The leak test is the release gate.** Brad runs it and reads the output. A green
tick from the session that wrote the policies is not evidence. Read the summary
for `passed (N)` matching the collected count and `skipped 0`; vitest prints only
slow tests by default, so use `--reporter=verbose` to see names.

**Anonymous users accumulate**, one per order, forever. Nothing cleans them up.
Not urgent — no real orders — but it's on the list.

**Storage objects accumulate too — the second unbounded thing.** A product's
image library *is* the set of objects under `<tenant_id>/<item_id>/` in the
`product-images` bucket; nothing tracks them in a table. So a delete that
happens anywhere other than the library's own delete control leaves the file
behind: removing a variant does not delete the photograph it pointed at (right
— the same file may be carrying two other sizes), and deleting a *product* drops
its rows by cascade while its whole folder stays in Storage with nothing left
pointing at it. Nothing reaps them. Not urgent — no real clients, and objects
are ~300 KB after the client-side resize — but it is unbounded and it now sits
alongside the anonymous users. The fix when it matters is a scheduled sweep
comparing bucket prefixes against live `items.id`, not a tracking table, which
would reintroduce the row-and-object disagreement the model avoids.

**"The surface is public, so grant it to `anon`" has now bitten twice.** Both
times the reasoning was true and the grant was still wrong, because the grant
did not govern the surface it was justified by.

- The `SECURITY DEFINER` reference helper: a sequential order reference is
  harmless to a buyer, but the function that produced it could be called
  directly, and it read a client's order count.
- The Storage SELECT policy on `product-images`: photographs are public, and a
  public bucket serves `/object/public/…` **without consulting RLS at all**. So
  the policy was never what made images render — the only call it governed was
  `list()`, which is the enumeration primitive. It shipped read on every
  tenant's objects to anyone holding the publishable key, in exchange for
  nothing.

Before granting anything to `anon` or `authenticated`: name the exact call that
needs it, and check whether the path you are trying to enable consults RLS in
the first place. If it does not, the grant is buying you a different capability
from the one you are thinking about.

**`SECURITY DEFINER` plus a grant to a Data API role is the shape of the bug that
has bitten once.** Five policy helpers are definer by necessity, since a policy
is evaluated in the caller's context: `user_tenant_ids`, `is_active_tenant`,
`order_belongs_to_tenant`, `is_buyer_order`, `item_is_active`. Anything else that
is definer *and* executable by `anon` or `authenticated` needs a reason.

**The storefront has no manifest and no install prompt, and that is the
decision.** It is not an oversight, not a missing ticket, and not something to
tidy up while passing through. A butchery's customers will not install a shop.
Checkout needs the network anyway, because the `wa.me` handoff *is* the flow —
an offline-capable shop that cannot complete an order is a worse lie than one
that plainly needs signal. And an install prompt on a link someone tapped out
of a WhatsApp group is friction charged against the seller's conversion rate,
in exchange for nothing. The storefront still gets the engineering that
matters: fast first load, cached hashed assets, mobile-first layout. The
**dashboard** is the installable one — an owner behind their counter opening an
icon straight into their order queue, which is also what makes web push
possible on iOS later.

**`supabase/config.toml` is now load-bearing and was a landmine.** It shipped
as untouched CLI defaults — `site_url` on `127.0.0.1`, redirect list of one
localhost entry, and `enable_anonymous_sign_ins = false` — while the hosted
project had been configured by hand in the dashboard. The two never agreed.
`supabase db push` does not read the `[auth]` block, but **`supabase config
push` does**, and running it would have switched off anonymous sign-ins on the
live project: every buyer checkout, gone, with nothing in the repo to explain
why. The file now mirrors the hosted project. If either is changed, change both.

**Vercel builds run `npm install --prefix=../..` from each app's root
directory.** That is what lets npm workspaces resolve `@chopchop/shared`, which
exports raw `./src/index.ts` and has no build step. A build failing on an
unresolved `@chopchop/shared` is this setting, not the code.

**Never suggest**: self-serve signup · reusing ChowNow or Rembrandt code ·
deferring import · Vercel CLI deploys · commands that print keys · a manifest
or install prompt on the storefront.

---

## Working with Brad on this

Short answers. One recommended solution, not a menu of options he lacks the
context to judge — the single most repeated correction in the project.

Terminal and dashboard instructions: literal commands, one per line, where to
type them, and what should appear afterwards. No shorthand, no "just", no
combining several actions into one sentence.

**Finish reviewing a deliverable before telling him to act on it.** Issuing an
instruction he runs immediately and then following it with "wait, also do this
first" is the recurring frustration.

Don't say "you're right" or validate criticism. Fix the thing.

Don't claim to have done something and then not run the tool.

---

## Live open questions

- **The upload control has never been exercised on a real phone.** Ticket 07
  built it and it was verified in a desktop browser, including a synthesised
  camera-sized image through the real file input, the resize, the upload, the
  assignment and the storefront swap. What is unverified is the thing the
  control exists for: a seller tapping **Take photo** on an actual handset,
  where `capture="environment"` is what opens the camera rather than the
  gallery. One tap-through on a deployed URL before a client sees it, on Android
  and on iOS — some iOS Safari versions ignore `capture` and fall back to the
  picker, which is degraded but not broken.
- **The native OS file picker is confirmed by hand on desktop only.** Mobile is
  unverified, and on a phone that dialog is the path to Drive, Dropbox and
  anything saved out of a WhatsApp chat. One tap-through on a deployed URL
  before a client sees it. `samples/` holds throwaway spreadsheets for exactly
  that, and is gitignored.
- **06B vision extraction is specified but not built** — Supabase Edge
  Function, Anthropic key server-side, entering at the mapping step via the
  headers-plus-rows seam that ticket 06 built against.
- **`rls_auto_enable`** — a `SECURITY DEFINER`, volatile, zero-argument function
  no migration here created. Both `anon` and `authenticated` hold `EXECUTE`; it
  was never revoked from `PUBLIC`. PostgREST routes it at
  `/rest/v1/rpc/rls_auto_enable`, POST only. Nobody has read its body, invoked it
  or revoked it. Zero-arg means a caller can't aim it at a tenant, which is why
  it isn't an emergency — but it is unresolved. Read the definition before
  deciding anything.
- The real `wa.me` popup has never been exercised end to end — `window.open` was
  stubbed during the ticket 05 browser run to keep demo order text off an
  external host.
- ~~Dashboard domain — one shared host, or a subdomain per client~~ **settled in
  ticket 08**: one shared host, `app.chopchoporder.co.za`. The tenant comes from
  the login, not the hostname — nothing in either app reads
  `window.location.hostname`.
- Can sellers edit their own `attribute_schema`, or is it onboarding-only? A bad
  edit orphans existing variants
- Correcting a mis-tapped status transition — no path exists
- How long a `sent` order sits before anything happens beyond the 24-hour flag
- Package price — a WhatsApp-group home business is a smaller wallet than a
  shopfront
- Metrics screen shape — blocked on real trading data, deliberately
- SKU generation, bulk-fill overwrite scope, per-variant images — defaults taken
  (plain text field, fill-empty-only with an explicit overwrite, out of scope),
  none of them settled
