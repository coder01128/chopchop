# ChopChop

Multi-tenant catalogue + order platform. One codebase, one database, many client
businesses. Read `CLAUDE.md` for how the project is built and `SCHEMA.md` for
the data contract.

---

## Apps

npm workspaces. `npm install` at the root installs everything.

```
apps/dashboard/      seller app — ONE deployment for all tenants
apps/storefront/     buyer PWA — deployed per client, own domain
packages/shared/     Supabase client, tenant context, branding, generated types
```

```bash
npm run dev:dashboard    # http://localhost:5173
```

```bash
npm run dev:storefront   # http://localhost:5174/<tenant-slug>
```

`npm run build` builds both; `npm run typecheck` type-checks both.

Neither app constructs a Supabase client of its own — `getSupabaseClient()` in
`packages/shared` is the only one, and it reads `VITE_SUPABASE_URL` and
`VITE_SUPABASE_PUBLISHABLE_KEY` and nothing else. Both Vite configs point
`envDir` at the repo root so one `.env` serves the apps and the node scripts.

**Styling: CSS Modules plus CSS custom properties.** No framework. Tenant
branding *is* a set of custom properties — `applyBranding()` writes `--accent`
and `--accent-ink` onto the document root once the tenant resolves, and every
component reads `var(--accent)`. Shared tokens live in
`packages/shared/src/theme.css`. No tenant's name or colour appears as a literal
anywhere in either app.

### Which tenant?

The **dashboard** resolves it from the signed-in user's `tenant_users` row. No
row shows a "no business linked" screen; more than one shows a picker (v1 never
produces that, but the schema allows it).

The **storefront** resolves it from the URL: the first path segment if there is
one, otherwise `VITE_TENANT_SLUG`. Production is one deployment per client on
their own domain, so the env var is the real mechanism; the path segment is what
lets one dev server serve both demo tenants. It reads the tenant as the `anon`
role and does **not** sign in anonymously — per `SCHEMA.md` that happens lazily
at checkout, so a passer-by who never orders never mints an auth user.

### Create a seller login

Sellers never self-register — there is no sign-up screen and no invite mail
(email confirmation is on and the built-in SMTP is not production grade). Create
the login directly:

```bash
node scripts/create-seller.mjs --email ross@example.com --password '…' --tenant demo-butchery --role owner
```

Re-running for an existing email links that user to the tenant instead of
failing. Run it through `node` rather than `npm run create-seller --`, which
does not forward flags reliably on Windows.

---

## Database

Everything below assumes `.env` exists with the three variables from
`.env.example` and that `supabase link` has been run.

```bash
npm install
```

### Apply migrations

Migrations under `supabase/migrations/` are the only way the schema changes.
Never the SQL editor, never a dashboard click — the repo is the source of truth
and Supabase is a copy of it.

```bash
npm run db:push
```

Adding one:

```bash
supabase migration new <name>
```

Applied migrations are never edited. Correct them with a new file.

| migration | what it does |
|---|---|
| `20260808120000_init_schema.sql` | enums, the eight tables, constraints, indexes |
| `20260808120100_rls_policies.sql` | helper functions, RLS on all eight tables, policies, first grants |
| `20260808120200_tighten_grants.sql` | strips privileges inherited from the project defaults, re-grants exactly the intended surface |
| `20260808120300_anon_order_ids.sql` | lets the buyer supply the order id, so the storefront can link to its own status page |
| `20260808130000_buyer_auth.sql` | buyers become anonymous auth users: `orders.buyer_id`, `unique (tenant_id, reference)`, buyer policies, restrictive not-anonymous policies on all eight tables, Realtime |

### Prerequisite

Anonymous sign-ins must be enabled: Supabase dashboard → Authentication →
Sign In / Up → **Anonymous sign-ins**. The seed and the leak test both fail
with a pointer to this if it is off.

### Regenerate types

```bash
npm run db:types
```

Writes `packages/shared/types/db.ts` from the linked project. Run it after every
migration; the file is generated output and is not edited by hand.

### Seed the demo tenants

```bash
npm run db:seed
```

Creates `demo-butchery` and `demo-shoes` — deliberately opposite, so both code
paths are exercised. If a feature works for one and not the other, it isn't
finished.

| | demo-butchery | demo-shoes |
|---|---|---|
| attribute_schema | `unit` | `size` × `colour` |
| sale_mode | `weight` | `unit` |
| stock_mode | `availability` | `counted` |
| fulfilment_mode | `collect` | `local_delivery` |
| catalogue | 4 categories, 7 items, 14 variants | 3 categories, 6 items, 54 variants |

