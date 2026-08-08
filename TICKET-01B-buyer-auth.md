# TICKET 01B — Buyer auth, Realtime, reference uniqueness

Project: **ChopChop** · follows ticket 01 · database layer only

Ticket 01 shipped with buyers as the `anon` role, which forced a
`SECURITY DEFINER` function to fetch a single order and left the buyer status
page unable to use Realtime. This replaces that approach.

## Before starting (Brad does this)

- [ ] Supabase dashboard → Authentication → Sign In / Up → **enable Anonymous
      sign-ins**. Nothing in this ticket works until that's on.

---

## The prompt

> Read `CLAUDE.md` and the updated `SCHEMA.md` first — the RLS and Buyer
> identity sections have changed since ticket 01. Database layer only: no UI, no
> app scaffolding.
>
> Buyers are moving from the `anon` Postgres role to **anonymous Supabase Auth
> users**. An anonymous auth user holds the `authenticated` role and carries an
> `is_anonymous` claim in its JWT. This is so the buyer's order status page can
> use Realtime, which respects RLS and therefore needs a per-row policy rather
> than a `SECURITY DEFINER` function.
>
> Write migrations for the following. Do not edit the ticket-01 migration files —
> add new numbered ones.
>
> **1. `orders.buyer_id`.** Add `buyer_id uuid references auth.users(id)`, with
> an index. Backfill is not required; the seed will be re-run.
>
> **2. Reference uniqueness.** Add `unique (tenant_id, reference)` on `orders`.
> The seller matches the WhatsApp message against this code, so two buyers
> holding A47 is a real collision, not a cosmetic one.
>
> **3. Replace the buyer access path.**
> - Drop the `anon` INSERT grants and policies on `orders` and `order_items`,
>   and the `anon` grant on `orders.id` added in migration 0004.
> - Drop `public.get_order(p_order_id)`.
> - Add `authenticated` policies on `orders`: INSERT with
>   `with check (buyer_id = (select auth.uid()))`, SELECT with
>   `using (buyer_id = (select auth.uid()))`.
> - Add the equivalent on `order_items` via its parent order.
> - The tenant's dashboard users must still see every order for their tenant —
>   keep that policy alongside.
>
> **4. Restrictive policies on the dashboard surface.** Anonymous auth users now
> hold `authenticated`, and permissive policies combine with OR. On every
> tenant-scoped table — `tenants`, `tenant_users`, `categories`, `items`,
> `variants`, `orders`, `order_items`, `import_batches` — add a **restrictive**
> policy asserting the caller is not an anonymous user, so a buyer session can
> never reach dashboard data even if a permissive policy is later written
> carelessly. Buyers' own order access must survive this — scope the restrictive
> policies so they do not block the `buyer_id` path.
>
> **5. Enable Realtime** on `orders` for the status page, and confirm the
> publication includes it.
>
> **6. Update the seed** so demo orders carry a `buyer_id`. Create two anonymous
> demo buyers, one per tenant, so the tests have real sessions to authenticate
> as.
>
> **7. Extend `/tests/tenant-leak.test.ts`:**
> - A buyer session reads its own order and no other order, in either tenant.
> - A buyer session cannot list `orders` at all.
> - A buyer session reads nothing from `tenants`, `tenant_users`, `items`,
>   `variants`, `categories` or `import_batches` beyond what the public
>   catalogue grants allow.
> - A buyer cannot INSERT an order with someone else's `buyer_id`.
> - The existing tenant-A-versus-tenant-B assertions still pass.
> - Assert refusals, not empty results, wherever a grant should be absent.
>
> **8. Regenerate types.**
>
> Apply with the Supabase CLI. Do not print keys. Do not use the SQL editor. Do
> not run any Vercel CLI command.
>
> When finished, list what changed and flag anything in `SCHEMA.md` you found
> ambiguous rather than resolving it silently.

---

## When you come back

Run the leak test yourself and read the output — particularly the new buyer
assertions. The restrictive policies are the part most likely to be subtly
wrong: too broad and buyers lose their own orders, too narrow and a buyer
session can read a tenant's catalogue management data.
