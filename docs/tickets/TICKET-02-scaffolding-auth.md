# TICKET 02 — Scaffolding, seller auth, tenant resolution

Project: **ChopChop** · follows tickets 01 and 01B · no catalogue or order UI

This is the skeleton both apps hang off: two Vite apps, a shared package, a
working seller login, and the tenant context that every later screen reads from.
Nothing in this ticket renders a product or an order.

## Before starting (Brad does this)

- [ ] Ticket 01B committed and pushed
- [ ] `.env` holds `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`,
      `SUPABASE_SECRET_KEY`

---

## The prompt

> Read `CLAUDE.md` and `SCHEMA.md` first. Build the app scaffolding, seller
> authentication and tenant resolution. **No catalogue UI, no order UI, no
> import** — those are later tickets. If a screen would show a product or an
> order, it is out of scope; stub the route and stop.
>
> **1. Monorepo.** Set up `/apps/dashboard`, `/apps/storefront` and
> `/packages/shared` per the layout in `CLAUDE.md`, both apps React + Vite +
> TypeScript. `packages/shared` holds the generated DB types from ticket 01, the
> Supabase client factory, and the tenant context. Neither app talks to Supabase
> except through the shared client.
>
> **2. Supabase clients.** One factory in `packages/shared`. It reads
> `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` only. The secret key
> must not be importable from either app — if a client-side file can reach it,
> that is a bug in this ticket.
>
> **3. Seller auth (dashboard).** Email and password sign-in via Supabase Auth.
> A sign-in screen, a sign-out action, session persistence across reloads, and
> route protection so an unauthenticated visitor reaching any route lands on
> sign-in. **No sign-up screen** — sellers never self-register; Brad creates
> logins. Handle the expired-session case by returning to sign-in rather than
> erroring.
>
> **4. Tenant resolution (dashboard).** After sign-in, resolve the caller's
> tenant through `tenant_users` and load the full `tenants` row into a React
> context. Expose `branding`, `attribute_schema`, `sale_mode`, `stock_mode`,
> `fulfilment_mode`, `whatsapp_number` and the tenant id. Every later screen
> reads behaviour from this context and never from a hardcoded value.
>
> If a user has no `tenant_users` row, show a plain "no business linked to this
> login" screen. If a user has more than one, show a tenant picker — the schema
> permits it even though v1 won't use it.
>
> **5. Tenant resolution (storefront).** Resolve the tenant from the URL slug
> and load the public tenant row **as the `anon` role — do not sign in
> anonymously here.** Per `SCHEMA.md`, anonymous sign-in happens lazily at
> checkout, which is a later ticket. An unknown or inactive slug renders a plain
> not-found page, not a crash.
>
> **6. Branding application.** Both apps apply `branding` — accent colour, name,
> logo, and the label overrides — from the tenant row at runtime. No tenant name
> or colour appears as a literal anywhere in either codebase. Handle a tenant
> with no logo (show initials) and no accent (fall back to a neutral default).
>
> **7. App shell.** Dashboard shell per section 00 of the wireframe, mobile-first:
> bottom tab bar under the breakpoint, left rail above it. Nav entries for
> Orders, Catalogue, Import, Settings, each routing to an empty placeholder
> screen. Storefront gets a header carrying tenant branding and nothing else yet.
>
> **8. Seller account creation script.** `scripts/create-seller.mjs`, run with
> the secret key: takes an email, a password and a tenant slug, creates the auth
> user with the email pre-confirmed via the admin API, and inserts the
> `tenant_users` row. Email confirmation is enabled on the project and the
> built-in SMTP is not production-grade, so logins are created this way rather
> than by invite.
>
> **9. Verify against both demo tenants.** Create a seller login for
> `demo-butchery` and one for `demo-shoes`. Signing in as each must yield that
> tenant's branding and config, and neither may see the other's. The storefront
> must resolve both slugs.
>
> Do not print keys. Do not use the SQL editor. Do not run any Vercel CLI
> command. Do not add a schema migration — if you believe one is needed, stop and
> say why.
>
> When finished, list what you built and flag anything ambiguous rather than
> resolving it silently.

---

## When you come back

Sign in as each demo seller and confirm the branding actually differs. Then open
the storefront at both slugs. Then check that `SUPABASE_SECRET_KEY` appears
nowhere under `/apps` — `grep -r "SECRET" apps/` should return nothing.
