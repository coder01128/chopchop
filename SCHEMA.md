# SCHEMA.md — ChopChop

The contract. Both apps, the import pipeline and every policy check against this.
Change it here first, then in a migration.

Seven tables. One shared Postgres database. Every tenant-owned row carries
`tenant_id`.

---

## tenants

The white-label switchboard. One row per client business.

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `slug` | text unique | used by the storefront to resolve the tenant |
| `name` | text | trading name |
| `whatsapp_number` | text | international, no `+`, no leading zero — `2782...` |
| `branding` | jsonb | colours, logo url, tagline, UI labels |
| `attribute_schema` | jsonb | see below — drives the product modal |
| `sale_mode` | text | `unit` \| `weight` |
| `stock_mode` | text | `availability` \| `counted` — **default `counted`** |
| `fulfilment_mode` | text | `collect` \| `local_delivery` |
| `active` | bool | |
| `created_at` | timestamptz | |

### attribute_schema

Declares what a variant looks like for this client. The product modal is
generated from it. Nothing else in the codebase knows what a client sells.

```json
[
  { "name": "unit", "label": "Sold by", "options": ["per kg", "per pack"] }
]
```

```json
[
  { "name": "size",   "label": "Size",   "options": ["7", "8", "9"] },
  { "name": "colour", "label": "Colour", "options": ["white", "black", "red"] }
]
```

One attribute → one row per option. Two attributes → the full grid (3 × 3 = 9
variants). Zero attributes → a single default variant, which is how a vacuum
cleaner works.

Values written to `variants.attributes` are validated against this list before
save. Postgres will not police it — the app must, or you get `navy` and `Navy`
as separate variants.

### branding

```json
{
  "primary": "#7f1d1d",
  "logo_url": "...",
  "tagline": "...",
  "labels": { "catalogue": "Spyskaart", "cart": "Mandjie" }
}
```

---

## tenant_users

Maps a Supabase auth user to a tenant. This table is what every RLS policy
resolves against.

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `tenant_id` | uuid FK → tenants | |
| `user_id` | uuid FK → auth.users | |
| `role` | text | `owner` \| `staff` |
| `created_at` | timestamptz | |

Unique on (`tenant_id`, `user_id`).

---

## categories

The storefront nav and the dashboard sidebar are rows in this table. Nothing is
hardcoded — Beesvleis and Lam are data, not components.

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `tenant_id` | uuid FK | |
| `name` | text | |
| `sort_order` | int | |
| `active` | bool | |

---

## items

The product. Carries no price and no stock — those live on variants.

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `tenant_id` | uuid FK | |
| `category_id` | uuid FK → categories | nullable |
| `name` | text | |
| `description` | text | |
| `image_url` | text | nullable — cards must render without one |
| `active` | bool | hidden from storefront when false |
| `sort_order` | int | |
| `created_at` | timestamptz | |

---

## variants

Where the universality lives. Fixed columns for the things every product has;
one jsonb column for everything that differs by vertical.

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `tenant_id` | uuid FK | denormalised deliberately — RLS needs it directly |
| `item_id` | uuid FK → items | cascade delete |
| `attributes` | jsonb | `{"size":"8","colour":"black"}` — `{}` for no-variant products |
| `price` | numeric(10,2) | in ZAR |
| `stock` | numeric(10,3) | decimal so weight works; ignored when `stock_mode = availability` |
| `available` | bool | the in-stock toggle; the only stock signal when `stock_mode = availability` |

`stock_mode` defaults to `counted`. These sellers trade only through orders, so
a count stays accurate and a baker with 20 loaves wants them to run out on their
own. `availability` is for the minority who also sell over a counter, where
walk-in sales bypass the app and any count drifts wrong within hours.
| `sku` | text | nullable |

Index on `attributes` (GIN) and on (`tenant_id`, `item_id`).

---

## orders

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `tenant_id` | uuid FK | |
| `reference` | text | short human code — `A47` — shown in the WhatsApp message |
| `customer_name` | text | |
| `customer_phone` | text | |
| `fulfilment` | text | `collect` \| `local_delivery` |
| `notes` | text | buyer's note |
| `status` | text | see flow below |
| `total` | numeric(10,2) | estimate when `sale_mode = weight` until confirmed |
| `created_at` | timestamptz | |
| `confirmed_at` | timestamptz | nullable |
| `completed_at` | timestamptz | nullable |

### status flow

| status | meaning |
|---|---|
| `sent` | buyer tapped through to WhatsApp — may never have pressed send |
| `received` | seller has seen the message. An acknowledgement, nothing more. |
| `confirmed` | seller commits to fulfilling it. A promise. Stock decrements here when `stock_mode = counted`. |
| `ready` | collect it, or it's on the way |
| `completed` | done. **Revenue metrics run off this status only.** |
| `cancelled` | dismissed — covers the buyer who never pressed send |

`sent` orders older than a set window need dismissing, or the queue fills with
phantoms. Never report revenue on `confirmed`.

---

## order_items

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `tenant_id` | uuid FK | |
| `order_id` | uuid FK → orders | cascade delete |
| `variant_id` | uuid FK → variants | restrict — never orphan a line |
| `name_snapshot` | text | item + attributes as sold |
| `price_snapshot` | numeric(10,2) | price at time of order, not current price |
| `qty` | numeric(10,3) | decimal for weight |
| `qty_confirmed` | numeric(10,3) | nullable — actual weighed qty; drives the real total |
| `line_total` | numeric(10,2) | |

Snapshots are not optional. A price change must never rewrite history.

---

## import_batches

Extraction output lands here for review. It never writes to `items` or
`variants` directly.

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `tenant_id` | uuid FK | |
| `source` | text | `spreadsheet` \| `vision` |
| `raw` | jsonb | extracted rows, pre-approval |
| `status` | text | `pending` \| `applied` \| `discarded` |
| `created_at` | timestamptz | |

---

## RLS

Enabled on all eight tables. No exceptions, including `import_batches`.

**Authenticated (dashboard):** all operations restricted to rows whose
`tenant_id` appears in the caller's `tenant_users` rows.

**Anonymous (storefront):** SELECT only, and only on `categories`, `items` and
`variants`, where `active = true` and the tenant is active. A menu is public
information; nothing else is.

**Order creation:** anonymous INSERT into `orders` and `order_items` for an
active tenant. Anonymous SELECT on a single order by id only — enough for the
status page, never a list.

`tenants` is readable anonymously for public fields only (slug, name, branding,
labels). `whatsapp_number` is fine to expose — it's on the storefront anyway.

**The test:** `/tests/tenant-leak.test.ts` — authenticate as tenant A, query
every table, assert zero rows belonging to tenant B. Run before every go-live.

---

## Seed data

Two demo tenants, deliberately opposite, so both code paths are exercised:

| | demo-butchery | demo-shoes |
|---|---|---|
| attribute_schema | `unit` | `size` × `colour` |
| sale_mode | `weight` | `unit` |
| stock_mode | `availability` | `counted` |
| fulfilment_mode | `collect` | `local_delivery` |

If a feature works for one and not the other, it isn't finished.
