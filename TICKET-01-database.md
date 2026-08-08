# TICKET 01 — Database, RLS, seed, leak test

Project: **ChopChop** · Supabase project `chopchop`

**Run this unattended.** Scope is the database layer only. Do not build UI, do
not scaffold the apps, do not touch import logic.

## Before starting (Brad does these — CC cannot)

- [ ] Local folder created, `git init`, empty repo pushed to GitHub
- [ ] `CLAUDE.md` and `SCHEMA.md` committed in the repo root
- [ ] Fresh Supabase project created
- [ ] `.env` holds `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` — the **new** key pair, pasted manually from Settings → API Keys → Publishable and secret
- [ ] `.gitignore` excludes `.env`, and `.env.example` (blank values) is committed instead
- [ ] Supabase CLI installed, `supabase link` done (needs the DB password)

---

## The prompt

> Read `CLAUDE.md` and `SCHEMA.md` in the repo root first. They are the contract
> — if anything below contradicts them, stop and say so rather than guessing.
>
> Build the database layer for this project. Database only: no UI, no app
> scaffolding, no import logic.
>
> **1. Migrations.** Create numbered migration files under
> `/supabase/migrations/` for all eight tables exactly as specified in
> `SCHEMA.md`: `tenants`, `tenant_users`, `categories`, `items`, `variants`,
> `orders`, `order_items`, `import_batches`. Include every column, type, default,
> foreign key, cascade rule, unique constraint and index named in the doc — the
> GIN index on `variants.attributes` and the composite on
> `(tenant_id, item_id)` are both required. Use enums or check constraints for
> `sale_mode`, `stock_mode`, `fulfilment_mode` and order `status` so bad values
> cannot be written. `stock_mode` defaults to `counted`.
>
> **2. RLS.** Enable RLS on all eight tables — no exceptions, `import_batches`
> included. Write policies per the RLS section of `SCHEMA.md`:
> - Authenticated: every operation restricted to rows whose `tenant_id` appears
>   in the caller's `tenant_users` rows.
> - Anonymous: SELECT only on `categories`, `items` and `variants`, where
>   `active = true` and the tenant is active.
> - Anonymous INSERT into `orders` and `order_items` for an active tenant.
> - Anonymous SELECT on a single order by id — never a list.
> - `tenants` readable anonymously for public fields only.
>
> Write the `tenant_users` lookup as a `SECURITY DEFINER` helper function and
> call it from the policies, so the policy itself does not recursively trigger
> RLS on `tenant_users`. Explain in a comment why.
>
> **3. Types.** Generate TypeScript types into `/packages/shared/types/db.ts`
> and add the npm script that regenerates them.
>
> **4. Seed.** A seed script creating the two demo tenants from `SCHEMA.md`,
> deliberately opposite:
> - `demo-butchery` — `attribute_schema` of one attribute (`unit`: per kg, per
>   pack), `sale_mode: weight`, `stock_mode: availability`,
>   `fulfilment_mode: collect`
> - `demo-shoes` — two attributes (`size`: 7/8/9, `colour`: white/black/red),
>   `sale_mode: unit`, `stock_mode: counted`,
>   `fulfilment_mode: local_delivery`
>
> Each gets 3–4 categories, 6–8 items, and full variant sets — the shoe items
> must generate the complete 3 × 3 grid. Include at least one item with a null
> `image_url` and one inactive item, because both must render correctly later.
> Add two orders per tenant at different statuses, including one `sent` order
> that will never be confirmed.
>
> **5. Leak test.** `/tests/tenant-leak.test.ts`: authenticate as a
> `demo-butchery` user, query all eight tables, assert zero rows belonging to
> `demo-shoes`. Then repeat in the opposite direction. Then, as an anonymous
> client, assert that `orders` cannot be listed and that inactive items are not
> returned. The test must fail loudly with the table name when a leak is found.
> Add the npm script to run it.
>
> **6. README section** documenting how to apply migrations, seed and run the
> test.
>
> Apply the migrations with the Supabase CLI. Do not run any command that prints
> keys or secrets. Do not use the Supabase SQL editor. Do not run any Vercel CLI
> command.
>
> When finished, list what you created, and state anything in `SCHEMA.md` you
> found ambiguous rather than resolving it silently.

---

## When you come back

Run the leak test yourself and read the output. A green tick from the session
that wrote the policies is not evidence.

Then spot-check in the Supabase dashboard: does `demo-shoes` have exactly nine
variants on a shoe item, and does the butchery item have two?
