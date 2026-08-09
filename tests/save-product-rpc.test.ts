// public.save_product — the atomic product save.
//
//   npx vitest run tests/save-product-rpc.test.ts
//
// Two properties matter here and neither is visible in the browser when things
// go right: the whole save rolls back as one unit, and the function is not a
// way around the tenant boundary. The RPC is SECURITY INVOKER precisely so that
// RLS still applies; these tests are what stops that quietly regressing.
//
// Requires: migrations applied and the seed run.

import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { DEMO_PASSWORD, DEMO_USERS } from '../scripts/demo-users.mjs';

const url = process.env.VITE_SUPABASE_URL;
const publishableKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const secretKey = process.env.SUPABASE_SECRET_KEY;

if (!url || !publishableKey || !secretKey) {
  throw new Error('Missing Supabase environment variables in .env');
}

const admin = createClient(url, secretKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let butchery: SupabaseClient;
let butcheryTenantId: string;
let shoesTenantId: string;
const createdItemIds: string[] = [];

async function signIn(email: string): Promise<SupabaseClient> {
  const client = createClient(url!, publishableKey!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password: DEMO_PASSWORD });
  if (error) throw new Error(`Could not sign in as ${email}: ${error.message}`);
  return client;
}

beforeAll(async () => {
  const { data: tenants, error } = await admin
    .from('tenants')
    .select('id, slug')
    .in('slug', [DEMO_USERS.butchery.slug, DEMO_USERS.shoes.slug]);
  if (error) throw new Error(error.message);

  butcheryTenantId = tenants!.find((t) => t.slug === DEMO_USERS.butchery.slug)!.id;
  shoesTenantId = tenants!.find((t) => t.slug === DEMO_USERS.shoes.slug)!.id;

  butchery = await signIn(DEMO_USERS.butchery.email);
});

afterAll(async () => {
  for (const id of createdItemIds) await admin.from('items').delete().eq('id', id);
  await butchery?.auth.signOut();
});

/** A product with two priced variants, saved through the RPC. */
async function createProduct(name: string) {
  const { data, error } = await butchery.rpc('save_product', {
    p_tenant_id: butcheryTenantId,
    p_item: { id: null, name, description: '', image_url: '', category_id: null, active: true },
    p_variants: [
      { id: null, attributes: { unit: 'per kg' }, price: 100, stock: null, available: true, sku: '' },
      { id: null, attributes: { unit: 'per pack' }, price: 50, stock: null, available: true, sku: '' },
    ],
    p_removals: [],
  });
  if (error) throw new Error(`setup save failed: ${error.message}`);
  const saved = data as { item: { id: string }; variants: { id: string; price: number }[] };
  createdItemIds.push(saved.item.id);
  return saved;
}

