# CLAUDE.md — ChopChop

Multi-tenant catalogue + order platform. One codebase, one database, many client
businesses. A butchery selling by weight and a shoe shop selling by size/colour
run on identical code — the difference lives entirely in their `tenants` row.

**Read `SCHEMA.md` before touching anything.** It is the contract.

---

## Stack

- Postgres via Supabase (single shared project, all tenants)
- Supabase Auth (dashboard users only; buyers never log in)
- Supabase Realtime (order status → PWA)
- Supabase Edge Functions (anything needing a secret key)
- React + Vite, deployed on Vercel
- No CSS framework decision is locked yet — see Open Questions

## Layout

```
/supabase/migrations/    numbered SQL, the only way schema changes
/supabase/functions/     edge functions (extraction, notifications)
/apps/dashboard/         seller app — ONE deployment for all tenants
/apps/storefront/        buyer PWA — deployed per client, own domain
/packages/shared/        types, tenant config resolution, attribute logic
/tests/                  leak test lives here and is not optional
```

---

## Non-negotiables

**RLS on every table, no exceptions.** Every policy filters on `tenant_id`.
A table without RLS is a data breach with a delay on it. Public catalogue read
is the only anonymous access, and it is read-only.

**The leak test is a release gate.** `/tests/tenant-leak.test.ts` authenticates
as tenant A and queries every table asserting zero tenant B rows. It runs before
any client goes live. A passing test written by the same session that wrote the
policies is not evidence — Brad runs it and reads the output himself.

**Secrets never reach the client bundle.** Anthropic keys, the Supabase secret
key, anything private lives in Edge Functions. ChowNow has this bug live; it does
not get carried here. Never run commands that print keys — Brad pastes them into
`.env` and Vercel's dashboard manually.

This project uses Supabase's **new API keys**, not the legacy JWT pair. The
legacy `anon` / `service_role` keys are deprecated at the end of 2026 and are not
used here.

| variable | key | where it may appear |
|---|---|---|
| `VITE_SUPABASE_URL` | project URL | anywhere |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_…` | client bundle — safe, RLS gates it |
| `SUPABASE_SECRET_KEY` | `sb_secret_…` | Edge Functions and local only — bypasses RLS |

Nothing secret ever carries a `VITE_` prefix; that prefix ships it to the
browser.

**Schema changes are migration files.** `supabase migration new <name>`, then
`supabase db push`. Never the SQL editor, never a dashboard click. The repo is
the source of truth; Supabase is a copy of it.

**Never deploy via Vercel CLI.** `git push` to main only. The CLI has previously
reset Root Directory settings and broken a live site.

**No vertical-specific logic in components.** If a component contains the word
`meat`, `size`, `shoe`, `menu` or any client's name, it is wrong. Behaviour comes
from `attribute_schema`, `sale_mode`, `stock_mode` and `fulfilment_mode` on the
tenant row. There is one variant editor, one product modal, one catalogue view.

**Test before shipping.** Null checks, empty states, error states. Both demo
tenants must work — they are configured as opposites deliberately.

---

## The white-label mechanism

Four fields on `tenants` drive everything:

| field | does what |
|---|---|
| `attribute_schema` | what a variant looks like — generates the product modal |
| `sale_mode` | `unit` (whole numbers, final total) or `weight` (decimal qty, total is an estimate until confirmed) |
| `stock_mode` | `availability` (in-stock toggle) or `counted` (decrements on confirm) |
| `branding` | name, colours, logo, labels, WhatsApp number |

Adding a client = one tenants row + one login + a domain. No code, no migration,
no new database. If onboarding a client requires a code change, the abstraction
has failed and that is a bug, not a feature request.

---

## v1 scope

Buyers are home businesses and individuals already selling through WhatsApp
groups, sold to as an upgrade on an OSW site build. Brad builds and delivers the
whole package — site, PWA, dashboard. **There is no self-serve signup.** A seller
never creates their own tenant, configures their own schema or builds their own
storefront. If a ticket implies a signup flow, the ticket is wrong.

**In:** catalogue, variants, cart, wa.me order handoff, dashboard order queue
with status flow, prefilled WhatsApp reply, Realtime buyer status page,
availability and counted stock, manual product entry, **spreadsheet import and
vision import**.

**Out — do not build these, do not scaffold for them:** self-serve signup,
staff management UI, online payments, courier integration, delivery slots,
buyer accounts, multi-currency, web push, catalogues in the thousands.

Import is a headline selling point, not a nice-to-have — a seller pasting in
their existing price list is a large part of why this package is worth buying.
Build spreadsheet parsing first (free, exact, instant), vision second (costs per
upload, needs the review gate most).

**Import is fully mobile-capable.** A standard file input opens the Files picker
on Android and iOS, which reaches Drive, Dropbox and anything saved out of a
WhatsApp chat. Photo capture is better on mobile than desktop — the camera is
already there. Extraction runs in an Edge Function, so the device only uploads.

The one part that differs by screen is the review step: a 40-row preview table
is unusable at 390px. Render the same batch as a **table on desktop and one card
per extracted product on mobile** — name, price, variants, tap to fix, tap to
approve, next. One component, two presentations, nothing else affected.

`tenant_users` stays and every RLS policy resolves against it, but there is no
screen for managing users. Brad creates logins directly.

`fulfilment_mode` exists as a column with values `collect` and `local_delivery`.
Courier is not implemented.

---

## Working style

- Think once, build once. Five broken iterations burns the session budget.
- If Brad has a working pattern in an existing project, replicate it rather than
  reinventing it — but read it, don't copy files across.
- Don't assert implementation constraints unless verified. "I'm not sure, checking"
  beats a confident wrong claim.
- Dark backgrounds: text is off-white or accent, never grey-on-grey.

---

## Open questions — do not guess these

- Styling approach for the two apps
- Whether the dashboard is one deployment on a shared domain (planned) or
  per-client subdomains
- Domain for the dashboard