Each tenant has one item with no `image_url`, one inactive item, two orders —
one of them `sent` and never confirmed, which is the phantom the dashboard has
to let the seller dismiss — and one pending import batch.

Orders carry a `buyer_id` pointing at an anonymous auth user the seed creates
per tenant. Those sessions are not reproducible (there is no password to sign
back in with), so the leak test creates its own buyer sessions rather than
reusing them.

The script is destructive but narrow: it deletes the two demo tenants by slug
and the two demo auth users, then rebuilds them. It also sweeps anonymous auth
users left with no orders — SCHEMA.md flags that these accumulate and need
periodic cleanup, and the tenant wipe has just orphaned them. It touches nothing
else. Do not point it at a database holding a real client.

Dashboard logins it creates are in `scripts/demo-users.mjs`. Override the
password with `DEMO_USER_PASSWORD` in `.env`.

### Run the leak test

```bash
npm run test:leak
```

Release gate, not a formality. Three passes:

- **Tenant against tenant.** Authenticates as `demo-butchery`, queries all eight
  tables, asserts zero `demo-shoes` rows; then the same in reverse. Also asserts
  each tenant sees its *own* rows, so a policy that returns nothing cannot pass
  vacuously.
- **The `anon` role.** The public catalogue reads; nothing else does. Orders,
  `tenant_users` and `import_batches` are refused outright rather than returning
  an empty set, and `tenants.created_at` is refused by column grant.
- **Buyer sessions.** Real anonymous auth users. A buyer reads its own order and
  no other, cannot see the seeded orders, cannot place one under another
  `buyer_id` or with `status` already set, cannot update or delete its own order
  once sent, and cannot touch the catalogue. One test grants a buyer a genuine
  `tenant_users` row through the service role and asserts it *still* sees
  nothing — without that, every other buyer assertion would pass on the missing
  tenant link alone and the restrictive policies would never be load-bearing.
  One more subscribes to Realtime and asserts the buyer receives its own order's
  status change, which is the reason this design exists.

It fails naming the table and the offending row ids.

Run it before any client goes live. A green tick from the session that wrote the
policies is not evidence — run it and read the output.

It needs migrations applied and the seed run first.

---

## How access control is arranged

Two audiences, and the storefront's is deliberately tiny.

**Authenticated (dashboard).** Every operation on every table is restricted to
rows whose `tenant_id` appears in the caller's `tenant_users` rows. The lookup
is `public.user_tenant_ids()`, a `SECURITY DEFINER` function — the policy on
`tenant_users` has to read `tenant_users`, which recurses if written inline.

**The `anon` role (public catalogue).** SELECT on `categories`, `items` and
`variants` where the row is active and the tenant is active, plus column-limited
SELECT on `tenants`. Nothing else, and no writes at all. `anon` holds no
privilege whatsoever on `orders`, `order_items`, `tenant_users` or
`import_batches` — those reads are refused before RLS is consulted.

**Buyers.** A buyer calls `signInAnonymously()` on first visit, which creates a
real auth user holding the `authenticated` role with an `is_anonymous` claim.
Their access is `buyer_id = auth.uid()` on `orders`, and the parent order's
ownership on `order_items`.

This exists for Realtime. RLS is evaluated per row with no knowledge of the
caller's filter, so "anyone may read one order if they know its id" is not
expressible — any policy permissive enough to return one order returns all of
them. A `SECURITY DEFINER` function can fetch one order, but a function is not a
subscription, so the buyer page would have to poll. `buyer_id = auth.uid()` is a
per-row check, so Postgres Changes can evaluate it per subscriber.

**Why the restrictive policies exist.** A buyer now holds the same Postgres role
as a dashboard user, and permissive policies combine with OR — so one carelessly
written policy would hand every buyer session the tenant's data. Every
tenant-scoped table therefore carries a *restrictive* policy, which ANDs with
everything else and cannot be widened by a policy added later. On `orders` and
`order_items` it is scoped so the buyer's own rows survive; everywhere else it
shuts an anonymous session down to the public catalogue.

Grants remain as much of the boundary as the policies, but they cannot help
here: a buyer holds `authenticated`, so it holds an INSERT grant on every column
of `orders` including `status`. That ceiling is set in the policy's `WITH CHECK`
instead — a buyer may only insert `status = 'sent'` with null timestamps, and
has no UPDATE or DELETE policy at all.

**Cleanup.** Anonymous users accumulate in `auth.users`. `orders.buyer_id` is
`ON DELETE SET NULL` so sweeping them never takes the seller's order history
with it.
