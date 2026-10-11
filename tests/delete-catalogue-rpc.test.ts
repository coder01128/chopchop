// public.delete_catalogue — wipe a tenant's catalogue.
//
//   npx vitest run tests/delete-catalogue-rpc.test.ts
//
// Runs against a THROWAWAY tenant created in beforeAll and removed in afterAll.
// It never touches the demo tenants: this function destroys a whole catalogue,
// so a test that aimed it at demo-butchery would be a way to lose the seed.
//
// Properties that matter and are invisible in the browser when things go right:
//   - orders survive, and so do the variants they point at (retired, not deleted)
//   - open orders block the whole thing and change nothing
//   - only an owner of the tenant can call it
//
// Requires: migrations applied.

import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = process.env.VITE_SUPABASE_URL;
const publishableKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const secretKey = process.env.SUPABASE_SECRET_KEY;

if (!url || !publishableKey || !secretKey) {
  throw new Error('Missing Supabase environment variables in .env');
}

const admin = createClient(url, secretKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const PASSWORD = 'Delete-Catalogue-Test-1!';
const stamp = Date.now();

let tenantId: string;
let otherTenantId: string;
let owner: SupabaseClient;
let staff: SupabaseClient;
const userIds: string[] = [];

async function makeUser(label: string, tenant: string, role: 'owner' | 'staff') {
  const email = `delete-catalogue-${label}-${stamp}@example.test`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error) throw new Error(`createUser failed: ${error.message}`);
  userIds.push(data.user.id);

  const link = await admin
    .from('tenant_users')
    .insert({ tenant_id: tenant, user_id: data.user.id, role });
  if (link.error) throw new Error(`tenant_users insert failed: ${link.error.message}`);

  const client = createClient(url!, publishableKey!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const signed = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (signed.error) throw new Error(`sign in failed: ${signed.error.message}`);
  return client;
}

async function makeTenant(label: string): Promise<string> {
  const { data, error } = await admin
    .from('tenants')
    .insert({ slug: `dc-test-${label}-${stamp}`, name: `Delete Catalogue Test ${label}` })
    .select('id')
    .single();
  if (error) throw new Error(`tenant insert failed: ${error.message}`);
  return data.id;
}

/** A category, a product with two variants. Returns the ids. */
async function seedCatalogue(tenant: string, name: string) {
  const category = await admin
    .from('categories')
    .insert({ tenant_id: tenant, name: `${name} cat` })
    .select('id')
    .single();
  if (category.error) throw new Error(category.error.message);

  const item = await admin
    .from('items')
    .insert({ tenant_id: tenant, name, category_id: category.data.id })
    .select('id')
    .single();
  if (item.error) throw new Error(item.error.message);

  const variants = await admin
    .from('variants')
    .insert([
      { tenant_id: tenant, item_id: item.data.id, attributes: { unit: 'a' }, price: 10 },
      { tenant_id: tenant, item_id: item.data.id, attributes: { unit: 'b' }, price: 20 },
    ])
    .select('id');
  if (variants.error) throw new Error(variants.error.message);

  return {
    categoryId: category.data.id as string,
    itemId: item.data.id as string,
    variantIds: variants.data.map((v) => v.id as string),
  };
}

async function placeOrder(
  tenant: string,
  variantId: string,
  status: 'sent' | 'completed' | 'cancelled',
  reference: string,
) {
  const order = await admin
    .from('orders')
    .insert({
      tenant_id: tenant,
      reference,
      customer_name: 'Test Buyer',
      customer_phone: '27820000000',
      fulfilment: 'collect',
      status,
      total: 10,
    })
    .select('id')
    .single();
  if (order.error) throw new Error(order.error.message);

  const line = await admin.from('order_items').insert({
    tenant_id: tenant,
    order_id: order.data.id,
    variant_id: variantId,
    name_snapshot: 'Test line',
    price_snapshot: 10,
    qty: 1,
    line_total: 10,
  });
  if (line.error) throw new Error(line.error.message);
  return order.data.id as string;
}

async function counts(tenant: string) {
  const [items, variants, categories, batches, orders] = await Promise.all(
    ['items', 'variants', 'categories', 'import_batches', 'orders'].map(async (table) => {
      const { count, error } = await admin
        .from(table)
        .select('*', { count: 'exact', head: true })
        .eq('tenant_id', tenant);
      if (error) throw new Error(error.message);
      return count ?? 0;
    }),
  );
  return { items, variants, categories, batches, orders };
}

beforeAll(async () => {
  tenantId = await makeTenant('main');
  otherTenantId = await makeTenant('other');
  owner = await makeUser('owner', tenantId, 'owner');
  staff = await makeUser('staff', tenantId, 'staff');
});

afterAll(async () => {
  // Orders first: order_items.variant_id is RESTRICT, and a tenant delete
  // cascades to variants and order_items with no guaranteed order.
  for (const id of [tenantId, otherTenantId]) {
    if (!id) continue;
    await admin.from('orders').delete().eq('tenant_id', id);
    await admin.from('tenants').delete().eq('id', id);
  }
  for (const id of userIds) await admin.auth.admin.deleteUser(id);
  await owner?.auth.signOut();
  await staff?.auth.signOut();
});

describe('delete_catalogue', () => {
  it('removes everything and reports it when there is no order history', async () => {
    await seedCatalogue(tenantId, 'Clean slate');
    await admin.from('import_batches').insert({ tenant_id: tenantId, source: 'spreadsheet' });

    const { data, error } = await owner.rpc('delete_catalogue', { p_tenant_id: tenantId });
    expect(error).toBeNull();

    const result = data as Record<string, number>;
    expect(result.items_deleted).toBeGreaterThanOrEqual(1);
    expect(result.items_kept).toBe(0);
    expect(result.categories_deleted).toBeGreaterThanOrEqual(1);
    expect(result.import_batches_deleted).toBeGreaterThanOrEqual(1);

    expect(await counts(tenantId)).toEqual({
      items: 0,
      variants: 0,
      categories: 0,
      batches: 0,
      orders: 0,
    });
  });

  it('keeps orders, retires ordered variants and hides their product', async () => {
    const ordered = await seedCatalogue(tenantId, 'Has history');
    const untouched = await seedCatalogue(tenantId, 'No history');
    await placeOrder(tenantId, ordered.variantIds[0], 'completed', 'DC001');

    const { data, error } = await owner.rpc('delete_catalogue', { p_tenant_id: tenantId });
    expect(error).toBeNull();

    const result = data as Record<string, number>;
    expect(result.items_kept).toBe(1);
    expect(result.variants_retired).toBe(1);

    // The order and its line survive intact.
    const lines = await admin
      .from('order_items')
      .select('variant_id')
      .eq('tenant_id', tenantId);
    expect(lines.data).toHaveLength(1);
    expect(lines.data![0].variant_id).toBe(ordered.variantIds[0]);

    // The ordered variant is retired, unavailable, and its product hidden and detached.
    const variant = await admin
      .from('variants')
      .select('available, retired_at, image_path')
      .eq('id', ordered.variantIds[0])
      .single();
    expect(variant.data!.available).toBe(false);
    expect(variant.data!.retired_at).not.toBeNull();
    expect(variant.data!.image_path).toBeNull();

    const item = await admin
      .from('items')
      .select('active, category_id')
      .eq('id', ordered.itemId)
      .single();
    expect(item.data!.active).toBe(false);
    expect(item.data!.category_id).toBeNull();

    // Everything without history is gone, including the sibling variant.
    const gone = await admin.from('items').select('id').eq('id', untouched.itemId);
    expect(gone.data).toHaveLength(0);
    const sibling = await admin.from('variants').select('id').eq('id', ordered.variantIds[1]);
    expect(sibling.data).toHaveLength(0);

    const left = await counts(tenantId);
    expect(left.items).toBe(1);
    expect(left.variants).toBe(1);
    expect(left.categories).toBe(0);
    expect(left.orders).toBe(1);

    // A second run is a no-op on what remains, not an error.
    const again = await owner.rpc('delete_catalogue', { p_tenant_id: tenantId });
    expect(again.error).toBeNull();
    expect(await counts(tenantId)).toEqual(left);
  });

  it('refuses while any order is open and changes nothing', async () => {
    const seeded = await seedCatalogue(tenantId, 'Open order');
    await placeOrder(tenantId, seeded.variantIds[0], 'sent', 'DC002');
    const before = await counts(tenantId);

    const { error } = await owner.rpc('delete_catalogue', { p_tenant_id: tenantId });

    expect(error, 'an open order did not block the delete').not.toBeNull();
    expect(error!.code).toBe('55000');
    expect(error!.message).toMatch(/1 open order/);
    expect(await counts(tenantId)).toEqual(before);
  });

  it('refuses a caller who does not belong to the tenant', async () => {
    const seeded = await seedCatalogue(otherTenantId, 'Not yours');
    const before = await counts(otherTenantId);

    const { error } = await owner.rpc('delete_catalogue', { p_tenant_id: otherTenantId });

    expect(error, 'a foreign tenant was accepted').not.toBeNull();
    expect(error!.code).toBe('42501');
    expect(await counts(otherTenantId)).toEqual(before);
    const stillThere = await admin.from('items').select('id').eq('id', seeded.itemId);
    expect(stillThere.data).toHaveLength(1);
  });

  it('refuses staff: only an owner may delete the catalogue', async () => {
    await seedCatalogue(tenantId, 'Staff cannot');
    const before = await counts(tenantId);

    const { error } = await staff.rpc('delete_catalogue', { p_tenant_id: tenantId });

    expect(error, 'a staff user deleted the catalogue').not.toBeNull();
    expect(error!.code).toBe('42501');
    expect(await counts(tenantId)).toEqual(before);
  });

  it('is not callable without a session', async () => {
    const anon = createClient(url!, publishableKey!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error } = await anon.rpc('delete_catalogue', { p_tenant_id: tenantId });
    expect(error, 'anon can execute delete_catalogue').not.toBeNull();
  });
});
