// Seed orders for the queue.
//
//   node scripts/seed-orders.mjs          create
//   node scripts/seed-orders.mjs --down   remove
//
// Nothing creates an order until ticket 05 builds the storefront checkout, so
// the queue has nothing to render without this.
//
// Reversible by construction: every order it writes carries a reference
// starting with the marker below, and --down deletes exactly those. Order lines
// go with them by cascade. It touches nothing else — the orders seeded by
// seed.mjs (A47, A48, S12, S13) are left alone.
//
// Lines are written the way a real checkout will write them: name_snapshot
// carries the full variant label the buyer chose, and price_snapshot is the
// price at the time. Ticket 05 inherits that rule; this is where it starts
// being true.

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { DEMO_USERS } from './demo-users.mjs';

/** Every row this script creates is identifiable by this prefix. */
const MARKER = 'Q4-';

const url = process.env.VITE_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;

if (!url || !secret) {
  console.error('Missing VITE_SUPABASE_URL or SUPABASE_SECRET_KEY in .env');
  process.exit(1);
}

const db = createClient(url, secret, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const down = process.argv.includes('--down');

function ok(label, { data, error }) {
  if (error) {
    console.error(`\n  ${label} failed: ${error.message}`);
    process.exit(1);
  }
  return data;
}

const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();
const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

async function teardown() {
  const { data, error } = await db
    .from('orders')
    .delete()
    .like('reference', `${MARKER}%`)
    .select('id');

  if (error) {
    console.error(`  teardown failed: ${error.message}`);
    process.exit(1);
  }
  return (data ?? []).length;
}

if (down) {
  const removed = await teardown();
  console.log(`\n  Removed ${removed} seeded order(s) with the ${MARKER} marker.\n`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

console.log('ChopChop order seed\n');
process.stdout.write('  clearing previous run ... ');
console.log(`done (${await teardown()} removed)`);

/** Resolve a tenant plus a buyer identity and some real variants to sell. */
async function context(slug) {
  const tenant = ok(
    `lookup tenant ${slug}`,
    await db.from('tenants').select('id, name, sale_mode, fulfilment_mode').eq('slug', slug).single(),
  );

  // Reuse the anonymous buyer seed.mjs already attached to this tenant's
  // orders, so this script never creates auth users it would have to clean up.
  const existing = ok(
    `lookup buyer for ${slug}`,
    await db.from('orders').select('buyer_id').eq('tenant_id', tenant.id).not('buyer_id', 'is', null).limit(1),
  );
  const buyerId = existing[0]?.buyer_id ?? null;

  const variants = ok(
    `lookup variants for ${slug}`,
    await db
      .from('variants')
      .select('id, price, attributes, items!inner(name, active)')
      .eq('tenant_id', tenant.id)
      .eq('items.active', true),
  );

  if (variants.length === 0) {
    console.error(`\n  ${slug} has no sellable variants. Run: npm run db:seed`);
    process.exit(1);
  }

  return { tenant, buyerId, variants };
}

/** "Rump Steak — per kg". The full label the buyer chose, not just the product. */
function labelFor(variant) {
  const attributes = Object.values(variant.attributes ?? {});
  return attributes.length
    ? `${variant.items.name} — ${attributes.join(' / ')}`
    : variant.items.name;
}

const round = (value) => Math.round(value * 100) / 100;

/**
 * @param spec.lines  [{ variant, qty, qtyConfirmed }]
 */
async function createOrder(ctx, spec) {
  const lines = spec.lines.map(({ variant, qty, qtyConfirmed = null }) => {
    const price = Number(variant.price);
    return {
      variant_id: variant.id,
      name_snapshot: labelFor(variant),
      price_snapshot: price,
      qty,
      qty_confirmed: qtyConfirmed,
      line_total: round(price * (qtyConfirmed ?? qty)),
    };
  });

  const total = round(lines.reduce((sum, line) => sum + line.line_total, 0));

  const [order] = ok(
    `insert order ${spec.reference}`,
    await db
      .from('orders')
      .insert({
        tenant_id: ctx.tenant.id,
        buyer_id: ctx.buyerId,
        reference: spec.reference,
        customer_name: spec.customer,
        customer_phone: spec.phone,
        fulfilment: ctx.tenant.fulfilment_mode,
        notes: spec.notes ?? null,
        status: spec.status,
        total,
        created_at: spec.createdAt,
        confirmed_at: spec.confirmedAt ?? null,
        completed_at: spec.completedAt ?? null,
      })
      .select(),
  );

  ok(
    `insert lines for ${spec.reference}`,
    await db.from('order_items').insert(
      lines.map((line) => ({ tenant_id: ctx.tenant.id, order_id: order.id, ...line })),
    ),
  );

  return { reference: spec.reference, status: spec.status, lines: lines.length };
}

const butchery = await context(DEMO_USERS.butchery.slug);
const shoes = await context(DEMO_USERS.shoes.slug);

const pick = (ctx, index) => ctx.variants[index % ctx.variants.length];

// --- demo-butchery — weight -------------------------------------------------
// The tenant whose lines get adjusted at confirmation: the buyer asks for 1kg
// and is charged for the 1.15kg actually cut.

const created = [];

created.push(
  // Backdated past the 24-hour window, so the staleness flag is visible without
  // waiting a day.
  await createOrder(butchery, {
    reference: `${MARKER}B1`,
    customer: 'Lerato Nkosi',
    phone: '27831110001',
    status: 'sent',
    createdAt: hoursAgo(31),
    notes: 'Sent from WhatsApp, never confirmed',
    lines: [
      { variant: pick(butchery, 0), qty: 1.5 },
      { variant: pick(butchery, 3), qty: 2 },
    ],
  }),

  // Minutes old, so the un-flagged case sits beside the flagged one.
  await createOrder(butchery, {
    reference: `${MARKER}B2`,
    customer: 'Johan Meyer',
    phone: '27831110002',
    status: 'sent',
    createdAt: minutesAgo(7),
    lines: [{ variant: pick(butchery, 1), qty: 0.75 }],
  }),

  await createOrder(butchery, {
    reference: `${MARKER}B3`,
    customer: 'Naledi Khumalo',
    phone: '27831110003',
    status: 'received',
    createdAt: hoursAgo(3),
    notes: 'Please cut thick',
    lines: [
      { variant: pick(butchery, 2), qty: 2.4 },
      { variant: pick(butchery, 4), qty: 1 },
      { variant: pick(butchery, 6), qty: 0.5 },
    ],
  }),

  // Confirmed: weighed heavier than ordered, which is why qty_confirmed exists.
  await createOrder(butchery, {
    reference: `${MARKER}B4`,
    customer: 'Sarah Adams',
    phone: '27831110004',
    status: 'confirmed',
    createdAt: hoursAgo(6),
    confirmedAt: hoursAgo(5),
    lines: [
      { variant: pick(butchery, 0), qty: 1, qtyConfirmed: 1.15 },
      { variant: pick(butchery, 5), qty: 2, qtyConfirmed: 1.88 },
    ],
  }),

  await createOrder(butchery, {
    reference: `${MARKER}B5`,
    customer: 'Ahmed Patel',
    phone: '27831110005',
    status: 'ready',
    createdAt: hoursAgo(9),
    confirmedAt: hoursAgo(8),
    lines: [{ variant: pick(butchery, 3), qty: 3, qtyConfirmed: 3.2 }],
  }),

  await createOrder(butchery, {
    reference: `${MARKER}B6`,
    customer: 'Grace Sithole',
    phone: '27831110006',
    status: 'completed',
    createdAt: hoursAgo(50),
    confirmedAt: hoursAgo(49),
    completedAt: hoursAgo(46),
    lines: [
      { variant: pick(butchery, 1), qty: 2, qtyConfirmed: 2.05 },
      { variant: pick(butchery, 2), qty: 1, qtyConfirmed: 0.98 },
    ],
  }),

  await createOrder(butchery, {
    reference: `${MARKER}B7`,
    customer: 'Unknown buyer',
    phone: '27831110007',
    status: 'cancelled',
    createdAt: hoursAgo(72),
    notes: 'Never arrived on WhatsApp',
    lines: [{ variant: pick(butchery, 4), qty: 1 }],
  }),
);

// --- demo-shoes — unit ------------------------------------------------------
// Whole numbers, and nothing is adjusted at confirmation. qty_confirmed stays
// null throughout, which is what a unit tenant looks like.

created.push(
  await createOrder(shoes, {
    reference: `${MARKER}S1`,
    customer: 'Zanele Dube',
    phone: '27832220001',
    status: 'sent',
    createdAt: hoursAgo(29),
    notes: 'Deliver after 17:00',
    lines: [
      { variant: pick(shoes, 0), qty: 1 },
      { variant: pick(shoes, 12), qty: 2 },
    ],
  }),

  await createOrder(shoes, {
    reference: `${MARKER}S2`,
    customer: 'Michael Botha',
    phone: '27832220002',
    status: 'sent',
    createdAt: minutesAgo(19),
    lines: [{ variant: pick(shoes, 5), qty: 1 }],
  }),

  await createOrder(shoes, {
    reference: `${MARKER}S3`,
    customer: 'Fatima Ismail',
    phone: '27832220003',
    status: 'received',
    createdAt: hoursAgo(2),
    lines: [
      { variant: pick(shoes, 9), qty: 1 },
      { variant: pick(shoes, 18), qty: 1 },
      { variant: pick(shoes, 27), qty: 3 },
    ],
  }),

  await createOrder(shoes, {
    reference: `${MARKER}S4`,
    customer: 'Tebogo Maluleke',
    phone: '27832220004',
    status: 'confirmed',
    createdAt: hoursAgo(5),
    confirmedAt: hoursAgo(4),
    lines: [{ variant: pick(shoes, 14), qty: 2 }],
  }),

  await createOrder(shoes, {
    reference: `${MARKER}S5`,
    customer: 'Chloe van Zyl',
    phone: '27832220005',
    status: 'ready',
    createdAt: hoursAgo(11),
    confirmedAt: hoursAgo(10),
    lines: [
      { variant: pick(shoes, 21), qty: 1 },
      { variant: pick(shoes, 30), qty: 1 },
    ],
  }),

  await createOrder(shoes, {
    reference: `${MARKER}S6`,
    customer: 'Sipho Ndlovu',
    phone: '27832220006',
    status: 'completed',
    createdAt: hoursAgo(60),
    confirmedAt: hoursAgo(59),
    completedAt: hoursAgo(55),
    lines: [{ variant: pick(shoes, 3), qty: 2 }],
  }),

  await createOrder(shoes, {
    reference: `${MARKER}S7`,
    customer: 'Unknown buyer',
    phone: '27832220007',
    status: 'cancelled',
    createdAt: hoursAgo(80),
    lines: [{ variant: pick(shoes, 7), qty: 1 }],
  }),
);

const byStatus = created.reduce((counts, order) => {
  counts[order.status] = (counts[order.status] ?? 0) + 1;
  return counts;
}, {});

console.log(`
  ${created.length} orders across both demo tenants
  ${Object.entries(byStatus).map(([status, count]) => `${status} ${count}`).join(' · ')}

  ${MARKER}B1 is backdated 31 hours — it carries the staleness flag.
  ${MARKER}B2 is 7 minutes old — it does not.

  Reverse with: node scripts/seed-orders.mjs --down
`);
