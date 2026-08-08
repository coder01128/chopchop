# ChopChop

Multi-tenant catalogue + order platform. One codebase, one database, many client
businesses. Read `CLAUDE.md` for how the project is built and `SCHEMA.md` for
the data contract.

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

Each tenant has one item with no `image_url`, one inactive item, and two orders
— one of them `sent` and never confirmed, which is the phantom the dashboard
has to let the seller dismiss.

The script is destructive but narrow: it deletes the two demo tenants by slug
and the two demo auth users, then rebuilds them. It touches nothing else. Do
not point it at a database holding a real client.

Dashboard logins it creates are in `scripts/demo-users.mjs`. Override the
password with `DEMO_USER_PASSWORD` in `.env`.

### Run the leak test

```bash
npm run test:leak
```

Release gate, not a formality. It authenticates as `demo-butchery`, queries all
eight tables and asserts zero `demo-shoes` rows, then does the same in reverse;
then, anonymously, asserts that orders cannot be listed, that inactive items
and inactive tenants are invisible, that an order can be placed but not
back-dated or self-approved, and that nothing can be updated or deleted.

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

**Anonymous (storefront).** SELECT on `categories`, `items` and `variants` where
the row is active and the tenant is active; column-limited SELECT on `tenants`;
INSERT on `orders` and `order_items` for an active tenant. Nothing else. `anon`
holds no privilege at all on `tenant_users` or `import_batches` — those reads
are refused before RLS is consulted.

Grants are as much of the boundary as the policies. Anonymous INSERT on `orders`
is granted per column, which is what stops a buyer writing `status`,
`confirmed_at`, `completed_at` or `qty_confirmed`.

**Reading one order.** RLS is evaluated per row with no knowledge of the
caller's filter, so any policy permissive enough to return one order by id also
returns all of them unfiltered. Anonymous order reads therefore go through
`public.get_order(p_order_id)`, which takes the id as an argument and returns
that one order with its lines. The uuid is the capability.

One consequence, stated rather than worked around: the buyer status page cannot
use Realtime while `anon` has no SELECT policy on `orders`. It polls
`get_order()`. The dashboard queue subscribes as an authenticated user and is
unaffected.
