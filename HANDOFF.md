# HANDOFF — ChopChop

Context for picking this up cold in a new session. `CLAUDE.md` is the rules for
the build agent; `SCHEMA.md` is the database contract. **This file is the why.**

Last updated: 8 Aug 2026, after ticket 03. Ticket 03B written, not yet run.

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
flows, trials or self-onboarding, it is off-track — this has already been
raised once and rejected firmly.

Target buyers: home businesses and individuals already selling through WhatsApp
groups, plus small shopfronts.

---

## Why it exists in this shape

**It replaces fork-per-client.** ChowNow and Rembrandt are two near-identical
schemas on two separate Supabase projects, diverging by accident. That model
costs $25/month per client beyond the second and ships every bug fix N times.
Brad ruled per-client hosting cost a dealbreaker, which is what moved this to a
single shared instance.

**Built clean from scratch.** Deliberately not layered on ChowNow or Rembrandt —
those two are already entangled and copying code across is what caused it. Look
at them for UI patterns, rewrite against this schema.

**Rembrandt had zero rows in every table**, so nothing was lost by starting over.
It is a shipped-but-dormant build, not a live business being migrated.

---

## Decisions already made — and the reasoning, so they don't get relitigated

| decision | why |
|---|---|
| One Supabase project, tenant column + RLS | Flat ~$45/month total infra regardless of client count. Per-client projects cost $25/mo each. |
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
| `attribute_schema` is a palette, not a mandate | It lists attributes *available* to a tenant. Which attributes a product uses comes from the keys on that product's own variants. So a tenant gaining a new attribute never regenerates or migrates existing products. **Both apps render selectors from the item's own variant keys, never from `attribute_schema`.** |
| `branding.labels` is storefront-only | "Spyskaart" is the client's word for their customers. The dashboard is Brad's product, so its nav stays English. A customer-facing word in an internal tool is a bug. |
| Palette validation is strict on new, lenient on old | A product saved before the palette changed carries values no longer in it. Strict-everywhere would make old products permanently unsaveable. New combinations validate strictly; pre-existing ones pass through marked retired. |
| Attributes can be added to a product, never removed | Removing an attribute would drop every variant on the product in one click. Rare enough to stay manual — delete and rebuild. |
| `sent` orders block variant deletion, and that stands | A phantom order holding a variant hostage is bad, but auto-cancelling risks destroying a real order the seller hasn't reached. Surface it, let the seller dismiss it. |

---

## Build state

Done and committed:
- **Ticket 01** — 8 tables, enums, indexes, RLS on everything, seed with two
  deliberately opposite demo tenants, leak test.
- **Ticket 01B** — buyer auth, `orders.buyer_id`, unique `(tenant_id,
  reference)`, restrictive not-anonymous policies on all eight tables, Realtime
  tested end to end.
- **Ticket 02** — npm workspaces monorepo, `apps/dashboard`, `apps/storefront`,
  `packages/shared`. Seller sign-in, tenant resolution via `tenant_users`, tenant
  picker, app shell (bottom tabs under 48rem, left rail above), storefront slug
  resolution, `scripts/create-seller.mjs`.
- **Ticket 03** — categories, item grid, product modal, and the generated
  variant editor. `variant-model.ts` holds every rule as pure functions with 26
  tests, so the white-label claim is checkable without a browser. Verified in
  both directions: no size/colour language reaches the butchery, no weight
  language reaches the shoe shop.

Written, not yet run:
- **Ticket 03B** — atomic save RPC (the one migration), retired-variants block,
  removal dialog naming blocking orders.

Remaining to v1: 04 order queue and status flow · 05 storefront, cart, wa.me,
buyer status page · 06 import. Then deployment/domains and an onboarding
runbook. Metrics deliberately unscheduled.

Test counts as of ticket 03: 73 passing — 47 leak, 26 variant model.

Repo: `C:\ccode\git-repos\chopchop`, GitHub `coder01128/chopchop` (private —
Claude cannot read it; the GitHub connector has been failing). Docs in the root:
`CLAUDE.md`, `SCHEMA.md`, `HANDOFF.md`, the tickets, two wireframes and
`chopchop-glossary.html` — a 63-entry searchable reference for every table,
column and term, written for Brad rather than for the build agent.
Supabase project ref `sxzyhqzqavivmolcbdyj`, free tier, region Europe.
Uses the **new** Supabase API keys (`sb_publishable_` / `sb_secret_`), not the
legacy JWT pair.

---

## Traps

**The variant editor is the load-bearing screen.** Built in ticket 03 and
verified, but any change to it needs the same care: if a butchery seller ever
sees a size or colour control, or a shoe seller sees anything about weight, the
abstraction has leaked and that is the product failing.

**`order_items.variant_id` is `ON DELETE RESTRICT`.** Deleting a variant that
appears in any order throws. The editor must classify before offering a control —
never ordered means delete, has history means deactivate, open orders means
blocked with the reason named. A seller must never see a raw Postgres error.

**No transaction across a multi-row save** until ticket 03B lands. PostgREST
can't give one; the RPC in 03B is the fix.

**The leak test is the release gate.** Brad runs it and reads the output. A green
tick from the session that wrote the policies is not evidence. CC's own best
catch was noticing the restrictive policies were untestable as written and
building a test that actually exercises them.

**Anonymous users accumulate**, one per order, forever. Nothing cleans them up in
production yet. Not urgent — no real orders — but it's on the list.

**Never suggest**: self-serve signup · reusing ChowNow or Rembrandt code ·
deferring import · Vercel CLI deploys · commands that print keys.

---

## Working with Brad on this

Short answers. One recommended solution, not a menu of options he lacks the
context to judge — he has said this explicitly and it is the single most
repeated correction in the project.

Terminal instructions: literal commands, one per line, where to type them, and
what should appear afterwards. No shorthand like "run supabase link in that
folder" — that has caused real frustration.

Don't say "you're right" or validate criticism. Fix the thing.

Don't claim to have done something and then not run the tool. That has happened
once in this project and was caught.

---

## Live open questions

- Dashboard domain — one shared host, or a subdomain per client
- Can sellers edit their own `attribute_schema`, or is it onboarding-only? A bad
  edit orphans existing variants
- How long a `sent` order sits before it auto-cancels
- Package price — a WhatsApp-group home business is a smaller wallet than a
  shopfront
- Metrics screen shape — blocked on real trading data, deliberately
- Staleness window for `sent` orders — how old before the queue flags one for
  dismissal. Needed for ticket 04.
- SKU generation, bulk-fill overwrite scope, per-variant images — defaults taken
  (plain text field, fill-empty-only with an explicit overwrite, out of scope),
  none of them settled
