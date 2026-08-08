-- 0001 — ChopChop core schema
--
-- Eight tables, one shared database, every tenant-owned row carries tenant_id.
-- See SCHEMA.md — it is the contract; this file is its implementation.
--
-- RLS is enabled in the next migration (20260808120100_rls_policies.sql).
-- Nothing in this file grants access to anon or authenticated.

-- ---------------------------------------------------------------------------
-- Enums
--
-- Enums rather than free text so a bad value cannot be written at all, instead
-- of being caught by whichever caller happens to validate.
-- ---------------------------------------------------------------------------

create type public.sale_mode as enum ('unit', 'weight');
create type public.stock_mode as enum ('availability', 'counted');
create type public.fulfilment_mode as enum ('collect', 'local_delivery');
create type public.order_status as enum (
  'sent',       -- buyer tapped through to WhatsApp — may never have pressed send
  'received',   -- seller has seen the message
  'confirmed',  -- seller commits; stock decrements here when stock_mode = counted
  'ready',      -- collect it, or it's on the way
  'completed',  -- done — revenue metrics run off this status only
  'cancelled'   -- dismissed
);

-- ---------------------------------------------------------------------------
-- tenants — the white-label switchboard
-- ---------------------------------------------------------------------------

create table public.tenants (
  id               uuid primary key default gen_random_uuid(),
  slug             text not null unique,
  name             text not null,
  whatsapp_number  text,
  branding         jsonb not null default '{}'::jsonb,
  attribute_schema jsonb not null default '[]'::jsonb,
  sale_mode        public.sale_mode not null default 'unit',
  stock_mode       public.stock_mode not null default 'counted',
  fulfilment_mode  public.fulfilment_mode not null default 'collect',
  active           boolean not null default true,
  created_at       timestamptz not null default now(),

  -- attribute_schema is a list of { name, label, options[] }. Postgres polices
  -- the shape only; the app validates values written to variants.attributes.
  constraint tenants_attribute_schema_is_array
    check (jsonb_typeof(attribute_schema) = 'array'),
  constraint tenants_branding_is_object
    check (jsonb_typeof(branding) = 'object'),
  -- international, no '+', no leading zero — 2782...
  constraint tenants_whatsapp_number_format
    check (whatsapp_number is null or whatsapp_number ~ '^[1-9][0-9]{6,14}$')
);

comment on table public.tenants is
  'One row per client business. attribute_schema, sale_mode, stock_mode and branding drive all vertical-specific behaviour — there is none in the code.';

create index tenants_active_idx on public.tenants (active) where active;

-- ---------------------------------------------------------------------------
-- tenant_users — maps a Supabase auth user to a tenant.
-- Every RLS policy resolves against this table.
-- ---------------------------------------------------------------------------

create table public.tenant_users (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  role       text not null default 'staff' check (role in ('owner', 'staff')),
  created_at timestamptz not null default now(),

  constraint tenant_users_tenant_user_unique unique (tenant_id, user_id)
);

create index tenant_users_user_id_idx on public.tenant_users (user_id);

-- ---------------------------------------------------------------------------
-- categories — storefront nav and dashboard sidebar are rows here
-- ---------------------------------------------------------------------------

create table public.categories (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  name       text not null,
  sort_order integer not null default 0,
  active     boolean not null default true
);

create index categories_tenant_sort_idx on public.categories (tenant_id, sort_order);

-- ---------------------------------------------------------------------------
-- items — the product. Carries no price and no stock; those live on variants.
-- ---------------------------------------------------------------------------

create table public.items (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  category_id uuid references public.categories (id) on delete set null,
  name        text not null,
  description text,
  image_url   text,               -- nullable: cards must render without one
  active      boolean not null default true,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);

create index items_tenant_category_idx on public.items (tenant_id, category_id);
create index items_tenant_sort_idx on public.items (tenant_id, sort_order);

-- ---------------------------------------------------------------------------
-- variants — fixed columns for what every product has, one jsonb column for
-- everything that differs by vertical.
-- ---------------------------------------------------------------------------

create table public.variants (
  id         uuid primary key default gen_random_uuid(),
  -- denormalised deliberately: RLS needs tenant_id on the row itself rather
  -- than through a join to items.
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  item_id    uuid not null references public.items (id) on delete cascade,
  attributes jsonb not null default '{}'::jsonb,
  price      numeric(10, 2) not null,
  stock      numeric(10, 3) not null default 0,  -- decimal so weight works
  available  boolean not null default true,
  sku        text,

  constraint variants_attributes_is_object
    check (jsonb_typeof(attributes) = 'object'),
  constraint variants_price_non_negative check (price >= 0)
);

-- Both indexes are required by SCHEMA.md.
create index variants_attributes_gin_idx on public.variants using gin (attributes);
create index variants_tenant_item_idx on public.variants (tenant_id, item_id);

-- ---------------------------------------------------------------------------
-- orders
-- ---------------------------------------------------------------------------

create table public.orders (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants (id) on delete cascade,
  reference      text not null,          -- short human code — 'A47'
  customer_name  text not null,
  customer_phone text not null,
  fulfilment     public.fulfilment_mode not null,
  notes          text,
  status         public.order_status not null default 'sent',
  -- an estimate when sale_mode = weight, until the seller confirms
  total          numeric(10, 2) not null default 0,
  created_at     timestamptz not null default now(),
  confirmed_at   timestamptz,
  completed_at   timestamptz
);

create index orders_tenant_status_created_idx
  on public.orders (tenant_id, status, created_at desc);

-- ---------------------------------------------------------------------------
-- order_items — snapshots are not optional. A price change must never rewrite
-- history.
-- ---------------------------------------------------------------------------

create table public.order_items (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants (id) on delete cascade,
  order_id        uuid not null references public.orders (id) on delete cascade,
  -- restrict: never orphan a line
  variant_id      uuid not null references public.variants (id) on delete restrict,
  name_snapshot   text not null,           -- item + attributes as sold
  price_snapshot  numeric(10, 2) not null, -- price at time of order
  qty             numeric(10, 3) not null,
  qty_confirmed   numeric(10, 3),          -- actual weighed qty; drives real total
  line_total      numeric(10, 2) not null,

  constraint order_items_qty_positive check (qty > 0),
  constraint order_items_qty_confirmed_non_negative
    check (qty_confirmed is null or qty_confirmed >= 0)
);

create index order_items_order_idx on public.order_items (order_id);
create index order_items_tenant_idx on public.order_items (tenant_id);
create index order_items_variant_idx on public.order_items (variant_id);

-- ---------------------------------------------------------------------------
-- import_batches — extraction output lands here for review. It never writes to
-- items or variants directly.
-- ---------------------------------------------------------------------------

create table public.import_batches (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  source     text not null check (source in ('spreadsheet', 'vision')),
  raw        jsonb not null default '[]'::jsonb,
  status     text not null default 'pending'
               check (status in ('pending', 'applied', 'discarded')),
  created_at timestamptz not null default now()
);

create index import_batches_tenant_status_idx
  on public.import_batches (tenant_id, status, created_at desc);
