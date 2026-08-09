// public.place_order — the buyer's only write.
//
//   npx vitest run tests/place-order-rpc.test.ts
//
// The property that matters most here is not visible in a browser at all: a
// buyer session may insert order lines, so `price_snapshot` is a column it can
// write. If the price came from the payload, a buyer could set their own. It
// comes from `variants`, and the test below sends a lying payload to prove it.
//
// Everything runs as a real anonymous buyer — the same session the storefront
// creates at checkout — because that is the role whose policies decide what
// this function can do.
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

let butcheryId: string;
let shoesId: string;
let buyer: SupabaseClient;

const createdOrderIds: string[] = [];
const createdBuyerIds: string[] = [];
const createdItemIds: string[] = [];
const createdTenantIds: string[] = [];

function anonClient(): SupabaseClient {
  return createClient(url!, publishableKey!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** A buyer, the way the storefront makes one: anonymous, at checkout. */
async function newBuyer(): Promise<SupabaseClient> {
  const client = anonClient();
  const { data, error } = await client.auth.signInAnonymously();
  if (error) {
    throw new Error(
      `Anonymous sign-in failed: ${error.message}. Enable it in the Supabase ` +
        'dashboard: Authentication -> Sign In / Up -> Anonymous sign-ins.',
    );
  }
  createdBuyerIds.push(data.user!.id);
  return client;
}

/** The demo tenants' own variants, looked up the way the storefront would. */
async function variantOf(tenantId: string, itemName: string, attributes: Record<string, string>) {
  const { data, error } = await admin
    .from('variants')
    .select('id, price, attributes, items!inner(name)')
    .eq('tenant_id', tenantId)
    .eq('items.name', itemName)
    .contains('attributes', attributes)
    .limit(1)
    .single();
  if (error) throw new Error(`variant lookup (${itemName}) failed: ${error.message}`);
  return data;
}

interface Placed {
  order: {
    id: string;
    reference: string;
    status: string;
    total: number | string;
    confirmed_at: string | null;
    completed_at: string | null;
    customer_name: string;
    customer_phone: string;
    fulfilment: string;
    delivery_address: string | null;
    buyer_id: string;
  };
  lines: {
    id: string;
    name_snapshot: string;
    price_snapshot: number | string;
    qty: number | string;
    qty_confirmed: number | string | null;
    line_total: number | string;
  }[];
}

async function place(
  client: SupabaseClient,
  tenantId: string,
  lines: Record<string, unknown>[],
  details: Record<string, unknown> = {},
) {
  const result = await client.rpc('place_order', {
    p_tenant_id: tenantId,
    p_lines: lines,
    p_details: {
      customer_name: 'Place RPC Buyer',
      customer_phone: '27820000000',
      ...details,
    },
  });
  const placed = result.data as Placed | null;
  if (placed?.order?.id) createdOrderIds.push(placed.order.id);
  return { ...result, placed };
}

/**
 * The reference alphabet, chosen for a seller reading a code aloud on WhatsApp:
 * no I or L to be heard as 1, no O to be heard as 0, no U.
 */
const REFERENCE = /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{5}$/;

interface DefinerGrants {
  anon: boolean;
  authenticated: boolean;
}

/**
 * Every SECURITY DEFINER function in `public`, and who may execute it.
 *
 * SECURITY DEFINER on its own is ordinary — five of these are definer precisely
 * so an RLS policy can terminate, and they must stay that way. What made
 * next_order_reference a leak was the pair: definer (exempt from RLS) *and*
 * granted to a Data API role (reachable by any storefront visitor), with
 * arguments the caller chooses. So the grants are asserted, not just the names.
 *
 * The five below are argued for in the migrations that introduced them (0002
 * and 0005). Each is granted to `authenticated` because a policy is evaluated
 * in the caller's context, so the caller needs EXECUTE; `anon` gets only the
 * two the public catalogue policies need.
 */
const EXPECTED_DEFINERS: Record<string, DefinerGrants> = {
  // Catalogue policies run for both storefront paths — anon before checkout,
  // authenticated after — so both roles need these two.
  is_active_tenant: { anon: true, authenticated: true },
  item_is_active: { anon: true, authenticated: true },

  // Dashboard and buyer policies only. anon was revoked from
  // order_belongs_to_tenant in 0005 when the anon-role buyer path was torn out.
  is_buyer_order: { anon: false, authenticated: true },
  order_belongs_to_tenant: { anon: false, authenticated: true },
  user_tenant_ids: { anon: false, authenticated: true },

  // NOT OURS, AND NOT ENDORSED.
  //
  // Created by the Supabase platform — no migration in this repo defines it. It
  // is recorded here so this test passes on today's reality, not because the
  // state is acceptable: both Data API roles hold EXECUTE (it was never revoked
  // from PUBLIC), and PostgREST routes POST /rest/v1/rpc/rls_auto_enable. That
  // is the same pair that made next_order_reference a leak, on a function whose
  // body nobody here has read.
  //
  // It was left alone rather than invoked or revoked: it is a platform object,
  // and calling something named "rls_auto_enable" to find out what it does is
  // not a test, it is the incident. Raised with Brad 2026-08-09. If it is locked
  // down, flip these to false and this test confirms the lockdown held.
  rls_auto_enable: { anon: true, authenticated: true },
};

async function orderCount(tenantId: string): Promise<number> {
  const { count } = await admin
    .from('orders')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', tenantId);
  return count ?? 0;
}

beforeAll(async () => {
  const { data: tenants, error } = await admin
    .from('tenants')
    .select('id, slug')
    .in('slug', [DEMO_USERS.butchery.slug, DEMO_USERS.shoes.slug]);
  if (error) throw new Error(error.message);

  butcheryId = tenants!.find((t) => t.slug === DEMO_USERS.butchery.slug)!.id;
  shoesId = tenants!.find((t) => t.slug === DEMO_USERS.shoes.slug)!.id;

  buyer = await newBuyer();
});

afterAll(async () => {
  for (const id of createdOrderIds) await admin.from('orders').delete().eq('id', id);
  for (const id of createdItemIds) await admin.from('items').delete().eq('id', id);
  for (const id of createdTenantIds) await admin.from('tenants').delete().eq('id', id);
  for (const id of createdBuyerIds) await admin.auth.admin.deleteUser(id);
  await buyer?.auth.signOut();
});

describe('place_order', () => {
  it('writes the header and its lines in one call', async () => {
    const chops = await variantOf(butcheryId, 'Lamb Chops', { unit: 'per kg' });
    const wors = await variantOf(butcheryId, 'Boerewors', { unit: 'per pack' });

    const { error, placed } = await place(buyer, butcheryId, [
      { variant_id: chops.id, qty: 1.5 },
      { variant_id: wors.id, qty: 2 },
    ]);

    expect(error, `place failed: ${error?.message}`).toBeNull();
    expect(placed!.lines).toHaveLength(2);

    // The total is summed inside the function, from prices it read itself.
    const expected =
      Math.round(Number(chops.price) * 1.5 * 100) / 100 + Math.round(Number(wors.price) * 2 * 100) / 100;
    expect(Number(placed!.order.total)).toBeCloseTo(expected, 2);

    // A collect tenant: the address field never appears at checkout and nothing
    // lands in the column.
    expect(placed!.order.fulfilment).toBe('collect');
    expect(placed!.order.delivery_address).toBeNull();

    const { count } = await admin
      .from('order_items')
      .select('*', { count: 'exact', head: true })
      .eq('order_id', placed!.order.id);
    expect(count, 'the returned lines were not the written ones').toBe(2);
  });

  it('ignores a price_snapshot supplied in the payload', async () => {
    const chops = await variantOf(butcheryId, 'Lamb Chops', { unit: 'per kg' });

    // A buyer session can insert order_items, so this is a payload a real
    // attacker would send.
    const { error, placed } = await place(buyer, butcheryId, [
      { variant_id: chops.id, qty: 1, price_snapshot: 0.01, line_total: 0.01, name_snapshot: 'Free meat' },
    ]);

    expect(error, `place failed: ${error?.message}`).toBeNull();
    expect(
      Number(placed!.lines[0].price_snapshot),
      'A BUYER SET THEIR OWN PRICE. price_snapshot must be read from variants, ' +
        'never taken from the payload.',
    ).toBe(Number(chops.price));
    expect(Number(placed!.order.total)).toBe(Number(chops.price));
    expect(
      placed!.lines[0].name_snapshot,
      'name_snapshot was taken from the payload.',
    ).not.toBe('Free meat');
  });

  it('composes name_snapshot as the full variant label', async () => {
    const oneAttribute = await variantOf(butcheryId, 'Rump Steak', { unit: 'per kg' });
    const twoAttributes = await variantOf(shoesId, 'Court Classic', { size: '8', colour: 'white' });

    const butchery = await place(buyer, butcheryId, [{ variant_id: oneAttribute.id, qty: 1 }]);
    expect(butchery.error, `place failed: ${butchery.error?.message}`).toBeNull();
    expect(butchery.placed!.lines[0].name_snapshot).toBe('Rump Steak — per kg');

    const shoes = await place(buyer, shoesId, [{ variant_id: twoAttributes.id, qty: 1 }], {
      delivery_address: '12 Long Street, Salt River',
    });
    expect(shoes.error, `place failed: ${shoes.error?.message}`).toBeNull();
    // Attribute order follows the tenant's attribute_schema — size, then
    // colour — not whatever order jsonb stores its keys in.
    expect(shoes.placed!.lines[0].name_snapshot).toBe('Court Classic — 8 / white');

    // The other half of the fulfilment rule: a local_delivery tenant keeps the
    // address it was given.
    expect(shoes.placed!.order.fulfilment).toBe('local_delivery');
    expect(shoes.placed!.order.delivery_address).toBe('12 Long Street, Salt River');
  });

  it('sets status to sent and stamps no timestamps', async () => {
    const chops = await variantOf(butcheryId, 'Lamb Chops', { unit: 'per kg' });
    const { error, placed } = await place(buyer, butcheryId, [{ variant_id: chops.id, qty: 1 }]);

    expect(error, `place failed: ${error?.message}`).toBeNull();
    expect(placed!.order.status, 'A buyer placed an order at a status past `sent`.').toBe('sent');
    expect(placed!.order.confirmed_at, 'confirmed_at is the seller\'s to set.').toBeNull();
    expect(placed!.order.completed_at, 'Revenue runs off completed — that is the seller\'s.').toBeNull();
    expect(placed!.lines[0].qty_confirmed, 'The weighed quantity is the seller\'s to write.').toBeNull();
  });

  it('writes neither header nor lines when one line is bad', async () => {
    const chops = await variantOf(butcheryId, 'Lamb Chops', { unit: 'per kg' });
    const before = await orderCount(butcheryId);

    const { error } = await place(buyer, butcheryId, [
      { variant_id: chops.id, qty: 1 },
      { variant_id: crypto.randomUUID(), qty: 1 },
    ]);

    expect(error, 'An order with an unknown variant was accepted.').not.toBeNull();
    expect(error!.message).toMatch(/line 2/i);

    expect(
      await orderCount(butcheryId),
      'A header survived a failed order — the write is not atomic, and the ' +
        'seller now has an empty order in their queue.',
    ).toBe(before);
  });

  it('refuses a variant belonging to another tenant', async () => {
    const foreign = await variantOf(shoesId, 'Court Classic', { size: '8', colour: 'white' });
    const { error } = await place(buyer, butcheryId, [{ variant_id: foreign.id, qty: 1 }]);

    expect(error, 'A line from another tenant\'s catalogue was accepted.').not.toBeNull();
    expect(error!.message).toMatch(/line 1/i);
  });

  it('refuses an unavailable variant, naming the line', async () => {
    const { data: item } = await admin
      .from('items')
      .insert({ tenant_id: butcheryId, name: `Place RPC Sold Out ${Date.now()}`, active: true })
      .select()
      .single();
    createdItemIds.push(item!.id);

    const { data: variants } = await admin
      .from('variants')
      .insert([
        { tenant_id: butcheryId, item_id: item!.id, attributes: { unit: 'per kg' }, price: 100, available: true },
        { tenant_id: butcheryId, item_id: item!.id, attributes: { unit: 'per pack' }, price: 50, available: false },
      ])
      .select();

    const { error } = await place(buyer, butcheryId, [
      { variant_id: variants![0].id, qty: 1 },
      { variant_id: variants![1].id, qty: 1 },
    ]);

    expect(error, 'A sold-out variant was ordered.').not.toBeNull();
    expect(
      error!.message,
      'The refusal did not name the line. A cart held open while the seller ' +
        'edited the catalogue must fail cleanly, saying which item.',
    ).toMatch(/line 2/i);
  });

  it('refuses a retired variant', async () => {
    const { data: item } = await admin
      .from('items')
      .insert({ tenant_id: butcheryId, name: `Place RPC Retired ${Date.now()}`, active: true })
      .select()
      .single();
    createdItemIds.push(item!.id);

    const { data: variant } = await admin
      .from('variants')
      .insert({
        tenant_id: butcheryId,
        item_id: item!.id,
        attributes: { unit: 'per kg' },
        price: 100,
        available: false,
        retired_at: new Date().toISOString(),
      })
      .select()
      .single();

    const { error } = await place(buyer, butcheryId, [{ variant_id: variant!.id, qty: 1 }]);
    expect(error, 'A retired variant was ordered. Buyers must never reach one.').not.toBeNull();
    expect(error!.message).toMatch(/line 1/i);
  });

  it('refuses an inactive tenant', async () => {
    const { data: tenant } = await admin
      .from('tenants')
      .insert({
        slug: `place-rpc-inactive-${Date.now()}`,
        name: 'Place RPC Inactive',
        active: false,
        attribute_schema: [],
        branding: {},
      })
      .select()
      .single();
    createdTenantIds.push(tenant!.id);

    const { data: item } = await admin
      .from('items')
      .insert({ tenant_id: tenant!.id, name: 'Hidden Item', active: true })
      .select()
      .single();
    const { data: variant } = await admin
      .from('variants')
      .insert({ tenant_id: tenant!.id, item_id: item!.id, attributes: {}, price: 10, available: true })
      .select()
      .single();

    const { error } = await place(buyer, tenant!.id, [{ variant_id: variant!.id, qty: 1 }]);
    expect(error, 'An order was placed against a tenant with active = false.').not.toBeNull();
    expect(error!.message).toMatch(/not taking orders/i);
  });

  it('generates a unique reference a seller can read aloud', async () => {
    const chops = await variantOf(butcheryId, 'Lamb Chops', { unit: 'per kg' });
    const references: string[] = [];

    for (let i = 0; i < 4; i += 1) {
      const { error, placed } = await place(buyer, butcheryId, [{ variant_id: chops.id, qty: 1 }]);
      expect(error, `place failed: ${error?.message}`).toBeNull();
      references.push(placed!.order.reference);
    }

    for (const reference of references) {
      expect(
        reference,
        `"${reference}" is not a five-character code from the spoken-safe alphabet. ` +
          'The seller reads this out on WhatsApp while serving somebody else.',
      ).toMatch(REFERENCE);
      expect(
        reference,
        `"${reference}" contains a character that is misheard: I and L sound like 1, ` +
          'O like 0.',
      ).not.toMatch(/[ILOU01]/);
    }

    expect(
      new Set(references).size,
      'Two orders in the same shop got the same reference. (tenant_id, reference) ' +
        'is unique, so this should have been impossible.',
    ).toBe(references.length);

    // Drawn, not counted. The scheme this replaced put a tenant's order number
    // in the digits, and consecutive orders read as consecutive codes.
    expect(
      references.every((reference) => /^[A-Z]\d+$/.test(reference)),
      'The references look like a letter followed by a running number. That ' +
        'shape told a buyer how many orders the shop had taken.',
    ).toBe(false);
  });

  it('coexists with the references already in the seed', async () => {
    // Uniqueness is per tenant, so A47 and the Q4- fixtures keep their
    // identities forever. Nothing renumbers when the format changes.
    const { data: seeded } = await admin
      .from('orders')
      .select('reference')
      .eq('tenant_id', butcheryId)
      .eq('reference', 'A47');
    expect(
      seeded ?? [],
      'A seeded reference was renumbered. An order\'s reference is its identity ' +
        'in a WhatsApp thread — it cannot change under the seller.',
    ).toHaveLength(1);
  });

  it('no longer exposes a reference generator to buyers', async () => {
    // The counter was SECURITY DEFINER, and place_order is SECURITY INVOKER, so
    // it had to be granted to `authenticated` — the role every buyer session
    // holds. Any visitor could pass any tenant id and read that shop's order
    // count back out of the digits.
    const { error } = await buyer.rpc(
      'next_order_reference' as never,
      { p_tenant_id: shoesId } as never,
    );
    expect(
      error,
      'next_order_reference is still callable. A buyer session can read any ' +
        'tenant\'s order count — that is a client\'s trading volume.',
    ).not.toBeNull();
  });

  it('grants Data API execute on a SECURITY DEFINER function only where documented', async () => {
    const { data, error } = await admin
      .from('security_definer_functions')
      .select('function_name, arguments, anon_can_execute, authenticated_can_execute');

    expect(error, `could not read the definer list: ${error?.message}`).toBeNull();

    const found: Record<string, DefinerGrants> = {};
    for (const row of data ?? []) {
      // Overloads share a name and would each need the same answer, so an OR
      // across them is the honest reading: reachable by that role at all.
      const name = row.function_name as string;
      const current = found[name] ?? { anon: false, authenticated: false };
      found[name] = {
        anon: current.anon || Boolean(row.anon_can_execute),
        authenticated: current.authenticated || Boolean(row.authenticated_can_execute),
      };
    }

    expect(
      Object.keys(found).sort(),
      'The set of SECURITY DEFINER functions changed. Each one runs as the table ' +
        'owner and is exempt from RLS, so a new one is a hole until argued ' +
        'otherwise. Add it to EXPECTED_DEFINERS only with that argument written ' +
        'into its migration.',
    ).toEqual(Object.keys(EXPECTED_DEFINERS).sort());

    expect(
      found,
      'Execute privileges on a SECURITY DEFINER function changed. Definer alone ' +
        'is ordinary — several of these must be. Definer AND callable by anon or ' +
        'authenticated is the pair that let next_order_reference hand any buyer ' +
        'session any tenant\'s order count, because a storefront visitor holds ' +
        'both roles and chooses the arguments. A new `true` here is that pair ' +
        'forming again.',
    ).toEqual(EXPECTED_DEFINERS);
  });

  it('refuses a part quantity on a unit tenant', async () => {
    const shoe = await variantOf(shoesId, 'Court Classic', { size: '8', colour: 'white' });
    const { error } = await place(buyer, shoesId, [{ variant_id: shoe.id, qty: 1.5 }], {
      delivery_address: '1 Test Road',
    });

    expect(
      error,
      'Half a shoe was ordered. Whether quantities are whole is read from the ' +
        'tenant\'s sale_mode, not trusted to the client.',
    ).not.toBeNull();
    expect(error!.message).toMatch(/line 1/i);
  });

  it('refuses an order with no name or no phone', async () => {
    const chops = await variantOf(butcheryId, 'Lamb Chops', { unit: 'per kg' });

    for (const details of [{ customer_name: '  ' }, { customer_phone: '' }]) {
      const { error } = await place(buyer, butcheryId, [{ variant_id: chops.id, qty: 1 }], details);
      expect(
        error,
        `An order was placed with ${JSON.stringify(details)}. The seller cannot ` +
          'reach a buyer they have no name or number for.',
      ).not.toBeNull();
    }
  });
});
