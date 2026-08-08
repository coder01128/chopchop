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

  it('reads a single order by id through get_order(), and only that order', async () => {
    const anon = anonClient();
    const { data, error } = await anon.rpc('get_order', { p_order_id: butcheryOrderId });
    expect(error, `get_order failed: ${error?.message}`).toBeNull();
    expect(data, 'get_order returned nothing for a known order id').not.toBeNull();
    expect((data as { id: string }).id).toBe(butcheryOrderId);
    expect(Array.isArray((data as { items: unknown[] }).items)).toBe(true);
  });

  it('get_order() returns nothing for an id it was not given', async () => {
    const anon = anonClient();
    const { data } = await anon.rpc('get_order', {
      p_order_id: '00000000-0000-0000-0000-000000000000',
    });
    expect(data, 'get_order returned an order for a bogus id').toBeNull();
  });
});

describe('anonymous order creation', () => {
  const created: string[] = [];

  afterAll(async () => {
    for (const id of created) {
      await admin.from('orders').delete().eq('id', id);
    }
  });

  it('can place an order and its lines against an active tenant', async () => {
    const anon = anonClient();
    const orderId = crypto.randomUUID();

    const { data: variant } = await admin
      .from('variants')
      .select('id, price')
      .eq('tenant_id', butcheryId)
      .limit(1)
      .single();

    const { error: orderError } = await anon.from('orders').insert({
      id: orderId,
      tenant_id: butcheryId,
      reference: 'T01',
      customer_name: 'Leak Test Buyer',
      customer_phone: '27820000000',
      fulfilment: 'collect',
      notes: 'placed by tenant-leak.test.ts',
      total: variant!.price,
    });
    expect(orderError, `anonymous order insert failed: ${orderError?.message}`).toBeNull();
    created.push(orderId);

    const { error: lineError } = await anon.from('order_items').insert({
      tenant_id: butcheryId,
      order_id: orderId,
      variant_id: variant!.id,
      name_snapshot: 'Leak Test Line',
      price_snapshot: variant!.price,
      qty: 1,
      line_total: variant!.price,
    });
    expect(lineError, `anonymous order_items insert failed: ${lineError?.message}`).toBeNull();

    // and can then read exactly that order back
    const { data } = await anon.rpc('get_order', { p_order_id: orderId });
    expect((data as { id: string } | null)?.id).toBe(orderId);
  });

  it('cannot set status on an order it creates', async () => {
    const anon = anonClient();
    const { error } = await anon.from('orders').insert({
      id: crypto.randomUUID(),
      tenant_id: butcheryId,
      reference: 'T02',
      customer_name: 'Leak Test Buyer',
      customer_phone: '27820000000',
      fulfilment: 'collect',
      total: 0,
      status: 'completed',
    });
    expect(
      error,
      'A buyer was able to insert an order with status = completed. Revenue ' +
        'metrics run off that status — the column grant must exclude it.',
    ).not.toBeNull();
  });

  it('cannot attach a line to another tenant\'s order', async () => {
    const anon = anonClient();
    const { error } = await anon.from('order_items').insert({
      tenant_id: shoesId,
      order_id: butcheryOrderId, // belongs to demo-butchery
      variant_id: (await admin
        .from('variants')
        .select('id')
        .eq('tenant_id', shoesId)
        .limit(1)
        .single()).data!.id,
      name_snapshot: 'Cross-tenant line',
      price_snapshot: 1,
      qty: 1,
      line_total: 1,
    });
    expect(
      error,
      'A line was attached to an order belonging to a different tenant.',
    ).not.toBeNull();
  });

  it('cannot place an order against an inactive tenant', async () => {
    const anon = anonClient();
    const { error } = await anon.from('orders').insert({
      id: crypto.randomUUID(),
      tenant_id: inactiveTenantId,
      reference: 'T03',
      customer_name: 'Leak Test Buyer',
      customer_phone: '27820000000',
      fulfilment: 'collect',
      total: 0,
    });
    expect(error, 'An order was placed against a tenant with active = false.').not.toBeNull();
  });

  it('cannot update or delete anything', async () => {
    const anon = anonClient();
    const { error: updateError } = await anon
      .from('items')
      .update({ name: 'hacked' })
      .eq('tenant_id', butcheryId);
    expect(updateError, 'anon was able to UPDATE items').not.toBeNull();

    const { error: deleteError } = await anon.from('items').delete().eq('tenant_id', butcheryId);
    expect(deleteError, 'anon was able to DELETE items').not.toBeNull();
  });
});
