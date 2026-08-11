# DEPLOY HANDOFF — ChopChop ticket 08

State of the Vercel, DNS and Supabase setup, written so this can be picked up
cold. `TICKET-08-deployment.md` is the work; this is the account setup, every
reading taken off the two dashboards, and what is left.

Last updated: 11 Aug 2026. **Infrastructure is complete and live.** The SPA
rewrite defect is fixed in the repo and lands on the next push — see *Open
defect* below.

---

## Hostnames — all live and verified

| what | where | state |
|---|---|---|
| Storefront | `chopchoporder.co.za` — one deployment, every client at `/<slug>` | Valid Configuration, cert issued |
| Storefront www | `www.chopchoporder.co.za` | Valid, 308 → apex |
| Dashboard | `app.chopchoporder.co.za` — one shared host, tenant comes from the login | Valid Configuration, cert issued |

The apex is canonical, not www. Vercel's import flow offers to add www and make
the **apex redirect to www** — that is the wrong way round for this product and
was flipped by hand. Every seller-facing URL, QR code and `wa.me` link uses the
bare apex. If a domain ever shows `308 → www...` on the apex row again, it has
been re-added with the default and needs flipping back.

Domain registered 11 Aug 2026 and under Brad's control. `chopchop.co.za` was
taken (held since 2011, renewed May 2026) — not available, not worth chasing.

Per-client subdomains are **not** a config change. Nothing in the code reads
`window.location.hostname`; tenant resolution is the first path segment, falling
back to `VITE_TENANT_SLUG`. A client's own domain later means either a separate
deployment with that env var set, or a new hostname→slug lookup.

---

## Live verification, 11 Aug 2026

| URL | result | verdict |
|---|---|---|
| `https://app.chopchoporder.co.za` | seller sign-in renders | correct |
| `https://www.chopchoporder.co.za` | lands on apex, www stripped | correct |
| `https://chopchoporder.co.za` | "Shop not found" | superseded — the bare apex now renders the holding page, built in the ticket. Re-check after the next push. |
| `https://chopchoporder.co.za/demo-butchery` | 404 | **defect, fixed in the repo** — see below |

---

## Open defect — SPA rewrite — **fixed in the repo, not yet deployed**

`chopchoporder.co.za/demo-butchery` returned 404. The root served `index.html`
fine, so the build and the domain were healthy; Vercel was looking for a file at
that path and there isn't one.

Fixed by `apps/storefront/vercel.json` and `apps/dashboard/vercel.json`, each
with a catch-all rewrite to `/index.html`. Both apps need it — the dashboard's
`/orders`, `/catalogue`, `/import` and `/settings` would 404 on a hard refresh
for the same reason, and `start_url` on the installed app is `/orders`, so an
installed dashboard would have opened on a 404.

Vercel applies `rewrites` **after** the filesystem check, so real files still
win: `/assets/*`, `/products/*.svg`, `/manifest.webmanifest`, `/sw.js` and the
icons all serve normally.

It lands on the next push to `main`. Until then the live site still 404s on
every deep link, so the phone verification queue at the bottom of this file
stays blocked.

---

## Vercel

Account: GitHub sign-in as `coder01128`, team `coder01128's projects`, **Hobby**
plan.

**Hobby forbids commercial use.** The first paying client means Pro at $20/month,
one subscription covering both projects. With Supabase at roughly $45/month that
is about $65/month total, flat regardless of client count.

Both projects import from `coder01128/chopchop`, branch `main`, Application
Preset `Vite`, with all three build settings left at their defaults:

| setting | value |
|---|---|
| Build Command | `npm run build` |
| Output Directory | `dist` |
| Install Command | `npm install --prefix=../..` |

| project | Root Directory | project id |
|---|---|---|
| `chopchop-storefront` | `apps/storefront` | `prj_9aZiMXmPWvHWXNfFkKAkFPpmtl1R` |
| `chopchop-dashboard` | `apps/dashboard` | — |

The install command is the load-bearing one. It installs from the repo root, so
npm workspaces can resolve `@chopchop/shared`, which exports raw `./src/index.ts`
with no build step. If a build ever fails on an unresolved `@chopchop/shared`,
this is the setting to look at. There is **no** "Include files outside the root
directory" checkbox in the current UI — the install command replaces it.

Environment variables on both projects, scoped Production and Preview:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

Values come from `C:\ccode\git-repos\chopchop\.env`. Add them one at a time —
the panel shows one Key/Value pair and an **Add More** button for the next.

Add them **before the first deploy**. Vite inlines them at build time and Vercel
only applies new vars on a redeploy, so deploying first produces a build that
looks fine and cannot reach Supabase at all.

**`SUPABASE_SECRET_KEY` is never added to Vercel.** It belongs to the test runner
and the seed scripts only.

Both projects built **Ready** on the first attempt. The `cdn.sheetjs.com` risk
did not materialise — `apps/dashboard/package.json` pins
`"xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"` deliberately,
because the npm `xlsx` package is an abandoned fork with known advisories. If a
future build fails on it, capture the error rather than swapping the dependency.

### UI note

Domains is **not** under project Settings any more. The Feb 2026 dashboard
redesign moved the horizontal tabs into the sidebar: back out of Settings with
the **‹** chevron and Domains sits in the project-level list. Settings now holds
General, Build and Deployment, Environments, Git, Deployment Protection,
Passport, Functions, Cron Jobs, Microfrontends, Project Members, Drains, Alerts,
Security, Networking, Activity, Advanced. Any instruction saying
"Settings → Domains" is stale.

---

## DNS — done

Registrar: **domains.co.za**, on its own default nameservers
(`ns1`/`ns3.tld-ns.net`, `ns2`/`ns4.tld-ns.com`). DNS stays at the registrar;
no nameserver move was needed or made.