describe('save_product', () => {
  it('creates a product and its variants in one call', async () => {
    const saved = await createProduct(`RPC Create ${Date.now()}`);
    expect(saved.item.id).toBeTruthy();
    expect(saved.variants).toHaveLength(2);
    // Returned so the modal can reconcile without a second round trip.
    expect(saved.variants.map((v) => Number(v.price)).sort((a, b) => a - b)).toEqual([50, 100]);
  });

  it('rolls back completely when one variant is invalid', async () => {
    const saved = await createProduct(`RPC Rollback ${Date.now()}`);
    const itemId = saved.item.id;
    const goodVariantId = saved.variants[0].id;

    // A negative price violates variants_price_non_negative. The item rename and
    // the first variant's new price are in the same statement batch, so if the
    // transaction is real, none of it survives.
    const { error } = await butchery.rpc('save_product', {
      p_tenant_id: butcheryTenantId,
      p_item: {
        id: itemId,
        name: 'RENAMED — SHOULD NOT PERSIST',
        description: '',
        image_url: '',
        category_id: null,
        active: true,
      },
      p_variants: [
        { id: goodVariantId, attributes: { unit: 'per kg' }, price: 999, stock: null, available: true, sku: '' },
        { id: null, attributes: { unit: 'per pack' }, price: -1, stock: null, available: true, sku: '' },
      ],
      p_removals: [],
    });

    expect(error, 'the invalid price was accepted').not.toBeNull();

    const { data: item } = await admin.from('items').select('name').eq('id', itemId).single();
    expect(
      item!.name,
      'The item rename survived a failed save — the write is not atomic.',
    ).not.toBe('RENAMED — SHOULD NOT PERSIST');

    const { data: variants } = await admin
      .from('variants')
      .select('price')
      .eq('item_id', itemId);
    expect(
      variants!.map((v) => Number(v.price)).sort((a, b) => a - b),
      'A variant price survived a failed save — the write is not atomic.',
    ).toEqual([50, 100]);
    expect(variants, 'A partial variant was inserted by a failed save.').toHaveLength(2);
  });

  it('refuses a payload carrying another tenant\'s id', async () => {
    const { error } = await butchery.rpc('save_product', {
      p_tenant_id: shoesTenantId,
      p_item: { id: null, name: 'Cross-tenant write', description: '', image_url: '', category_id: null, active: true },
      p_variants: [
        { id: null, attributes: {}, price: 10, stock: null, available: true, sku: '' },
      ],
      p_removals: [],
    });

    expect(
      error,
      'A seller wrote a product into another tenant. save_product must reject a ' +
        'foreign tenant_id explicitly, not rely on RLS to filter it silently.',
    ).not.toBeNull();
    expect(error!.message).toMatch(/does not belong to tenant/i);

    const { count } = await admin
      .from('items')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', shoesTenantId)
      .eq('name', 'Cross-tenant write');
    expect(count, 'A cross-tenant product was actually written.').toBe(0);
  });

  it('refuses to edit a product belonging to another tenant', async () => {
    const { data: foreign } = await admin
      .from('items')
      .select('id, name')
      .eq('tenant_id', shoesTenantId)
      .limit(1)
      .single();

    const { error } = await butchery.rpc('save_product', {
      p_tenant_id: butcheryTenantId,
      p_item: { id: foreign!.id, name: 'HIJACKED', description: '', image_url: '', category_id: null, active: true },
      p_variants: [],
      p_removals: [],
    });

    expect(error, 'A seller edited another tenant\'s product by id.').not.toBeNull();

    const { data: after } = await admin.from('items').select('name').eq('id', foreign!.id).single();
    expect(after!.name).toBe(foreign!.name);
  });

  it('retires a variant instead of deleting it, and hides it from buyers', async () => {
    const saved = await createProduct(`RPC Retire ${Date.now()}`);
    const target = saved.variants[0];

    const { error } = await butchery.rpc('save_product', {
      p_tenant_id: butcheryTenantId,
      p_item: { id: saved.item.id, name: 'RPC Retire', description: '', image_url: '', category_id: null, active: true },
      p_variants: saved.variants
        .filter((v) => v.id !== target.id)
        .map((v) => ({ id: v.id, attributes: { unit: 'per pack' }, price: 50, stock: null, available: true, sku: '' })),
      p_removals: [{ id: target.id, action: 'retire' }],
    });
    expect(error, `retire failed: ${error?.message}`).toBeNull();

    const { data: row } = await admin
      .from('variants')
      .select('available, retired_at')
      .eq('id', target.id)
      .single();
    expect(row, 'the retired variant was deleted, not kept').not.toBeNull();
    expect(row!.retired_at, 'retired_at was not set').not.toBeNull();
    expect(row!.available).toBe(false);

    // The removal dialog promises buyers will not see it. That promise is a
    // policy, not a hope.
    const anon = createClient(url!, publishableKey!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: visible } = await anon.from('variants').select('id').eq('id', target.id);
    expect(
      visible ?? [],
      'A retired variant is still visible to the storefront.',
    ).toEqual([]);
  });

  it('rejects an unknown removal action', async () => {
    const saved = await createProduct(`RPC Bad Action ${Date.now()}`);
    const { error } = await butchery.rpc('save_product', {
      p_tenant_id: butcheryTenantId,
      p_item: { id: saved.item.id, name: 'RPC Bad Action', description: '', image_url: '', category_id: null, active: true },
      p_variants: [],
      p_removals: [{ id: saved.variants[0].id, action: 'nuke' }],
    });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/unknown removal action/i);
  });
});
