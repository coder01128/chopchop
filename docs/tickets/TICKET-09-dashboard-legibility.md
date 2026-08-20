# TICKET 09 — Dashboard legibility

The dashboard draws headings, section labels and status captions in the tenant's
own brand colour. On demo-butchery that is `#7f1d1d` against a near-black
surface — roughly 1.7:1 contrast, where small text needs 4.5:1. Observed on the
deployed dashboard 11 Aug 2026 on the Queue and Settings screens; it is not
specific to those two.

Swapping the red for a lighter colour does not fix this. The value comes from
`branding.primary` on the tenants row, so the next client with a dark brand
colour lands in the same place, and a client with a bright one would have their
brand overwritten by whatever we hard-code.

---

## The rule

**The dashboard's own chrome never draws text in the tenant's colour.**

Headings, section labels, table labels, status captions, warnings and buttons
come from a fixed dashboard palette, contrast-checked once. The tenant's colour
survives only where it is decorative and large — the logo tile, an accent rule —
where contrast does not bite.

This is the same reasoning already recorded for `branding.labels`: the storefront
speaks the client's language, the dashboard is our product.

Two standing constraints, project-wide, not just this ticket:

- **4.5:1 minimum contrast** on any text, against the surface it actually sits on
- **13px minimum font size** anywhere text appears

---

## Scope

### 1. Dashboard palette

Add fixed dashboard UI tokens — a heading/label colour, a warning colour, a muted
body colour — as CSS custom properties in one place, alongside the existing
variables rather than in a new system.

The label and heading colour is **yellow**, per Brad. Pick a value that clears
4.5:1 against the darkest surface it lands on and state the measured ratio in the
commit message. Do not assume a swatch passes; measure it.

Warnings (`OVER 24 HOURS — CHECK WHATSAPP`, the pill on the Queue header) are the
one place a red is defensible as a signal, but it must be a dashboard red that
clears 4.5:1 — not the tenant's.

### 2. Find every tenant-colour text use

Grep the dashboard for uses of the accent variable and for any hard-coded hex
that came from branding. Every one that colours **text** moves to the new tokens.
Every one that colours a **surface, tile or border** stays.

Known instances from the screenshots, not exhaustive — the grep is the
authority:

- `ORDERS` / `Queue` eyebrow and heading
- `NEW` / `ACKNOWLEDGED` / `CONFIRMED` / `READY` group captions and their counts
- `OVER 24 HOURS — CHECK WHATSAPP` row captions
- The `N orders to check against WhatsApp` pill
- `IMPORT` / `SETTINGS` sidebar items
- `READ ONLY FOR NOW` caption
- Settings table row labels: `SLUG`, `SALE_MODE`, `STOCK_MODE`,
  `FULFILMENT_MODE`, `WHATSAPP_NUMBER`, `ATTRIBUTE_SCHEMA`, `BRANDING.PRIMARY`,
  `BRANDING.LOGO_URL`, `BRANDING.TAGLINE`, `BRANDING.LABELS`
- The `LISTED` checkbox label

The `DB` logo tile keeps the tenant colour. That is the one place the brand
should be visible on this screen.

### 3. Type scale

The Settings row labels are the smallest type in the app — around 10px. Raise the
shared variable driving them to **13px minimum**. It is one token, so this also
lifts the Queue group captions and the row warnings; verify that is what happens
rather than patching each screen.

Then sweep for any other declaration below 13px — including anything expressed in
`rem` that resolves below it — and raise it. Report what was found.

Uppercase letter-spaced labels stay uppercase and letter-spaced. The complaint is
size and contrast, not style.

### 4. Storefront

Out of scope for the colour rule — the storefront is *meant* to wear the client's
colours. But the 13px floor and the 4.5:1 rule apply there too, so run the same
two sweeps and report anything that fails. Do not change storefront colours in
this ticket; surface a list.

---

## Verification

- Every changed text/background pair measured, ratios listed in the ticket
  comment, none below 4.5:1
- No declaration under 13px anywhere in the dashboard
- Screenshot the Queue and Settings screens at desktop width and at 375px
- Confirm the `DB` tile still renders `#7f1d1d` for demo-butchery
- Load demo-shoes and confirm its accent still reaches the tile and nothing else
- `npm run typecheck`, both builds, and the secret check clean
- Full test suite green; add no tests unless a model function changed

## Out of scope

- Any change to `branding.primary` values in the database
- A theming system, dark/light modes, or a component library
- Restyling anything that already meets both constraints
