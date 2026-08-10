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

// ---------------------------------------------------------------------------
// Ticket 07 — image paths and the client-minted item id
//
// `new_id` lets the modal choose the id of a product it is creating, because
// the Storage object path contains the item id and a seller may photograph
// stock before the first save. A client-minted id is a client-controlled id, so
// what it can be aimed at is asserted here rather than reasoned about.
// ---------------------------------------------------------------------------

describe('save_product — image paths', () => {
  /** A path under the caller's own tenant prefix, which is the only kind accepted. */
  function pathFor(tenantId: string, itemId: string): string {
    return `${tenantId}/${itemId}/${crypto.randomUUID()}.jpg`;
  }

  it('refuses a new_id that already exists in the caller\'s own tenant', async () => {
    const existing = await createProduct(`RPC NewId Own ${Date.now()}`);

    const { error } = await butchery.rpc('save_product', {
      p_tenant_id: butcheryTenantId,
      p_item: {
        id: null,
        new_id: existing.item.id,
        name: 'SHOULD NOT OVERWRITE',
        description: '',
        image_url: '',
        category_id: null,
        active: true,
      },
      p_variants: [
        { id: null, attributes: { unit: 'per kg' }, price: 1, stock: null, available: true, sku: '' },
      ],
      p_removals: [],
    });

    expect(error, 'a colliding new_id was accepted').not.toBeNull();
    // A primary key collision, not a silent update. The distinction matters:
    // an upsert here would let a client-minted id rewrite an existing product.
    expect(error!.code ?? error!.message).toMatch(/23505|duplicate key/i);

    const { data: row } = await admin
      .from('items')
      .select('name')
      .eq('id', existing.item.id)
      .single();
    expect(row!.name, 'the existing product was overwritten').not.toBe('SHOULD NOT OVERWRITE');
  });

  it('refuses a new_id belonging to another tenant, and does not update that row', async () => {
    // Created with the service key: the butchery seller cannot see this row at
    // all, which is the point — the id is the only thing they would have.
    const foreignId = crypto.randomUUID();
    const { error: setupError } = await admin.from('items').insert({
      id: foreignId,
      tenant_id: shoesTenantId,
      name: 'Shoes Product — Untouchable',
      active: true,
    });
    if (setupError) throw new Error(`setup insert failed: ${setupError.message}`);
    createdItemIds.push(foreignId);

    const { error } = await butchery.rpc('save_product', {
      p_tenant_id: butcheryTenantId,
      p_item: {
        id: null,
        new_id: foreignId,
        name: 'HIJACKED',
        description: '',
        image_url: '',
        category_id: null,
        active: true,
      },
      p_variants: [
        { id: null, attributes: { unit: 'per kg' }, price: 1, stock: null, available: true, sku: '' },
      ],
      p_removals: [],
    });

    expect(error, 'a foreign new_id was accepted').not.toBeNull();

    const { data: row } = await admin
      .from('items')
      .select('name, tenant_id')
      .eq('id', foreignId)
      .single();
    expect(row!.name, 'a foreign product was rewritten through new_id').toBe(
      'Shoes Product — Untouchable',
    );
    expect(row!.tenant_id, 'a foreign product changed tenant').toBe(shoesTenantId);

    // And nothing was created in the caller's tenant carrying that id either.
    const { data: mine } = await admin
      .from('items')
      .select('id')
      .eq('id', foreignId)
      .eq('tenant_id', butcheryTenantId);
    expect(mine ?? []).toEqual([]);
  });

  it('accepts a new_id that is free, and the product is created with it', async () => {
    const chosen = crypto.randomUUID();
    const { data, error } = await butchery.rpc('save_product', {
      p_tenant_id: butcheryTenantId,
      p_item: {
        id: null,
        new_id: chosen,
        name: `RPC NewId Free ${Date.now()}`,
        description: '',
        image_url: '',
        image_path: null,
        category_id: null,
        active: true,
      },
      p_variants: [
        { id: null, attributes: { unit: 'per kg' }, price: 10, stock: null, available: true, sku: '' },
      ],
      p_removals: [],
    });

    expect(error, `save failed: ${error?.message}`).toBeNull();
    const saved = data as { item: { id: string } };
    createdItemIds.push(saved.item.id);
    // The whole reason new_id exists: photos uploaded before the first save
    // sit under this id, so the row must end up carrying it.
    expect(saved.item.id).toBe(chosen);
  });

  it('refuses an image path under another tenant\'s prefix', async () => {
    const saved = await createProduct(`RPC Foreign Path ${Date.now()}`);
    const foreignPath = `${shoesTenantId}/${saved.item.id}/${crypto.randomUUID()}.jpg`;

    const { error } = await butchery.rpc('save_product', {
      p_tenant_id: butcheryTenantId,
      p_item: {
        id: saved.item.id,
        name: 'RPC Foreign Path',
        description: '',
        image_url: '',
        image_path: foreignPath,
        category_id: null,
        active: true,
      },
      p_variants: [],
      p_removals: [],
    });

    expect(error, 'a foreign tenant image path was accepted').not.toBeNull();
    expect(error!.message).toMatch(/not under this tenant/i);
  });

  it('leaves an existing image_path untouched when the key is absent', async () => {
    const saved = await createProduct(`RPC Image Keep ${Date.now()}`);
    const itemPath = pathFor(butcheryTenantId, saved.item.id);
    const variantPath = pathFor(butcheryTenantId, saved.item.id);
    const variantId = saved.variants[0].id;

    // Set both.
    const first = await butchery.rpc('save_product', {
      p_tenant_id: butcheryTenantId,
      p_item: {
        id: saved.item.id,
        name: 'RPC Image Keep',
        description: '',
        image_url: '',
        image_path: itemPath,
        category_id: null,
        active: true,
      },
      p_variants: [
        {
          id: variantId,
          attributes: { unit: 'per kg' },
          price: 100,
          stock: null,
          available: true,
          sku: '',
          image_path: variantPath,
        },
      ],
      p_removals: [],
    });
    expect(first.error, `setting paths failed: ${first.error?.message}`).toBeNull();

    // Now a save shaped like the import pipeline's: no image_path key anywhere.
    // This is the assertion that protects a seller's photographs from a
    // price-list re-import. If the absent/empty distinction ever flips, it
    // fails here rather than in a client's catalogue.
    const second = await butchery.rpc('save_product', {
      p_tenant_id: butcheryTenantId,
      p_item: {
        id: saved.item.id,
        name: 'RPC Image Keep',
        description: '',
        image_url: '',
        category_id: null,
        active: true,
      },
      p_variants: [
        { id: variantId, attributes: { unit: 'per kg' }, price: 111, stock: null, available: true, sku: '' },
      ],
      p_removals: [],
    });
    expect(second.error, `second save failed: ${second.error?.message}`).toBeNull();

    const { data: item } = await admin
      .from('items')
      .select('image_path')
      .eq('id', saved.item.id)
      .single();
    expect(item!.image_path, 'a save with no image_path key cleared the product photo').toBe(
      itemPath,
    );

    const { data: variant } = await admin
      .from('variants')
      .select('image_path, price')
      .eq('id', variantId)
      .single();
    expect(variant!.image_path, 'a save with no image_path key cleared the variant photo').toBe(
      variantPath,
    );
    // And the save it was carrying did happen — the row was written, the image
    // column simply was not part of it.
    expect(Number(variant!.price)).toBe(111);
  });

  it('clears an image_path when the key is present and empty', async () => {
    const saved = await createProduct(`RPC Image Clear ${Date.now()}`);
    const itemPath = pathFor(butcheryTenantId, saved.item.id);
    const variantPath = pathFor(butcheryTenantId, saved.item.id);
    const variantId = saved.variants[0].id;

    const first = await butchery.rpc('save_product', {
      p_tenant_id: butcheryTenantId,
      p_item: {
        id: saved.item.id,
        name: 'RPC Image Clear',
        description: '',
        image_url: '',
        image_path: itemPath,
        category_id: null,
        active: true,
      },
      p_variants: [
        {
          id: variantId,
          attributes: { unit: 'per kg' },
          price: 100,
          stock: null,
          available: true,
          sku: '',
          image_path: variantPath,
        },
      ],
      p_removals: [],
    });
    expect(first.error, `setting paths failed: ${first.error?.message}`).toBeNull();

    // What the remove control sends.
    const second = await butchery.rpc('save_product', {
      p_tenant_id: butcheryTenantId,
      p_item: {
        id: saved.item.id,
        name: 'RPC Image Clear',
        description: '',
        image_url: '',
        image_path: '',
        category_id: null,
        active: true,
      },
      p_variants: [
        {
          id: variantId,
          attributes: { unit: 'per kg' },
          price: 100,
          stock: null,
          available: true,
          sku: '',
          image_path: '',
        },
      ],
      p_removals: [],
    });
    expect(second.error, `clearing failed: ${second.error?.message}`).toBeNull();

    const { data: item } = await admin
      .from('items')
      .select('image_path')
      .eq('id', saved.item.id)
      .single();
    expect(item!.image_path, 'an empty image_path did not clear the product photo').toBeNull();

    const { data: variant } = await admin
      .from('variants')
      .select('image_path')
      .eq('id', variantId)
      .single();
    expect(variant!.image_path, 'an empty image_path did not clear the variant photo').toBeNull();
  });
});
