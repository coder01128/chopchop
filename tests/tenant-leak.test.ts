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

  /**
   * confirm_order is the one call that moves stock, so a cross-tenant confirm
   * would not just corrupt another tenant's queue — it would empty their shelf.
   * SECURITY INVOKER means RLS still applies, and the membership check inside
   * the function means a foreign tenant_id is refused outright rather than
   * silently filtered to nothing.
   */
  it('cannot confirm another tenant\'s order', async () => {
    const { data: line } = await admin
      .from('order_items')
      .select('id, variant_id')
      .eq('id', shoesLineId)
      .single();
    const { data: before } = await admin
      .from('variants')
      .select('stock')
      .eq('id', line!.variant_id)
      .single();

    // Both shapes: a foreign tenant_id in the payload, and the caller's own
    // tenant_id pointed at somebody else's order.
    for (const payload of [
      { p_tenant_id: shoesId, p_order_id: shoesOrderId },
      { p_tenant_id: butcheryId, p_order_id: shoesOrderId },
    ]) {
      const { error } = await butcheryClient.rpc('confirm_order', {
        ...payload,
        p_lines: [{ id: shoesLineId, qty_confirmed: 99, line_total: 99 }],
      });
      expect(
        error,
        `CROSS-TENANT CONFIRM accepted for ${JSON.stringify(payload)}. confirm_order ` +
          'must refuse a foreign tenant explicitly.',
      ).not.toBeNull();
    }

    const { data: after } = await admin
      .from('orders')
      .select('status')
      .eq('id', shoesOrderId)
      .single();
    expect(
      after!.status,
      'CROSS-TENANT WRITE via confirm_order: another tenant\'s order was moved.',
    ).toBe(shoesOrderStatus);

    const { data: stock } = await admin
      .from('variants')
      .select('stock')
      .eq('id', line!.variant_id)
      .single();
    expect(
      Number(stock!.stock),
      'CROSS-TENANT STOCK MOVE via confirm_order: another tenant\'s count changed.',
    ).toBe(Number(before!.stock));
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

/**
 * Import (ticket 06). The commit path is three writes — the batch row, any
 * created categories, and one `save_product` call per product — so all three
 * are pointed at the other tenant here. A seller must not be able to import
 * into a business that is not theirs, and the `anon` role must not be able to
 * put anything into `import_batches` at all.
 */
describe('import is tenant-scoped', () => {
  const created: string[] = [];

  afterAll(async () => {
    if (created.length > 0) await admin.from('import_batches').delete().in('id', created);
    await admin.from('categories').delete().eq('name', 'Leak Test Category');
    await admin.from('items').delete().eq('name', 'Leak Test Import Product');
  });

  it('a seller cannot write a batch into another tenant', async () => {
    const { data, error } = await butcheryClient
      .from('import_batches')
      .insert({
        tenant_id: shoesId,
        source: 'spreadsheet',
        raw: [{ line: 2, name: 'Leak Test Import Product', price: 1 }],
        status: 'pending',
      })
      .select('id');

    for (const row of data ?? []) created.push(row.id);

    expect(
      error,
      'CROSS-TENANT IMPORT: a seller wrote an import batch into another tenant. ' +
        'The WITH CHECK on import_batches_authenticated_all is not holding.',
    ).not.toBeNull();
    expect(data ?? []).toEqual([]);
  });

  it('a seller cannot read another tenant\'s batches', async () => {
    const { data: seeded, error: seedError } = await admin
      .from('import_batches')
      .insert({
        tenant_id: shoesId,
        source: 'spreadsheet',
        raw: [{ line: 2, name: 'Leak Test Import Product', price: 1 }],
        status: 'pending',
      })
      .select('id')
      .single();
    expect(seedError, `could not create the fixture batch: ${seedError?.message}`).toBeNull();
    created.push(seeded!.id);

    const { data } = await butcheryClient.from('import_batches').select('*').eq('id', seeded!.id);
    expect(
      data ?? [],
      'TENANT LEAK in "import_batches": a seller read another tenant\'s unreviewed ' +
        'extraction output.',
    ).toEqual([]);

    // …and cannot move it either. A silent no-op is the expected shape.
    const { data: moved } = await butcheryClient
      .from('import_batches')
      .update({ status: 'applied' })
      .eq('id', seeded!.id)
      .select();
    expect(moved ?? [], 'A seller changed another tenant\'s import batch.').toEqual([]);
  });

  it('a seller cannot create a category in another tenant', async () => {
    const { data, error } = await butcheryClient
      .from('categories')
      .insert({ tenant_id: shoesId, name: 'Leak Test Category', sort_order: 99 })
      .select('id');

    expect(
      error,
      'CROSS-TENANT IMPORT: a seller created a category in another tenant. Import ' +
        'creates categories before it writes products.',
    ).not.toBeNull();
    expect(data ?? []).toEqual([]);
  });

  it('a seller cannot commit a product into another tenant', async () => {
    // The commit step calls save_product per item. It is SECURITY INVOKER and
    // checks membership explicitly, so this is a refusal, not an empty result.
    const { error } = await butcheryClient.rpc('save_product', {
      p_tenant_id: shoesId,
      p_item: { id: null, name: 'Leak Test Import Product', description: '', image_url: '', category_id: null, active: true },
      p_variants: [{ id: null, attributes: {}, price: 1, stock: 1, available: true, sku: '' }],
      p_removals: [],
    });

    expect(
      error,
      'CROSS-TENANT IMPORT: save_product accepted another tenant\'s id from a seller. ' +
        'Every product an import writes goes through this call.',
    ).not.toBeNull();

    const { count } = await admin
      .from('items')
      .select('*', { count: 'exact', head: true })
      .eq('name', 'Leak Test Import Product');
    expect(count, 'A product was written into another tenant by save_product.').toBe(0);
  });

  it('a seller can write a batch into its own tenant (the checks above are not vacuous)', async () => {
    const { data, error } = await butcheryClient
      .from('import_batches')
      .insert({
        tenant_id: butcheryId,
        source: 'spreadsheet',
        raw: [{ line: 2, name: 'Leak Test Import Product', price: 1 }],
        status: 'pending',
      })
      .select('id')
      .single();

    expect(error, `a seller cannot record their own import: ${error?.message}`).toBeNull();
    created.push(data!.id);

    const { data: applied } = await butcheryClient
      .from('import_batches')
      .update({ status: 'applied' })
      .eq('id', data!.id)
      .select();
    expect(applied ?? [], 'A seller cannot close their own import batch.').toHaveLength(1);
  });
});

describe('anonymous storefront', () => {
  it('cannot write to import_batches', async () => {
    const { count: before } = await admin
      .from('import_batches')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', butcheryId);

    const anon = anonClient();
    const { data, error } = await anon
      .from('import_batches')
      .insert({
        tenant_id: butcheryId,
        source: 'spreadsheet',
        raw: [{ line: 2, name: 'Leak Test Import Product', price: 1 }],
        status: 'pending',
      })
      .select('id');

    expect(
      error,
      'ANONYMOUS WRITE ALLOWED on "import_batches": the anon role holds no grant ' +
        'on this table at all, so this must be refused outright.',
    ).not.toBeNull();
    expect(data ?? []).toEqual([]);

    const { count: after } = await admin
      .from('import_batches')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', butcheryId);
    expect(after ?? 0, 'An anonymous client inserted an import batch.').toBe(before ?? 0);
  });

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

  // This and the line read below are exactly the two queries the storefront's
  // status page makes. `buyer_id = auth.uid()` is the only thing standing
  // between a buyer with somebody else's order id and their order.
  it('cannot read another buyer\'s order, even by id', async () => {
    const { data } = await buyerA.from('orders').select('*').eq('id', orderB);
    expect(
      data ?? [],
      `BUYER LEAK in "orders": buyer A read buyer B's order ${orderB} by id.`,
    ).toEqual([]);
  });

  /**
   * place_order is the buyer's only write, and it takes a tenant id. A buyer
   * browsing one shop must not be able to post an order into another one, and
   * must not be able to reach across tenants for a cheaper variant — the
   * function reads prices from `variants`, so a foreign variant id is the shape
   * that attack would take.
   */
  it('cannot place an order against another tenant\'s variants', async () => {
    const { data: foreign } = await admin
      .from('variants')
      .select('id')
      .eq('tenant_id', shoesId)
      .limit(1)
      .single();

    const before = await admin
      .from('orders')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', butcheryId);

    const { error } = await buyerA.rpc('place_order', {
      p_tenant_id: butcheryId,
      p_lines: [{ variant_id: foreign!.id, qty: 1 }],
      p_details: { customer_name: 'Leak Test', customer_phone: '27820000000' },
    });

    expect(
      error,
      'CROSS-TENANT ORDER: a buyer put another tenant\'s variant on an order. ' +
        'place_order reads the price from that row — this is how a buyer would ' +
        'shop one catalogue at another\'s prices.',
    ).not.toBeNull();

    const after = await admin
      .from('orders')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', butcheryId);
    expect(after.count, 'A header survived the refused order.').toBe(before.count);
  });

  it('cannot place an order under another buyer\'s identity', async () => {
    const { data: variant } = await admin
      .from('variants')
      .select('id')
      .eq('tenant_id', butcheryId)
      .limit(1)
      .single();

    // buyer_id is not a parameter — it is auth.uid() inside the function — so
    // the only thing to assert is that a payload cannot smuggle one in.
    const { data, error } = await buyerA.rpc('place_order', {
      p_tenant_id: butcheryId,
      p_lines: [{ variant_id: variant!.id, qty: 1 }],
      p_details: {
        customer_name: 'Leak Test',
        customer_phone: '27820000000',
        buyer_id: buyerBId,
      },
    });

    expect(error, `place_order failed unexpectedly: ${error?.message}`).toBeNull();
    const placed = data as { order: { id: string; buyer_id: string } };
    createdOrders.push(placed.order.id);
    expect(
      placed.order.buyer_id,
      'A buyer placed an order under another buyer\'s id. The status page is ' +
        'keyed on buyer_id — that is somebody else\'s order history.',
    ).toBe(buyerAId);
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

  /**
   * A buyer holds `authenticated`, so it holds execute on confirm_order — the
   * grant cannot separate them. What shuts it out is the membership check: no
   * tenant_users row means user_tenant_ids() returns nothing and every call
   * raises. Confirming is the seller's promise to fulfil, and it moves stock.
   */
  it('cannot call confirm_order at all', async () => {
    for (const tenantId of [butcheryId, shoesId]) {
      const { error } = await buyerA.rpc('confirm_order', {
        p_tenant_id: tenantId,
        p_order_id: orderA,
        p_lines: [],
      });
      expect(
        error,
        `A BUYER CONFIRMED AN ORDER against tenant ${tenantId}. Confirming is the ` +
          'seller\'s promise to fulfil, and it decrements stock.',
      ).not.toBeNull();
    }

    const { data: after } = await admin.from('orders').select('status').eq('id', orderA).single();
    expect(after!.status, 'A buyer moved its own order to confirmed.').not.toBe('confirmed');
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

      // Compared against every order this buyer owns, not just the first one:
      // a buyer with two orders of their own is not a leak.
      const own = new Set((orders ?? []).filter((o) => o.buyer_id === buyerAId).map((o) => o.id));
      const { data: lines } = await buyerA.from('order_items').select('*');
      const foreignLines = (lines ?? []).filter((l) => !own.has(l.order_id));
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

      // confirm_order's membership check passes for this fixture — the buyer
      // now has a tenant_users row. What must still hold it shut is RLS: the
      // function is SECURITY INVOKER, so the restrictive not-anonymous policy
      // on `orders` is the only thing between a buyer session and the seller's
      // queue.
      const { data: seller } = await admin
        .from('orders')
        .select('status')
        .eq('id', butcheryOrderId)
        .single();
      const { error: confirmError } = await buyerA.rpc('confirm_order', {
        p_tenant_id: butcheryId,
        p_order_id: butcheryOrderId,
        p_lines: [],
      });
      const { data: sellerAfter } = await admin
        .from('orders')
        .select('status')
        .eq('id', butcheryOrderId)
        .single();
      expect(
        sellerAfter!.status,
        'RESTRICTIVE POLICY FAILED on "orders": a buyer session holding a ' +
          'tenant_users row confirmed the seller\'s order through confirm_order.',
      ).toBe(seller!.status);
      expect(
        confirmError,
        'confirm_order returned success to a buyer session. Even with nothing ' +
          'written, that is the wrong answer — it is not a call a buyer may make.',
      ).not.toBeNull();
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
            const row = payload.new as Record<string, unknown>;
            // The reset on line 1196 is itself an UPDATE to this row, and
            // under load — the whole suite running, not this file alone — its
            // event can arrive after the subscription goes live. Resolving on
            // whichever event lands first then asserts against `sent` and
            // fails a policy that is working. Wait for the transition this
            // test is actually about; the timeout still catches a real
            // failure to deliver.
            if (row.status !== 'received') return;
            clearTimeout(timer);
            void buyerA.removeChannel(channel);
            resolve(row);
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

// ===========================================================================
// Storage — the product-images bucket
//
// A seller writing into another tenant's folder is the same class of failure as
// a cross-tenant row read, so it gets the same treatment here.
//
// Storage is a separate service from PostgREST: these go through the storage
// client on a real seller session, not through a table query. The trap that
// shapes every assertion below is that **a denied read or delete comes back as
// an empty array with no error** — Storage does not distinguish "not yours"
// from "not there". Asserting on `error !== null` would pass against a bucket
// with no policies at all. So denial is asserted against service-key truth: the
// foreign object is still there afterwards.
//
// One read is deliberately NOT denied: the bucket carries `public = true`, so
// GET /object/public/<bucket>/<path> serves without consulting RLS. That is the
// storefront's path and it is a decision, not a gap — object names are uuids,
// so a path is not guessable. It is asserted at the bottom so it stays a
// decision somebody made rather than something that drifted.
// ===========================================================================

describe('Storage — product-images', () => {
  const BUCKET = 'product-images';
  const created: string[] = [];

  let shoesObject: string;
  let butcheryObject: string;

  /** A one-pixel payload. What matters is the path, not the picture. */
  function photo(): Blob {
    return new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' });
  }

  async function seed(tenantId: string): Promise<string> {
    const path = `${tenantId}/${crypto.randomUUID()}/${crypto.randomUUID()}.jpg`;
    const { error } = await admin.storage
      .from(BUCKET)
      .upload(path, photo(), { contentType: 'image/jpeg' });
    if (error) throw new Error(`Could not seed a Storage fixture: ${error.message}`);
    created.push(path);
    return path;
  }

  /** Service-key truth. The only thing that actually proves an object exists. */
  async function existsForAdmin(path: string): Promise<boolean> {
    const folder = path.split('/').slice(0, -1).join('/');
    const name = path.split('/').pop()!;
    const { data } = await admin.storage.from(BUCKET).list(folder);
    return (data ?? []).some((object) => object.name === name);
  }

  beforeAll(async () => {
    shoesObject = await seed(shoesId);
    butcheryObject = await seed(butcheryId);
  });

  afterAll(async () => {
    if (created.length > 0) await admin.storage.from(BUCKET).remove(created);
  });

  it("a seller cannot write an object under another tenant's prefix", async () => {
    const path = `${shoesId}/${crypto.randomUUID()}/${crypto.randomUUID()}.jpg`;
    const { error } = await butcheryClient.storage
      .from(BUCKET)
      .upload(path, photo(), { contentType: 'image/jpeg' });

    expect(error, `demo-butchery wrote an object into demo-shoes: ${path}`).not.toBeNull();

    // An error is not proof nothing was written.
    if (await existsForAdmin(path)) {
      created.push(path);
      throw new Error(`The object exists despite the error: ${path}`);
    }
  });

  it("a seller cannot enumerate another tenant's objects", async () => {
    const folder = shoesObject.split('/').slice(0, -1).join('/');

    const { data: listed } = await butcheryClient.storage.from(BUCKET).list(folder);
    expect(
      listed ?? [],
      'demo-butchery can list demo-shoes objects — the SELECT policy is not tenant-scoped.',
    ).toEqual([]);

    // The object is genuinely there. Without this the assertion above passes
    // against an empty bucket and proves nothing.
    expect(
      await existsForAdmin(shoesObject),
      'the fixture object is missing, so the listing assertion proved nothing',
    ).toBe(true);

    // Note what this does NOT claim. The bucket is public, and Storage serves
    // a public bucket's object without consulting RLS on either endpoint — so
    // demo-butchery holding the exact path CAN fetch that one file, and so can
    // anybody else. That is the recorded trade, asserted at the bottom of this
    // block. What is enforced, and what is worth enforcing, is that no path can
    // be discovered: the listing above is the only way to find one, and it is
    // empty for everyone but the owner.
  });

  it("a seller cannot delete another tenant's objects", async () => {
    // Storage answers this with an empty array and no error. The delete either
    // happened or it did not, and only the service key can say which.
    await butcheryClient.storage.from(BUCKET).remove([shoesObject]);

    expect(await existsForAdmin(shoesObject), 'demo-butchery deleted a demo-shoes object.').toBe(
      true,
    );
  });

  it("a seller cannot overwrite another tenant's object", async () => {
    const { error } = await butcheryClient.storage
      .from(BUCKET)
      .upload(shoesObject, photo(), { contentType: 'image/jpeg', upsert: true });

    expect(error, 'demo-butchery overwrote a demo-shoes object.').not.toBeNull();
  });

  it('anon cannot write to the bucket at all', async () => {
    const path = `${butcheryId}/${crypto.randomUUID()}/${crypto.randomUUID()}.jpg`;
    const { error } = await anonClient()
      .storage.from(BUCKET)
      .upload(path, photo(), { contentType: 'image/jpeg' });

    expect(error, 'the anon role wrote an object into the bucket.').not.toBeNull();
    expect(await existsForAdmin(path), 'an anon-written object exists.').toBe(false);
  });

  it('a buyer session cannot write to the bucket at all', async () => {
    const buyer = anonClient();
    const { error: signInError } = await buyer.auth.signInAnonymously();
    if (signInError) throw new Error(`Anonymous sign-in failed: ${signInError.message}`);

    // A buyer holds the `authenticated` role, which is exactly why the write
    // policies carry a restrictive not-anonymous gate on top of the tenant one.
    const path = `${butcheryId}/${crypto.randomUUID()}/${crypto.randomUUID()}.jpg`;
    const { error } = await buyer.storage
      .from(BUCKET)
      .upload(path, photo(), { contentType: 'image/jpeg' });

    expect(error, 'a buyer session wrote an object into the bucket.').not.toBeNull();
    expect(await existsForAdmin(path), 'a buyer-written object exists.').toBe(false);

    await buyer.auth.signOut();
  });

  it('a buyer session cannot enumerate the bucket', async () => {
    const buyer = anonClient();
    const { error: signInError } = await buyer.auth.signInAnonymously();
    if (signInError) throw new Error(`Anonymous sign-in failed: ${signInError.message}`);

    const folder = butcheryObject.split('/').slice(0, -1).join('/');
    const { data } = await buyer.storage.from(BUCKET).list(folder);
    expect(data ?? [], 'a buyer session can list objects in the bucket.').toEqual([]);

    await buyer.auth.signOut();
  });

  it('a seller can read, write and delete under their own prefix', async () => {
    // Without this the assertions above would also pass against a bucket that
    // refuses everybody, which would be a broken product rather than a secure
    // one.
    const path = `${butcheryId}/${crypto.randomUUID()}/${crypto.randomUUID()}.jpg`;

    const { error: writeError } = await butcheryClient.storage
      .from(BUCKET)
      .upload(path, photo(), { contentType: 'image/jpeg' });
    expect(writeError, `a seller could not write their own photo: ${writeError?.message}`).toBeNull();
    created.push(path);

    const folder = path.split('/').slice(0, -1).join('/');
    const { data: listed } = await butcheryClient.storage.from(BUCKET).list(folder);
    expect((listed ?? []).length, 'a seller cannot list their own library.').toBe(1);

    const { error: deleteError } = await butcheryClient.storage.from(BUCKET).remove([path]);
    expect(deleteError, 'a seller could not delete their own photo.').toBeNull();
    expect(await existsForAdmin(path), 'the delete reported success but the object remains.').toBe(
      false,
    );
  });

  it('an object is fetchable by exact public URL — deliberately', async () => {
    // The bucket is public so the storefront can render without signing every
    // tile. This is the trade recorded in SCHEMA.md, asserted so that changing
    // it is a decision rather than an accident: one path, one file, and no way
    // to discover a path you were not given.
    const response = await fetch(`${url}/storage/v1/object/public/${BUCKET}/${butcheryObject}`);
    expect(
      response.status,
      'a public object URL did not serve — the storefront cannot render.',
    ).toBe(200);
  });
});
