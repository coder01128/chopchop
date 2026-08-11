# TICKET 08 — Deployment

Both apps live on real hostnames over HTTPS, and everything that has been
waiting on a real URL gets verified on a real phone.

Domain: **chopchoporder.co.za**, registered and under Brad's control.

- Storefront — `chopchoporder.co.za`, one deployment serving every client at
  `/<slug>`
- Dashboard — `app.chopchoporder.co.za`, one shared host, every seller signs in
  and lands on their own tenant

Read `CLAUDE.md` and `SCHEMA.md` first. This ticket does not restate the schema;
where it needs a column it says so as a pre-check, not as an assumption.

---

## Pre-checks — run these and report before writing any code or config

Do not assume any of the following. Read them, state what you found, and stop if
anything contradicts this ticket.

1. **Every environment variable both apps read**, by name, with which key each
   one carries. State explicitly whether any `sb_secret_` value is reachable
   from a client bundle today. If one is, that is the first thing fixed and this
   ticket stops until it is.
2. **Build config per workspace app** — build command, output directory, and
   whether either app currently assumes a base path. The storefront resolves
   tenants from the first path segment, so a base path would collide with a
   slug.
3. **Current Supabase Auth settings** — Site URL and the redirect allow-list as
   they stand.
4. **What exists today for PWA** in either app: manifest, icons, service worker,
   `beforeinstallprompt` handling. Report what is actually there, not what is
   intended.
5. **Deep-link behaviour** — does the storefront survive a hard refresh on
   `/demo-butchery` and `/order/<id>` in the dev server, and what is the router
   configuration that decides it?
6. **`tenants` columns**, before this ticket adds `listed`.

---

## Scope

### 1. Two Vercel projects, one monorepo

Both apps deploy from the same repo, each as its own Vercel project with its own
root directory. A push to `main` deploys both.

`vercel.json` in each app with an SPA rewrite. Without it, a hard refresh on
`/demo-butchery` returns 404 from the CDN, which is the exact failure mode that
makes a client think their shop is broken. Verify by refreshing, not by reading
the config.

**Hobby plan does not permit commercial use.** A paying client puts this on Pro
at $20/month. State that in the report so it lands in the infra numbers next to
the ~$45 Supabase figure rather than arriving as a surprise invoice.

### 2. Environment and secrets

- Client bundles carry the **publishable** key only (`sb_publishable_`).
- `sb_secret_` exists in the test runner and in scripts. It must not appear in
  any built bundle, in either app, in any environment.
- Add a check that greps both build outputs for `sb_secret_` and for the service
  role string and fails the build if either is found. A convention is not a
  control; the grep is the control.

### 3. Supabase configuration

- Site URL points at the dashboard host.
- Redirect allow-list carries the dashboard host, the storefront host, and
  localhost for development. Report the final list.
- Confirm Storage public URLs resolve from the deployed origins. The bucket is
  public-read by design; this is a verification step, not a change.

### 4. The bare root

`chopchoporder.co.za` with no path segment resolves no tenant, and falls through
to the env var. Decide what that renders and build it: a minimal holding page
naming ChopChop and nothing else.

It must not be an error, a blank screen, or a redirect into some arbitrary
client's shop. This is the address people will type after seeing a link, and one
day it is where the directory lives.

### 5. PWA, deliberately asymmetric

**Dashboard: installable.** Manifest, icons, `standalone` display, `start_url`
pointing at the order queue. An owner behind their counter opening an icon
straight into their queue is the behaviour this is for, and it is what makes web
push possible on iOS later.

**Storefront: not installable, deliberately.** No manifest, no install prompt.
A butchery's customers will not install anything, checkout needs the network
anyway because the wa.me handoff is the whole flow, and an install prompt on a
shop link is friction with no return. The storefront still gets the engineering
that matters — fast first load, cached assets, mobile-first layout.

Write that decision into HANDOFF so a later session doesn't "fix" the missing
manifest.

### 6. `listed` on tenants

- `listed boolean not null default true` on `tenants`.
- A toggle in dashboard settings, with a plain sentence explaining what it does.
- A line in the onboarding runbook where Brad tells the client it exists.

Nothing renders a directory in this ticket. This exists so that every client from
the first one is already in the data, and so nobody discovers a listing later and
feels done to.

### 7. Onboarding runbook

A new document, `RUNBOOK.md`, written as literal steps rather than prose: adding
a tenant row, the `tenant_users` link, branding values, the four switches,
categories, the seller's first import, images, the storefront link to hand over,
and the `listed` conversation. Written so Brad can follow it at a client's
counter without reading anything else.

---

## Out of scope

- 06B vision extraction
- The directory page itself
- Custom per-client domains — the env-var fallback already supports one, but
  wiring a client's own domain is its own ticket
- Metrics — still blocked on real trading data
- Self-serve anything

---

## Verification — on a real phone, on the real domain

This is the reason the ticket exists. Every item below has been sitting in
HANDOFF unverifiable.

- The native file picker opens on a phone and reaches the mapping screen
- `capture="environment"` opens the camera, and a photo taken with it uploads
- The real `wa.me` popup opens WhatsApp with the order text — it has been
  stubbed in every browser run so far
- The dashboard installs to a home screen and opens at the order queue
- A buyer places an order end to end and it appears in the seller's queue
- A hard refresh on `/demo-butchery` and on `/order/<id>` both survive
- Both demo tenants render correctly on the deployed storefront

Report each as observed or failed. Do not report anything as passing that was
verified in a desktop browser.

---

## Definition of done

- Both hosts serve over HTTPS with valid certificates
- No secret key appears in any build output, enforced by the grep check
- Sign-in works on the deployed dashboard for both demo tenants
- Every phone verification above is observed on a handset
- The bare root renders the holding page
- `RUNBOOK.md` exists and Brad has read it end to end
- Tests still pass, typecheck clean, both apps build clean
- Nothing committed until Brad has run the leak test himself and read the output
  with `--reporter=verbose`
