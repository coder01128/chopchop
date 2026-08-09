// Tenant leak test — release gate.
//
//   npm run test:leak
//
// Authenticate as demo-butchery, query all eight tables, assert zero rows
// belonging to demo-shoes. Then the same in the opposite direction. Then, as an
// anonymous client, assert the storefront can read the catalogue and nothing
// else.
//
// A passing run written by the same session that wrote the policies is not
// evidence. Brad runs this and reads the output himself, before any client
// goes live.
//
// Requires: migrations applied (npm run db:push) and seed data (npm run db:seed).

import 'dotenv/config';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { DEMO_PASSWORD, DEMO_USERS } from '../scripts/demo-users.mjs';

const url = process.env.VITE_SUPABASE_URL;
const publishableKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const secretKey = process.env.SUPABASE_SECRET_KEY;

if (!url || !publishableKey || !secretKey) {
  throw new Error(
    'Missing VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY or SUPABASE_SECRET_KEY in .env',
  );
}

/**
 * The eight tables, and the column on each that carries the tenant. `tenants`
 * is keyed on `id`; everything else on `tenant_id`. If a table is ever added to
 * the schema without being added here, that is the gap this list exists to make
 * obvious.
 */
const TABLES = [
  { table: 'tenants', tenantColumn: 'id' },
  { table: 'tenant_users', tenantColumn: 'tenant_id' },
  { table: 'categories', tenantColumn: 'tenant_id' },
  { table: 'items', tenantColumn: 'tenant_id' },
  { table: 'variants', tenantColumn: 'tenant_id' },
  { table: 'orders', tenantColumn: 'tenant_id' },
  { table: 'order_items', tenantColumn: 'tenant_id' },
  { table: 'import_batches', tenantColumn: 'tenant_id' },
] as const;

/** Tables no anonymous buyer has any business reading at all. */
const ANON_FORBIDDEN_READS = [
  'tenant_users',
  'orders',
  'order_items',
  'import_batches',
] as const;