Zone as it now stands, in *Manage Domains → chopchoporder.co.za → Manage DNS
Records*:

| Type | Host | Value |
|---|---|---|
| A | `chopchoporder.co.za` | `216.198.79.1` |
| CNAME | `www.chopchoporder.co.za` | `551c536e66cf9c26.vercel-dns-017.com.` |
| CNAME | `app.chopchoporder.co.za` | `c8190049024d21fd.vercel-dns-017.com.` |

The domain arrived with two parking records — apex A on `169.239.219.58` and a
www CNAME pointing at the apex. Those were **edited in place, not added
alongside**. Two conflicting A records on an apex produce a site that works
intermittently, which is worse to debug than one that plainly does not work.

The panel takes bare hostnames and accepts the trailing dot on CNAME values.
Vercel notes the legacy `cname.vercel-dns.com` and `76.76.21.21` still work, but
the records above are what it now recommends.

All three rows went Valid Configuration within about 15 minutes. While the cert
for `app.` was still pending the browser threw **Secure Connection Failed /
PR_END_OF_FILE_ERROR** — DNS resolving with no TLS answering on 443. That is the
expected interim state, not a fault. It cleared on its own.

---

## Supabase — project `sxzyhqzqavivmolcbdyj`

Readings taken 11 Aug 2026:

| setting | value | note |
|---|---|---|
| Site URL | `http://localhost:3000` | **needs changing** — see below |
| Redirect URLs | none | **needs entries** — see below |
| Allow anonymous sign-ins | ON | required; buyer checkout depends on it |
| Allow new users to sign up | ON | noted, not a leak |
| Confirm email | ON | |
| Allow manual linking | OFF | |
| Storage `product-images` | PUBLIC, 8 policies, 5 MB limit, `image/jpeg`, `image/png`, `image/webp` | matches migration `20260810120000` |

### Auth URL config — action, dashboard only

Seller auth is now live on a real host while Supabase still points at localhost.
Under **Authentication → URL Configuration**:

- Site URL → `https://app.chopchoporder.co.za`
- Redirect URLs → add `https://app.chopchoporder.co.za/**`
- Redirect URLs → add `http://localhost:5173/**`

The second keeps local dev working; without it an auth redirect from
`npm run dev` bounces to production. 5173 is Vite's default and no `server`
block overrides it. If a local sign-in bounces to production later, the dev
server was on another port and that port gets added too.

`supabase/config.toml` now carries these same three values, plus
`enable_anonymous_sign_ins = true`. It previously held stock CLI defaults that
disagreed with the live project on every one of them — see the trap in
`HANDOFF.md`.

### Open signup

`Allow new users to sign up` being ON means anyone holding the publishable key
can create an email user in the project. It is not a data leak — a new user has
no `tenant_users` row and every RLS policy resolves to nothing, so they see an
empty dashboard. It is a junk-row and MAU-cost concern, worth turning off once
seller onboarding is invite-driven. Logged, not urgent.

---

## Decisions taken during the pre-check exchange

1. **The secret-key build check is key-shaped**, `sb_secret_[A-Za-z0-9_-]{8,}`,
   not a literal `sb_secret_`. supabase-js's own key-prefix check puts the bare
   literal in every bundle, so a naive grep would fail every build, get switched
   off, and leave no control at all. Also assert `service_role` and the legacy
   `eyJ` JWT shape. Measure on a fresh build.
2. **`supabase/config.toml` gets corrected**, not left as a landmine. It is
   untouched CLI defaults — `site_url` of `127.0.0.1` and
   `enable_anonymous_sign_ins = false` — and does not mirror the hosted project.
   Anyone running `supabase config push` would silently kill every buyer
   checkout. Also goes into HANDOFF traps.
3. **The ticket wins on the deployment model.** Three places say the storefront
   is deployed per client on its own domain — the `CLAUDE.md` Layout line, a
   comment in `storefront/index.html`, and the header comment on
   `useTenantSlug.ts`. All three get corrected.
4. **Verification item corrected** to `/<slug>/order/<id>`. On one apex serving
   every client, the bare `/order/<id>` can never resolve a tenant — `order` is
   a reserved first segment.
5. **The raw `permission denied for table orders` on a session-less status URL
   is in scope.** A buyer who cleared storage or opened a forwarded link hits
   it, and a raw Postgres string in front of a customer is the trap HANDOFF
   already names for sellers.
6. **The storefront stays indexable.** Client shops being findable is a benefit.
   Demo tenants come out of search later by setting `active = false`, which
   already removes them from anonymous reads. No robots meta.
7. **The apex is canonical, www redirects to it.** Shorter host, one less thing
   a seller mistypes on a WhatsApp broadcast.

---

## Still to do on the two dashboards

Neither is reachable from a session here; both are one-time and neither blocks
a build.

1. **Supabase → Authentication → URL Configuration** — the three values under
   *Auth URL config* above. Seller auth is live on a real host while Supabase
   still points at localhost.
2. **Supabase → SQL editor** is *not* how the `listed` column lands.
   `supabase db push` from the repo is, and the migration is written and
   waiting: `20260811120000_tenants_listed.sql`.

## Phone verification queue

These have been accumulating in HANDOFF because none of them can be done on
localhost. They are the reason this ticket exists. Most need the SPA rewrite
landed first.

- The native file picker on a phone reaches the mapping screen
- `capture="environment"` opens the camera and the photo uploads
- The real `wa.me` popup opens WhatsApp with the order text — stubbed in every
  browser run so far
- The dashboard installs to a home screen and opens at the order queue
- A buyer places an order end to end and it lands in the seller's queue
- Hard refresh survives on `/demo-butchery` and `/<slug>/order/<id>`
- Both demo tenants render correctly on the deployed storefront
