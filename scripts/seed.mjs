// Seed the two demo tenants.
//
//   npm run db:seed
//
// Deliberately opposite configurations, so both code paths are exercised by
// anything built on top of this:
//
//                  demo-butchery        demo-shoes
//   attributes     unit                 size x colour
//   sale_mode      weight               unit
//   stock_mode     availability         counted
//   fulfilment     collect              local_delivery
//
// Destructive but narrow: it deletes the two demo tenants by slug (cascading to
// their categories, items, variants and orders) and the two demo auth users,
// then rebuilds them. It touches nothing else. Do not point it at a database
// holding a real client.
//
// Uses SUPABASE_SECRET_KEY, which bypasses RLS. Local and Edge Functions only —
// never the client bundle.

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { DEMO_PASSWORD, DEMO_USERS, DEMO_SLUGS } from './demo-users.mjs';

const url = process.env.VITE_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
const publishable = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!url || !secret || !publishable) {
  console.error(
    'Missing VITE_SUPABASE_URL, SUPABASE_SECRET_KEY or VITE_SUPABASE_PUBLISHABLE_KEY in .env',
  );
  process.exit(1);
}

const db = createClient(url, secret, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/**
 * A demo buyer. Anonymous auth users can only be created by signing in as one —
 * there is no admin equivalent — so this goes through the publishable key like
 * a real storefront visitor does.
 */
async function createAnonymousBuyer(label) {
  const client = createClient(url, publishable, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.signInAnonymously();
  if (error) {
    console.error(
      `\n  anonymous sign-in for ${label} failed: ${error.message}` +
        '\n  Enable it: Supabase dashboard -> Authentication -> Sign In / Up -> Anonymous sign-ins.',
    );
    process.exit(1);
  }
  return data.user.id;
}

/** Throw with context instead of returning a null row nobody checks. */
function ok(label, { data, error }) {
  if (error) {
    console.error(`\n  ${label} failed: ${error.message}`);
    process.exit(1);
  }
  return data;
}

/** Cartesian product of an attribute_schema, in declaration order. */
function variantCombos(schema) {
  return schema.reduce(
    (acc, attr) => acc.flatMap((row) => attr.options.map((opt) => ({ ...row, [attr.name]: opt }))),
    [{}],
  );
}

// ---------------------------------------------------------------------------
// Tenant definitions
// ---------------------------------------------------------------------------

const butcherySchema = [
  { name: 'unit', label: 'Sold by', options: ['per kg', 'per pack'] },
];

const shoesSchema = [
  { name: 'size', label: 'Size', options: ['7', '8', '9'] },
  { name: 'colour', label: 'Colour', options: ['white', 'black', 'red'] },
];

const butchery = {
  slug: 'demo-butchery',
  name: 'Demo Butchery',
  whatsapp_number: '27821234567',
  branding: {
    primary: '#7f1d1d',
    logo_url: null,
    tagline: 'Vars vleis, elke dag',
    labels: { catalogue: 'Spyskaart', cart: 'Mandjie' },
  },
  attribute_schema: butcherySchema,
  sale_mode: 'weight',
  stock_mode: 'availability',
  fulfilment_mode: 'collect',
  active: true,
};

const shoes = {
  slug: 'demo-shoes',
  name: 'Demo Shoes',
  whatsapp_number: '27829876543',
  branding: {
    primary: '#1e3a8a',
    logo_url: null,
    tagline: 'Every size, every day',
    labels: { catalogue: 'Catalogue', cart: 'Bag' },
  },
  attribute_schema: shoesSchema,
  sale_mode: 'unit',
  stock_mode: 'counted',
  fulfilment_mode: 'local_delivery',
  active: true,
};

// name, sort_order
const butcheryCategories = [
  ['Beesvleis', 1],
  ['Lam', 2],
  ['Hoender', 3],
  ['Wors', 4],
];

const shoesCategories = [
  ['Sneakers', 1],
  ['School Shoes', 2],
  ['Sandals', 3],
];

// category, name, description, image_url, active, base price per variant
// image_url null on at least one item and active false on at least one, in both
// tenants — a card without a photo and a hidden product both have to render.
//
// Images are relative paths into each app's `public/products`, and the files are
// committed. They were external URLs until ticket 05: cosmetically broken in the
// dashboard, but a broken image on every product of a buyer-facing storefront is
// the demo failing. A client demo does not depend on someone else's uptime.
const butcheryItems = [
  ['Beesvleis', 'Rump Steak', 'Aged 21 days, cut to order.', '/products/rump.svg', true, { 'per kg': 189.9, 'per pack': 94.95 }],
  ['Beesvleis', 'Beef Mince', 'Lean mince, ideal for bolognaise.', null, true, { 'per kg': 129.9, 'per pack': 64.95 }],
  ['Lam', 'Lamb Chops', 'Karoo lamb loin chops.', '/products/lamb-chops.svg', true, { 'per kg': 259.9, 'per pack': 129.95 }],
  ['Lam', 'Lamb Shank', 'Slow-cook cut, bone in.', '/products/shank.svg', true, { 'per kg': 179.9, 'per pack': 89.95 }],
  ['Hoender', 'Chicken Braai Pack', 'Mixed portions, marinated.', '/products/braai.svg', true, { 'per kg': 89.9, 'per pack': 74.95 }],
  ['Wors', 'Boerewors', 'Coarse ground, traditional spice.', '/products/wors.svg', true, { 'per kg': 119.9, 'per pack': 59.95 }],
  ['Wors', 'Biltong Off-cuts', 'Out of season — hidden from the storefront.', null, false, { 'per kg': 349.9, 'per pack': 174.95 }],
];

// category, name, description, image_url, active, price, stock per size
const shoesItems = [
  ['Sneakers', 'Court Classic', 'Leather upper, cupsole.', '/products/court.svg', true, 899.0, 4],
  ['Sneakers', 'Runner Lite', 'Mesh upper, foam midsole.', null, true, 749.0, 3],
  ['Sneakers', 'Canvas Low', 'Canvas upper, vulcanised sole.', '/products/canvas.svg', true, 449.0, 6],
  ['School Shoes', 'School Lace-Up', 'Genuine leather, scuff resistant.', '/products/school-lace.svg', true, 629.0, 5],
  ['School Shoes', 'School Buckle', 'Discontinued line — hidden from the storefront.', '/products/school-buckle.svg', false, 579.0, 2],
  ['Sandals', 'Beach Slide', 'EVA slide, quick dry.', '/products/slide.svg', true, 199.0, 8],
];

// ---------------------------------------------------------------------------
// Wipe
// ---------------------------------------------------------------------------

console.log('ChopChop seed\n');
process.stdout.write('  clearing previous demo data ... ');

ok('delete tenants', await db.from('tenants').delete().in('slug', DEMO_SLUGS));

const { data: userPage, error: listError } = await db.auth.admin.listUsers({
  page: 1,
  perPage: 1000,
});
if (listError) {
  console.error(`\n  listUsers failed: ${listError.message}`);
  process.exit(1);
}
const demoEmails = Object.values(DEMO_USERS).map((u) => u.email);
for (const user of userPage.users.filter((u) => demoEmails.includes(u.email))) {
  const { error } = await db.auth.admin.deleteUser(user.id);
  if (error) {
    console.error(`\n  deleteUser(${user.email}) failed: ${error.message}`);
    process.exit(1);
  }
}

// Anonymous buyers accumulate in auth.users — SCHEMA.md flags this as needing
// periodic cleanup. The tenant wipe above has just orphaned every buyer whose
// orders lived in a demo tenant, so sweep those. An anonymous user still
// attached to an order is left alone.
const { data: liveOrders } = await db.from('orders').select('buyer_id').not('buyer_id', 'is', null);
const stillReferenced = new Set((liveOrders ?? []).map((o) => o.buyer_id));
let sweptBuyers = 0;
for (const user of userPage.users) {
  if (!user.is_anonymous || stillReferenced.has(user.id)) continue;
  const { error } = await db.auth.admin.deleteUser(user.id);
  if (error) {
    console.error(`\n  deleteUser(anonymous ${user.id}) failed: ${error.message}`);
    process.exit(1);
  }
  sweptBuyers += 1;
}
console.log(`done (${sweptBuyers} orphaned anonymous buyer(s) swept)`);

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * @param {object} tenantRow
 * @param {string} email
 * @param {[string, number][]} categoryRows
 */
async function createTenant(tenantRow, email, categoryRows) {
  const [tenant] = ok(
    `insert tenant ${tenantRow.slug}`,
    await db.from('tenants').insert(tenantRow).select(),
  );

  const { data: created, error: userError } = await db.auth.admin.createUser({
    email,
    password: DEMO_PASSWORD,
    email_confirm: true,
  });
  if (userError) {
    console.error(`\n  createUser(${email}) failed: ${userError.message}`);
    process.exit(1);
  }

  ok(
    `insert tenant_user ${email}`,
    await db.from('tenant_users').insert({
      tenant_id: tenant.id,
      user_id: created.user.id,
      role: 'owner',
    }),
  );

  const categories = ok(
    `insert categories ${tenantRow.slug}`,
    await db
      .from('categories')
      .insert(categoryRows.map(([name, sort_order]) => ({
        tenant_id: tenant.id,
        name,
        sort_order,
        active: true,
      })))
      .select(),
  );

  return { tenant, categoryByName: Object.fromEntries(categories.map((c) => [c.name, c.id])) };
}

const b = await createTenant(butchery, DEMO_USERS.butchery.email, butcheryCategories);
const s = await createTenant(shoes, DEMO_USERS.shoes.email, shoesCategories);

// --- butchery items + variants ---------------------------------------------
// stock_mode = availability: `stock` is ignored, `available` is the only signal.

const butcheryItemRows = ok(
  'insert butchery items',
  await db
    .from('items')
    .insert(butcheryItems.map(([category, name, description, image_url, active], i) => ({
      tenant_id: b.tenant.id,
      category_id: b.categoryByName[category],
      name,
      description,
      image_url,
      active,
      sort_order: i + 1,
    })))
    .select(),
);

const butcheryVariantRows = [];
butcheryItems.forEach(([, name, , , , prices], i) => {
  const item = butcheryItemRows.find((r) => r.name === name);
  variantCombos(butcherySchema).forEach((attributes, j) => {
    butcheryVariantRows.push({
      tenant_id: b.tenant.id,
      item_id: item.id,
      attributes,
      price: prices[attributes.unit],
      stock: 0,
      // one variant deliberately out of stock, so the greyed-out state has data
      available: !(i === 4 && j === 1),
      sku: `BUT-${String(i + 1).padStart(2, '0')}-${attributes.unit === 'per kg' ? 'KG' : 'PK'}`,
    });
  });
});
ok('insert butchery variants', await db.from('variants').insert(butcheryVariantRows));

// --- shoes items + variants -------------------------------------------------
// stock_mode = counted: full 3 x 3 grid per item, stock decrements on confirm.

const shoesItemRows = ok(
  'insert shoes items',
  await db
    .from('items')
    .insert(shoesItems.map(([category, name, description, image_url, active], i) => ({
      tenant_id: s.tenant.id,
      category_id: s.categoryByName[category],
      name,
      description,
      image_url,
      active,
      sort_order: i + 1,
    })))
    .select(),
);

const shoesVariantRows = [];
shoesItems.forEach(([, name, , , , price, baseStock], i) => {
  const item = shoesItemRows.find((r) => r.name === name);
  variantCombos(shoesSchema).forEach((attributes, j) => {
    // vary the count so some combinations are legitimately sold out
    const stock = Math.max(0, baseStock - (j % 4));
    shoesVariantRows.push({
      tenant_id: s.tenant.id,
      item_id: item.id,
      attributes,
      price,
      stock,
      available: stock > 0,
      sku: `SHO-${String(i + 1).padStart(2, '0')}-${attributes.size}-${attributes.colour.slice(0, 3).toUpperCase()}`,
    });
  });
});
ok('insert shoes variants', await db.from('variants').insert(shoesVariantRows));

// ---------------------------------------------------------------------------
// Orders — two per tenant at different statuses, including a `sent` order that
// will never be confirmed. That is the phantom the dashboard has to let the
// seller dismiss.
//
// Every order carries a buyer_id: that is the buyer's anonymous auth session,
// and it is what their status page reads and subscribes to.
// ---------------------------------------------------------------------------

const butcheryBuyerId = await createAnonymousBuyer('demo-butchery');
const shoesBuyerId = await createAnonymousBuyer('demo-shoes');

/** Look up a seeded variant by item name and attributes. */
async function variantId(tenantId, itemName, attributes) {
  const [row] = ok(
    `lookup variant ${itemName}`,
    await db
      .from('variants')
      .select('id, item_id, items!inner(name)')
      .eq('tenant_id', tenantId)
      .eq('items.name', itemName)
      .contains('attributes', attributes),
  );
  return row.id;
}

async function createOrder(tenantId, order, lines) {
  const [row] = ok(
    `insert order ${order.reference}`,
    await db.from('orders').insert({ tenant_id: tenantId, ...order }).select(),
  );
  ok(
    `insert order_items ${order.reference}`,
    await db.from('order_items').insert(lines.map((l) => ({
      tenant_id: tenantId,
      order_id: row.id,
      ...l,
    }))),
  );
  return row;
}

const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();

// demo-butchery — weight. Totals are estimates until the seller weighs.
await createOrder(
  b.tenant.id,
  {
    reference: 'A47',
    buyer_id: butcheryBuyerId,
    customer_name: 'Thandi Mokoena',
    customer_phone: '27835551212',
    fulfilment: 'collect',
    notes: 'Chops cut thick please',
    status: 'sent', // never confirmed — the phantom
    total: 649.75,
    created_at: hoursAgo(30),
  },
  [
    {
      variant_id: await variantId(b.tenant.id, 'Lamb Chops', { unit: 'per kg' }),
      name_snapshot: 'Lamb Chops — per kg',
      price_snapshot: 259.9,
      qty: 2.0,
      qty_confirmed: null,
      line_total: 519.8,
    },
    {
      variant_id: await variantId(b.tenant.id, 'Boerewors', { unit: 'per pack' }),
      name_snapshot: 'Boerewors — per pack',
      price_snapshot: 59.95,
      qty: 2.0,
      qty_confirmed: null,
      line_total: 119.9,
    },
  ],
);

await createOrder(
  b.tenant.id,
  {
    reference: 'A48',
    buyer_id: butcheryBuyerId,
    customer_name: 'Pieter van Wyk',
    customer_phone: '27826667777',
    fulfilment: 'collect',
    notes: null,
    status: 'completed',
    // weighed heavier than ordered — this is why qty_confirmed exists
    total: 340.94,
    created_at: hoursAgo(26),
    confirmed_at: hoursAgo(25),
    completed_at: hoursAgo(22),
  },
  [
    {
      variant_id: await variantId(b.tenant.id, 'Rump Steak', { unit: 'per kg' }),
      name_snapshot: 'Rump Steak — per kg',
      price_snapshot: 189.9,
      qty: 1.5,
      qty_confirmed: 1.62,
      line_total: 307.64,
    },
    {
      variant_id: await variantId(b.tenant.id, 'Beef Mince', { unit: 'per pack' }),
      name_snapshot: 'Beef Mince — per pack',
      price_snapshot: 64.95,
      qty: 0.5,
      qty_confirmed: 0.51,
      line_total: 33.3,
    },
  ],
);

// demo-shoes — unit. Whole numbers, the total is final.
await createOrder(
  s.tenant.id,
  {
    reference: 'S12',
    buyer_id: shoesBuyerId,
    customer_name: 'Aisha Patel',
    customer_phone: '27842223333',
    fulfilment: 'local_delivery',
    notes: 'Deliver after 17:00',
    status: 'sent', // never confirmed
    total: 1348.0,
    created_at: hoursAgo(20),
  },
  [
    {
      variant_id: await variantId(s.tenant.id, 'Court Classic', { size: '8', colour: 'white' }),
      name_snapshot: 'Court Classic — 8 / white',
      price_snapshot: 899.0,
      qty: 1,
      qty_confirmed: null,
      line_total: 899.0,
    },
    {
      variant_id: await variantId(s.tenant.id, 'Canvas Low', { size: '7', colour: 'red' }),
      name_snapshot: 'Canvas Low — 7 / red',
      price_snapshot: 449.0,
      qty: 1,
      qty_confirmed: null,
      line_total: 449.0,
    },
  ],
);

await createOrder(
  s.tenant.id,
  {
    reference: 'S13',
    buyer_id: shoesBuyerId,
    customer_name: 'Sipho Dlamini',
    customer_phone: '27718889999',
    fulfilment: 'local_delivery',
    notes: null,
    status: 'ready',
    total: 1258.0,
    created_at: hoursAgo(8),
    confirmed_at: hoursAgo(7),
  },
  [
    {
      variant_id: await variantId(s.tenant.id, 'School Lace-Up', { size: '9', colour: 'black' }),
      name_snapshot: 'School Lace-Up — 9 / black',
      price_snapshot: 629.0,
      qty: 2,
      qty_confirmed: 2,
      line_total: 1258.0,
    },
  ],
);

// ---------------------------------------------------------------------------
// One pending import batch per tenant. Extraction output lands here for review
// and never writes to items or variants directly — the review gate is the whole
// point. Seeded mainly so the leak test's import_batches assertions have rows
// to fail on; an empty table passes every isolation check ever written.
// ---------------------------------------------------------------------------

ok(
  'insert import_batches',
  await db.from('import_batches').insert([
    {
      tenant_id: b.tenant.id,
      source: 'spreadsheet',
      status: 'pending',
      raw: [
        { name: 'Ribeye', unit: 'per kg', price: '219.90' },
        { name: 'Ribeye', unit: 'per pack', price: '109.95' },
        { name: 'Short Rib', unit: 'per kg', price: '149.90' },
      ],
    },
    {
      tenant_id: s.tenant.id,
      source: 'vision',
      status: 'pending',
      raw: [
        { name: 'Trail Mid', size: '7', colour: 'black', price: '1099.00' },
        { name: 'Trail Mid', size: '8', colour: 'black', price: '1099.00' },
      ],
    },
  ]),
);

// ---------------------------------------------------------------------------

console.log(`
  demo-butchery   ${butcheryCategories.length} categories, ${butcheryItems.length} items, ${butcheryVariantRows.length} variants, 2 orders, 1 import batch
  demo-shoes      ${shoesCategories.length} categories, ${shoesItems.length} items, ${shoesVariantRows.length} variants, 2 orders, 1 import batch

  logins          ${DEMO_USERS.butchery.email}
                  ${DEMO_USERS.shoes.email}
                  password from DEMO_USER_PASSWORD, or the default in scripts/demo-users.mjs

  buyers          2 anonymous auth users, one per tenant, attached to the orders above.
                  Their sessions are not reproducible — the leak test creates its own.

  Seeded. Now run: npm run test:leak
`);