// service-role client: bypasses RLS. Used only to resolve ids and to build the
// inactive-tenant fixture — never to assert an access decision.
const admin = createClient(url, secretKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function anonClient(): SupabaseClient {
  return createClient(url!, publishableKey!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function signIn(email: string): Promise<SupabaseClient> {
  const client = anonClient();
  const { error } = await client.auth.signInWithPassword({
    email,
    password: DEMO_PASSWORD,
  });
  if (error) {
    throw new Error(
      `Could not sign in as ${email}: ${error.message}. Has the seed been run? (npm run db:seed)`,
    );
  }
  return client;
}

let butcheryId: string;
let shoesId: string;
let butcheryClient: SupabaseClient;
let shoesClient: SupabaseClient;
let inactiveTenantId: string;
let inactiveItemId: string;
let butcheryOrderId: string;

beforeAll(async () => {
  const { data: tenants, error } = await admin
    .from('tenants')
    .select('id, slug')
    .in('slug', [DEMO_USERS.butchery.slug, DEMO_USERS.shoes.slug]);

  if (error) throw new Error(`Could not read tenants: ${error.message}`);

  butcheryId = tenants!.find((t) => t.slug === DEMO_USERS.butchery.slug)!.id;
  shoesId = tenants!.find((t) => t.slug === DEMO_USERS.shoes.slug)!.id;
  if (!butcheryId || !shoesId) {
    throw new Error('Demo tenants not found. Run: npm run db:seed');
  }

  const { data: order } = await admin
    .from('orders')
    .select('id')
    .eq('tenant_id', butcheryId)
    .limit(1)
    .single();
  butcheryOrderId = order!.id;

  const { data: inactiveItem } = await admin
    .from('items')
    .select('id')
    .eq('tenant_id', butcheryId)
    .eq('active', false)
    .limit(1)
    .single();
  inactiveItemId = inactiveItem!.id;

  // Fixture: an inactive tenant holding an *active* item. The item's own flag
  // must not be enough to expose it — the tenant gate has to hold too.
  const { data: hidden, error: hiddenError } = await admin
    .from('tenants')
    .insert({
      slug: `leak-test-inactive-${Date.now()}`,
      name: 'Leak Test Inactive Tenant',
      active: false,
      attribute_schema: [],
      branding: {},
    })
    .select()
    .single();
  if (hiddenError) throw new Error(`Could not create fixture tenant: ${hiddenError.message}`);
  inactiveTenantId = hidden!.id;

  const { data: cat } = await admin
    .from('categories')
    .insert({ tenant_id: inactiveTenantId, name: 'Hidden', sort_order: 1, active: true })
    .select()
    .single();
  const { data: item } = await admin
    .from('items')
    .insert({ tenant_id: inactiveTenantId, category_id: cat!.id, name: 'Hidden Item', active: true })
    .select()
    .single();
  await admin
    .from('variants')
    .insert({ tenant_id: inactiveTenantId, item_id: item!.id, attributes: {}, price: 10, available: true });

  butcheryClient = await signIn(DEMO_USERS.butchery.email);
  shoesClient = await signIn(DEMO_USERS.shoes.email);
});

afterAll(async () => {
  if (inactiveTenantId) {
    await admin.from('tenants').delete().eq('id', inactiveTenantId);
  }
  await butcheryClient?.auth.signOut();
  await shoesClient?.auth.signOut();
});

/**
 * The core assertion, run in both directions. Reads every table as `self` and
 * fails naming the table, the row count and the offending ids.
 */
function describeLeakDirection(
  label: string,
  self: () => { client: SupabaseClient; id: string },
  other: () => { name: string; id: string },
) {
  describe(label, () => {
    for (const { table, tenantColumn } of TABLES) {
      it(`${table}: returns no ${other().name} rows`, async () => {
        const { client } = self();
        const { data, error } = await client.from(table).select('*');

        // A read denied outright is a pass — no rows crossed the boundary.
        if (error) {
          expect(
            data ?? [],
            `LEAK CHECK ${table}: query errored AND returned rows — ${error.message}`,
          ).toEqual([]);
          return;
        }

        const foreign = (data ?? []).filter(
          (row: Record<string, unknown>) => row[tenantColumn] === other().id,
        );

        expect(
          foreign,
          `TENANT LEAK in "${table}": ${foreign.length} row(s) belonging to ` +
            `${other().name} (${other().id}) were visible to ${label}. ` +
            `Offending ids: ${foreign.map((r: Record<string, unknown>) => r.id).join(', ')}`,
        ).toHaveLength(0);
      });
    }

    it('sees its own rows (guards against a policy that returns nothing)', async () => {
      const { client, id } = self();
      const { data, error } = await client.from('items').select('id').eq('tenant_id', id);
      expect(error, `own-rows read failed: ${error?.message}`).toBeNull();
      expect(
        (data ?? []).length,
        'This tenant sees zero of its own items — the leak assertions above are ' +
          'passing vacuously. Fix the policy or the seed before trusting them.',
      ).toBeGreaterThan(0);
    });
  });
}

describeLeakDirection(
  'authenticated as demo-butchery',
  () => ({ client: butcheryClient, id: butcheryId }),
  () => ({ name: 'demo-shoes', id: shoesId }),
);

describeLeakDirection(
  'authenticated as demo-shoes',
  () => ({ client: shoesClient, id: shoesId }),
  () => ({ name: 'demo-butchery', id: butcheryId }),
);

/**
 * Orders specifically. The tenant-against-tenant sweep above proves tenant A
 * cannot *read* tenant B's orders; these prove it cannot write or move them
 * either. A silent no-op is the expected shape — RLS filters the row out, so
 * the UPDATE matches nothing rather than erroring.
 */
describe('orders are not writable across tenants', () => {
  let shoesOrderId: string;
  let shoesOrderStatus: string;
  let shoesLineId: string;

  beforeAll(async () => {
    const { data: order } = await admin
      .from('orders')
      .select('id, status')
      .eq('tenant_id', shoesId)
      .limit(1)
      .single();
    shoesOrderId = order!.id;
    shoesOrderStatus = order!.status;

    const { data: line } = await admin
      .from('order_items')
      .select('id')
      .eq('order_id', shoesOrderId)
      .limit(1)
      .single();
    shoesLineId = line!.id;
  });

  it('cannot transition another tenant\'s order', async () => {
    const { data } = await butcheryClient
      .from('orders')
      .update({ status: 'cancelled' })
      .eq('id', shoesOrderId)
      .select();
    expect(data ?? [], 'A seller moved another tenant\'s order.').toEqual([]);

    const { data: after } = await admin
      .from('orders')
      .select('status')
      .eq('id', shoesOrderId)
      .single();
    expect(
      after!.status,
      'CROSS-TENANT WRITE on "orders": the status of another tenant\'s order changed.',
    ).toBe(shoesOrderStatus);
  });

  it('cannot write qty_confirmed on another tenant\'s order line', async () => {
    const { data } = await butcheryClient
      .from('order_items')
      .update({ qty_confirmed: 999 })
      .eq('id', shoesLineId)
      .select();
    expect(data ?? [], 'A seller wrote a weighed quantity onto another tenant\'s order.').toEqual([]);

    const { data: after } = await admin
      .from('order_items')
      .select('qty_confirmed')
      .eq('id', shoesLineId)
      .single();
    expect(Number(after!.qty_confirmed ?? 0)).not.toBe(999);
  });

  it('cannot delete another tenant\'s order', async () => {
    const { data } = await butcheryClient.from('orders').delete().eq('id', shoesOrderId).select();
    expect(data ?? [], 'A seller deleted another tenant\'s order.').toEqual([]);

    const { count } = await admin
      .from('orders')
      .select('*', { count: 'exact', head: true })
      .eq('id', shoesOrderId);
    expect(count, 'Another tenant\'s order was deleted.').toBe(1);
  });

  it('can move its own order, and put it back', async () => {
    // Guards against the assertions above passing because *nothing* can be
    // updated — the leak test's recurring failure mode.
    const { data: own } = await admin
      .from('orders')
      .select('id, status')
      .eq('tenant_id', butcheryId)
      .eq('status', 'sent')
      .limit(1)
      .single();

    const { data: moved } = await butcheryClient
      .from('orders')
      .update({ status: 'received' })
      .eq('id', own!.id)
      .select();
    expect(moved ?? [], 'A seller cannot move their own order — the checks above are vacuous.')
      .toHaveLength(1);

    await admin.from('orders').update({ status: own!.status }).eq('id', own!.id);
  });
});

describe('anonymous storefront', () => {
  it('cannot list orders', async () => {
    const anon = anonClient();
    const { data, error } = await anon.from('orders').select('*');
    expect(
      data ?? [],
      `ORDERS ARE LISTABLE ANONYMOUSLY: ${(data ?? []).length} row(s) returned. ` +
        'Anonymous access to orders is INSERT only; the status page reads a ' +
        'single order through the get_order() function.',
    ).toEqual([]);
    // Either shape is acceptable — denied, or permitted but empty.
    expect(error === null || (data ?? []).length === 0).toBe(true);
  });

  for (const table of ANON_FORBIDDEN_READS) {
    it(`cannot read ${table}`, async () => {
      const anon = anonClient();
      const { data, error } = await anon.from(table).select('*');
      expect(
        data ?? [],
        `ANONYMOUS READ ALLOWED on "${table}": ${(data ?? []).length} row(s) returned. ` +
          'Only categories, items and variants are public.',
      ).toEqual([]);
      // Defence in depth: anon should not hold the grant either, so this must
      // be refused outright rather than returning an empty set via RLS.
      expect(
        error,
        `anon holds a SELECT grant on "${table}" — RLS returned nothing, but the ` +
          'privilege should not exist at all.',
      ).not.toBeNull();
    });
  }

  it('does not return inactive items', async () => {
    const anon = anonClient();
    const { data, error } = await anon.from('items').select('id, active');
    expect(error, `anonymous items read failed: ${error?.message}`).toBeNull();

    const inactive = (data ?? []).filter((r) => r.active === false);
    expect(
      inactive,
      `INACTIVE ITEMS VISIBLE in "items": ${inactive.length} row(s) with active = false ` +
        'were returned to an anonymous client.',
    ).toHaveLength(0);
    expect(
      (data ?? []).some((r) => r.id === inactiveItemId),
      `The known inactive item ${inactiveItemId} was returned anonymously.`,
    ).toBe(false);
  });

  it('does not return anything belonging to an inactive tenant', async () => {
    const anon = anonClient();
    for (const table of ['tenants', 'categories', 'items', 'variants'] as const) {
      const column = table === 'tenants' ? 'id' : 'tenant_id';
      const { data } = await anon.from(table).select('*').eq(column, inactiveTenantId);
      expect(
        data ?? [],
        `INACTIVE TENANT LEAK in "${table}": ${(data ?? []).length} row(s) from a ` +
          'tenant with active = false were returned anonymously.',
      ).toEqual([]);
    }
  });

  it('can read the public catalogue', async () => {
    const anon = anonClient();
    const { data: tenants, error: tenantError } = await anon
      .from('tenants')
      .select('id, slug, name, branding, attribute_schema, sale_mode')
      .eq('slug', DEMO_USERS.butchery.slug);
    expect(tenantError, `anonymous tenant read failed: ${tenantError?.message}`).toBeNull();
    expect(tenants ?? []).toHaveLength(1);

    const { data: variants, error: variantError } = await anon
      .from('variants')
      .select('id, price, attributes')
      .eq('tenant_id', butcheryId);
    expect(variantError, `anonymous variant read failed: ${variantError?.message}`).toBeNull();
    expect((variants ?? []).length).toBeGreaterThan(0);
  });

  it('cannot read tenants.created_at (column grant)', async () => {
    const anon = anonClient();
    const { error } = await anon.from('tenants').select('created_at').limit(1);
    expect(
      error,
      'anon was able to select tenants.created_at — the column grant is not in force',
    ).not.toBeNull();
  });

  it('cannot place an order — the anon role has no orders grant at all', async () => {
    const anon = anonClient();
    const { error } = await anon.from('orders').insert({
      tenant_id: butcheryId,
      reference: `X-${Date.now()}`,
      customer_name: 'Leak Test',
      customer_phone: '27820000000',
      fulfilment: 'collect',
      total: 0,
    });
    expect(
      error,
      'The anon role can still insert orders. Buyers are anonymous auth users ' +
        'now; the anon grants on orders were dropped in migration 0005.',
    ).not.toBeNull();
  });

  it('no longer exposes get_order()', async () => {
    const anon = anonClient();
    const { error } = await anon.rpc('get_order', { p_order_id: butcheryOrderId });
    expect(
      error,
      'get_order() is still callable. It was replaced by a buyer_id policy so ' +
        'the status page can use Realtime instead of polling.',
    ).not.toBeNull();
  });
});

/**
 * Buyer sessions.
 *
 * A buyer is an anonymous auth user, which means it holds the `authenticated`
 * role — the same role as every dashboard login. Permissive policies combine
 * with OR, so the whole of this block exists to prove that being authenticated
 * buys a buyer nothing beyond the public catalogue and their own orders.
 */
describe('buyer sessions (anonymous auth users)', () => {
  const createdOrders: string[] = [];
  const createdBuyers: string[] = [];

  let buyerA: SupabaseClient;
  let buyerAId: string;
  let buyerB: SupabaseClient;
  let buyerBId: string;
  let orderA: string;
  let orderB: string;

  async function newBuyer(): Promise<[SupabaseClient, string]> {
    const client = anonClient();
    const { data, error } = await client.auth.signInAnonymously();
    if (error) {
      throw new Error(
        `Anonymous sign-in failed: ${error.message}. Enable it in the Supabase ` +
          'dashboard: Authentication -> Sign In / Up -> Anonymous sign-ins.',
      );
    }
    createdBuyers.push(data.user!.id);
    return [client, data.user!.id];
  }

  /** Place an order the way the storefront will: as the buyer, in one session. */
  async function place(
    client: SupabaseClient,
    buyerId: string,
    tenantId: string,
    label: string,
  ): Promise<string> {
    const orderId = crypto.randomUUID();
    const { data: variant } = await admin
      .from('variants')
      .select('id, price')
      .eq('tenant_id', tenantId)
      .limit(1)
      .single();

    const { error: orderError } = await client.from('orders').insert({
      id: orderId,
      tenant_id: tenantId,
      buyer_id: buyerId,
      reference: `LT-${label}-${Date.now().toString().slice(-6)}`,
      customer_name: `Leak Test Buyer ${label}`,
      customer_phone: '27820000000',
      fulfilment: 'collect',
      notes: 'placed by tenant-leak.test.ts',
      total: variant!.price,
    });
    if (orderError) throw new Error(`buyer ${label} could not place an order: ${orderError.message}`);
    createdOrders.push(orderId);

    const { error: lineError } = await client.from('order_items').insert({
      tenant_id: tenantId,
      order_id: orderId,
      variant_id: variant!.id,
      name_snapshot: `Leak Test Line ${label}`,
      price_snapshot: variant!.price,
      qty: 1,
      line_total: variant!.price,
    });
    if (lineError) throw new Error(`buyer ${label} could not add a line: ${lineError.message}`);

    return orderId;
  }

  beforeAll(async () => {
    [buyerA, buyerAId] = await newBuyer();
    [buyerB, buyerBId] = await newBuyer();
    orderA = await place(buyerA, buyerAId, butcheryId, 'A');
    orderB = await place(buyerB, buyerBId, shoesId, 'B');
  });

  afterAll(async () => {
    for (const id of createdOrders) await admin.from('orders').delete().eq('id', id);
    for (const id of createdBuyers) await admin.auth.admin.deleteUser(id);
    await buyerA?.auth.signOut();
    await buyerB?.auth.signOut();
  });

  it('reads its own order, with its lines', async () => {
    const { data, error } = await buyerA.from('orders').select('*').eq('id', orderA);
    expect(error, `buyer could not read its own order: ${error?.message}`).toBeNull();
    expect(data ?? [], 'A buyer cannot see the order it just placed.').toHaveLength(1);

    const { data: lines } = await buyerA.from('order_items').select('*').eq('order_id', orderA);
    expect((lines ?? []).length, 'A buyer cannot see its own order lines.').toBeGreaterThan(0);
  });

  it('listing orders unfiltered returns nothing but its own', async () => {
    const { data, error } = await buyerA.from('orders').select('*');
    expect(error, `unfiltered buyer order read failed: ${error?.message}`).toBeNull();

    const foreign = (data ?? []).filter((row) => row.buyer_id !== buyerAId);
    expect(
      foreign,
      `BUYER CAN LIST OTHER ORDERS: ${foreign.length} row(s) not belonging to this ` +
        `buyer were returned from "orders". Offending ids: ${foreign.map((r) => r.id).join(', ')}`,
    ).toHaveLength(0);
    expect(
      (data ?? []).some((r) => r.id === orderA),
      'The buyer cannot see its own order in an unfiltered list.',
    ).toBe(true);
  });

  it('cannot read another buyer\'s order, even by id', async () => {
    const { data } = await buyerA.from('orders').select('*').eq('id', orderB);
    expect(
      data ?? [],
      `BUYER LEAK in "orders": buyer A read buyer B's order ${orderB} by id.`,
    ).toEqual([]);
  });

  it('cannot read another buyer\'s order lines', async () => {
    const { data } = await buyerA.from('order_items').select('*').eq('order_id', orderB);
    expect(
      data ?? [],
      `BUYER LEAK in "order_items": buyer A read lines from buyer B's order ${orderB}.`,
    ).toEqual([]);
  });

  it('cannot see the seeded demo orders', async () => {
    const { data } = await buyerA.from('orders').select('id, reference');
    const seeded = (data ?? []).filter((r) => ['A47', 'A48', 'S12', 'S13'].includes(r.reference));
    expect(
      seeded,
      `BUYER LEAK in "orders": seeded orders ${seeded.map((r) => r.reference).join(', ')} ` +
        'were visible to a buyer session.',
    ).toHaveLength(0);
  });

  // The grant exists (buyers hold `authenticated`), so these are empty results
  // rather than refusals. The restrictive policies are what produce them.
  for (const table of ['tenant_users', 'import_batches'] as const) {
    it(`reads nothing from ${table}`, async () => {
      const { data } = await buyerA.from(table).select('*');
      expect(
        data ?? [],
        `BUYER LEAK in "${table}": ${(data ?? []).length} row(s) reached a buyer ` +
          'session. The restrictive not-anonymous policy is not holding.',
      ).toEqual([]);
    });
  }

  it('reads the public catalogue and nothing more from it', async () => {
    const { data: items, error } = await buyerA.from('items').select('id, active, tenant_id');
    expect(error, `buyer catalogue read failed: ${error?.message}`).toBeNull();
    expect((items ?? []).length, 'A buyer session sees an empty catalogue.').toBeGreaterThan(0);

    const inactive = (items ?? []).filter((r) => r.active === false);
    expect(
      inactive,
      `INACTIVE ITEMS VISIBLE to a buyer session: ${inactive.length} row(s).`,
    ).toHaveLength(0);

    for (const table of ['tenants', 'categories', 'items', 'variants'] as const) {
      const column = table === 'tenants' ? 'id' : 'tenant_id';
      const { data } = await buyerA.from(table).select('*').eq(column, inactiveTenantId);
      expect(
        data ?? [],
        `INACTIVE TENANT LEAK in "${table}": rows reached a buyer session.`,
      ).toEqual([]);
    }
  });

  it('cannot place an order under another buyer\'s id', async () => {
    const { error } = await buyerA.from('orders').insert({
      id: crypto.randomUUID(),
      tenant_id: butcheryId,
      buyer_id: buyerBId,
      reference: `LT-STEAL-${Date.now().toString().slice(-6)}`,
      customer_name: 'Leak Test',
      customer_phone: '27820000000',
      fulfilment: 'collect',
      total: 0,
    });
    expect(
      error,
      'A buyer inserted an order under a different buyer_id. The status page is ' +
        'keyed on buyer_id — that is somebody else\'s order history.',
    ).not.toBeNull();
  });

  it('cannot place an order with no buyer_id at all', async () => {
    const { error } = await buyerA.from('orders').insert({
      id: crypto.randomUUID(),
      tenant_id: butcheryId,
      reference: `LT-NULL-${Date.now().toString().slice(-6)}`,
      customer_name: 'Leak Test',
      customer_phone: '27820000000',
      fulfilment: 'collect',
      total: 0,
    });
    expect(error, 'A buyer inserted an order with a null buyer_id.').not.toBeNull();
  });

  it('cannot set status, confirmed_at or completed_at when placing an order', async () => {
    for (const overrides of [
      { status: 'completed' },
      { status: 'confirmed' },
      { confirmed_at: new Date().toISOString() },
      { completed_at: new Date().toISOString() },
    ]) {
      const { error } = await buyerA.from('orders').insert({
        id: crypto.randomUUID(),
        tenant_id: butcheryId,
        buyer_id: buyerAId,
        reference: `LT-ST-${Math.random().toString(36).slice(2, 8)}`,
        customer_name: 'Leak Test',
        customer_phone: '27820000000',
        fulfilment: 'collect',
        total: 0,
        ...overrides,
      });
      expect(
        error,
        `A buyer placed an order with ${JSON.stringify(overrides)}. Revenue metrics ` +
          'run off `completed` — that value is the seller\'s to set.',
      ).not.toBeNull();
    }
  });

  it('cannot attach a line to somebody else\'s order', async () => {
    const { data: variant } = await admin
      .from('variants')
      .select('id, price')
      .eq('tenant_id', shoesId)
      .limit(1)
      .single();

    const { error } = await buyerA.from('order_items').insert({
      tenant_id: shoesId,
      order_id: orderB,
      variant_id: variant!.id,
      name_snapshot: 'Injected line',
      price_snapshot: 1,
      qty: 1,
      line_total: 1,
    });
    expect(error, 'A buyer added a line to another buyer\'s order.').not.toBeNull();
  });

  it('cannot place an order against an inactive tenant', async () => {
    const { error } = await buyerA.from('orders').insert({
      id: crypto.randomUUID(),
      tenant_id: inactiveTenantId,
      buyer_id: buyerAId,
      reference: `LT-INACT-${Date.now().toString().slice(-6)}`,
      customer_name: 'Leak Test',
      customer_phone: '27820000000',
      fulfilment: 'collect',
      total: 0,
    });
    expect(error, 'An order was placed against a tenant with active = false.').not.toBeNull();
  });

  it('cannot update or cancel its own order once sent', async () => {
    const { data } = await buyerA
      .from('orders')
      .update({ status: 'completed' })
      .eq('id', orderA)
      .select();
    expect(
      data ?? [],
      'A buyer updated its own order. Once sent, an order is the seller\'s to move.',
    ).toEqual([]);

    const { data: after } = await admin.from('orders').select('status').eq('id', orderA).single();
    expect(after!.status, 'The order status changed despite the update being refused.').toBe('sent');
  });

  it('cannot delete its own order', async () => {
    const { data } = await buyerA.from('orders').delete().eq('id', orderA).select();
    expect(data ?? [], 'A buyer deleted its own order.').toEqual([]);

    const { count } = await admin
      .from('orders')
      .select('*', { count: 'exact', head: true })
      .eq('id', orderA);
    expect(count, 'The order was deleted despite the delete being refused.').toBe(1);
  });

  it('cannot write to the catalogue', async () => {
    const { error: itemError } = await buyerA.from('items').insert({
      tenant_id: butcheryId,
      name: 'Injected item',
      active: true,
    });
    expect(itemError, 'A buyer inserted an item.').not.toBeNull();

    const { error: categoryError } = await buyerA.from('categories').insert({
      tenant_id: butcheryId,
      name: 'Injected category',
      sort_order: 99,
      active: true,
    });
    expect(categoryError, 'A buyer inserted a category.').not.toBeNull();

    const { data: updated } = await buyerA
      .from('items')
      .update({ name: 'hacked' })
      .eq('tenant_id', butcheryId)
      .select();
    expect(updated ?? [], 'A buyer updated catalogue items.').toEqual([]);

    const { error: tenantError } = await buyerA.from('tenant_users').insert({
      tenant_id: butcheryId,
      user_id: buyerAId,
      role: 'owner',
    });
    expect(
      tenantError,
      'A buyer wrote itself a tenant_users row — that is the whole access model.',
    ).not.toBeNull();
  });

  /**
   * The one that actually tests the restrictive policies.
   *
   * Every assertion above would pass on the tenant lookup alone — a buyer has
   * no `tenant_users` row, so the permissive dashboard policies never match and
   * the restrictive ones are never load-bearing. This grants the buyer a real
   * `tenant_users` row through the service role, which makes every permissive
   * dashboard policy match. If the restrictive not-anonymous policies are wrong
   * or missing, this is where a buyer session inherits the whole tenant.
   */
  it('stays shut out even holding a tenant_users row', async () => {
    const { data: link, error: linkError } = await admin
      .from('tenant_users')
      .insert({ tenant_id: butcheryId, user_id: buyerAId, role: 'staff' })
      .select()
      .single();
    expect(linkError, `could not create the fixture link: ${linkError?.message}`).toBeNull();

    try {
      const { data: users } = await buyerA.from('tenant_users').select('*');
      expect(
        users ?? [],
        'RESTRICTIVE POLICY FAILED on "tenant_users": a buyer session with a ' +
          'tenant_users row read the tenant\'s user list.',
      ).toEqual([]);

      const { data: batches } = await buyerA.from('import_batches').select('*');
      expect(
        batches ?? [],
        'RESTRICTIVE POLICY FAILED on "import_batches": a buyer session read ' +
          'unreviewed extraction output.',
      ).toEqual([]);

      const { data: orders } = await buyerA.from('orders').select('*');
      const foreign = (orders ?? []).filter((o) => o.buyer_id !== buyerAId);
      expect(
        foreign,
        `RESTRICTIVE POLICY FAILED on "orders": ${foreign.length} order(s) belonging ` +
          'to other people reached a buyer session holding a tenant_users row.',
      ).toEqual([]);

      const { data: lines } = await buyerA.from('order_items').select('*');
      const foreignLines = (lines ?? []).filter((l) => l.order_id !== orderA);
      expect(
        foreignLines,
        'RESTRICTIVE POLICY FAILED on "order_items": lines from other people\'s ' +
          'orders reached a buyer session.',
      ).toEqual([]);

      const { data: items } = await buyerA.from('items').select('id, active');
      const hidden = (items ?? []).filter((i) => i.active === false);
      expect(
        hidden,
        'RESTRICTIVE POLICY FAILED on "items": a buyer session read inactive ' +
          'products it should never see.',
      ).toEqual([]);

      const { data: updated } = await buyerA
        .from('items')
        .update({ name: 'hacked' })
        .eq('tenant_id', butcheryId)
        .select();
      expect(
        updated ?? [],
        'RESTRICTIVE POLICY FAILED on "items": a buyer session wrote to the ' +
          'tenant\'s catalogue.',
      ).toEqual([]);
    } finally {
      await admin.from('tenant_users').delete().eq('id', link!.id);
    }
  });

  /**
   * The reason this ticket exists. get_order() could fetch one order, but a
   * function is not a subscription. Postgres Changes re-evaluates RLS per
   * subscriber, so this passing means both that `orders` is in the
   * supabase_realtime publication and that the buyer's policy lets the row
   * through to them.
   */
  it('receives Realtime updates for its own order', { retry: 2 }, async () => {
    // Reset first rather than only at the end: a timed-out attempt would
    // otherwise leave the order on `received` and the retry would assert
    // against a status it never saw change.
    await admin.from('orders').update({ status: 'sent' }).eq('id', orderA);

    const received = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              'No Realtime event arrived within 20s for the buyer\'s own order. ' +
                'Either "orders" is missing from the supabase_realtime publication, ' +
                'or the buyer\'s SELECT policy does not let the row through.',
            ),
          ),
        20_000,
      );

      const channel = buyerA
        .channel(`leak-test-order-${orderA}`)
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'orders', filter: `id=eq.${orderA}` },
          (payload) => {
            clearTimeout(timer);
            void buyerA.removeChannel(channel);
            resolve(payload.new as Record<string, unknown>);
          },
        )
        .subscribe(async (status) => {
          if (status === 'SUBSCRIBED') {
            // SUBSCRIBED is the client's view of the handshake; the server needs
            // a moment more to register the filter. Firing the update the
            // instant this resolves races it and the event is simply missed —
            // which is why this test carries a retry. A missed event here is a
            // slow socket, not a policy failure; the policy itself is asserted
            // synchronously above.
            await new Promise((r) => setTimeout(r, 2500));
            // The seller acknowledging the order, which is exactly what the
            // buyer's status page is waiting for.
            await admin.from('orders').update({ status: 'received' }).eq('id', orderA);
          }
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            clearTimeout(timer);
            reject(new Error(`Realtime subscription failed: ${status}`));
          }
        });
    });

    const row = await received;
    expect(row.id).toBe(orderA);
    expect(row.status, 'The Realtime payload did not carry the new status.').toBe('received');

    // put it back so the update/delete assertions above stay meaningful on re-run
    await admin.from('orders').update({ status: 'sent' }).eq('id', orderA);
  }, 30_000);
});
