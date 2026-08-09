// public.confirm_order — the atomic confirm, and the stock decrement.
//
//   npx vitest run tests/confirm-order-rpc.test.ts
//
// Confirming is the one transition that moves stock, and none of what matters
// here is visible in the browser when it goes right: the whole confirm lands as
// one unit, a counted tenant's stock moves exactly once, an availability
// tenant's does not move at all, and the function is not a way around the
// tenant boundary.
//
// The seed's two demo tenants are deliberately opposite — demo-butchery is
// `availability` (and `weight`), demo-shoes is `counted` (and `unit`) — so both
// stock paths have a real tenant to run against and nothing here has to flip a
// mode or touch the seed. Every fixture below is created and torn down by this
// file.
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
let shoes: SupabaseClient;
let butcheryTenantId: string;
let shoesTenantId: string;

const createdOrderIds: string[] = [];
const createdItemIds: string[] = [];

async function signIn(email: string): Promise<SupabaseClient> {
  const client = createClient(url!, publishableKey!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password: DEMO_PASSWORD });
  if (error) throw new Error(`Could not sign in as ${email}: ${error.message}`);
  return client;
}

interface FixtureLine {
  /** Starting count on the variant this line points at. */
  stock: number;
  price: number;
  qty: number;
}

interface Fixture {
  orderId: string;
  lines: { id: string; variantId: string; price: number; qty: number }[];
}

/**
 * A product, its variants and an order sitting on the status a confirm is
 * reachable from. Built with the service role: this is scaffolding, not an
 * access assertion, and every assertion below runs as a signed-in seller.
 */
async function makeOrder(
  tenantId: string,
  lines: FixtureLine[],
  status: 'received' | 'sent' | 'confirmed' = 'received',
): Promise<Fixture> {
  const { data: item, error: itemError } = await admin
    .from('items')
    .insert({ tenant_id: tenantId, name: `Confirm RPC ${Date.now()}-${Math.random()}`, active: true })
    .select()
    .single();
  if (itemError) throw new Error(`fixture item failed: ${itemError.message}`);
  createdItemIds.push(item.id);

  const { data: variants, error: variantError } = await admin
    .from('variants')
    .insert(
      lines.map((line, index) => ({
        tenant_id: tenantId,
        item_id: item.id,
        attributes: { fixture: String(index) },
        price: line.price,
        stock: line.stock,
        available: true,
      })),
    )
    .select();
  if (variantError) throw new Error(`fixture variants failed: ${variantError.message}`);

  const { data: order, error: orderError } = await admin
    .from('orders')
    .insert({
      tenant_id: tenantId,
      reference: `CT-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      customer_name: 'Confirm RPC Test',
      customer_phone: '27820000000',
      fulfilment: 'collect',
      status,
      total: lines.reduce((sum, line) => sum + line.price * line.qty, 0),
    })
    .select()
    .single();
  if (orderError) throw new Error(`fixture order failed: ${orderError.message}`);
  createdOrderIds.push(order.id);

  const { data: rows, error: lineError } = await admin
    .from('order_items')
    .insert(
      lines.map((line, index) => ({
        tenant_id: tenantId,
        order_id: order.id,
        variant_id: variants![index].id,
        name_snapshot: `Fixture line ${index}`,
        price_snapshot: line.price,
        qty: line.qty,
        qty_confirmed: null,
        line_total: line.price * line.qty,
      })),
    )
    .select();
  if (lineError) throw new Error(`fixture lines failed: ${lineError.message}`);

  return {
    orderId: order.id,
    lines: rows!.map((row, index) => ({
      id: row.id,
      variantId: variants![index].id,
      price: lines[index].price,
      qty: lines[index].qty,
    })),
  };
}

async function stockOf(variantId: string): Promise<number> {
  const { data } = await admin.from('variants').select('stock').eq('id', variantId).single();
  return Number(data!.stock);
}

async function orderRow(orderId: string) {
  const { data } = await admin
    .from('orders')
    .select('status, total, confirmed_at')
    .eq('id', orderId)
    .single();
  return data!;
}

beforeAll(async () => {
  const { data: tenants, error } = await admin
    .from('tenants')
    .select('id, slug, stock_mode')
    .in('slug', [DEMO_USERS.butchery.slug, DEMO_USERS.shoes.slug]);
  if (error) throw new Error(error.message);

  const butcheryRow = tenants!.find((t) => t.slug === DEMO_USERS.butchery.slug)!;
  const shoesRow = tenants!.find((t) => t.slug === DEMO_USERS.shoes.slug)!;
  butcheryTenantId = butcheryRow.id;
  shoesTenantId = shoesRow.id;

  // The no-decrement case needs a tenant that really is on `availability`, and
  // the decrement cases one that really is on `counted`. Fail loudly rather
  // than passing vacuously if the seed ever stops being opposite.
  expect(
    butcheryRow.stock_mode,
    'demo-butchery is no longer an availability tenant — the no-decrement case ' +
      'has nothing to run against. Restore the seed, or give this file its own ' +
      'availability fixture tenant.',
  ).toBe('availability');
  expect(
    shoesRow.stock_mode,
    'demo-shoes is no longer a counted tenant — every decrement assertion below ' +
      'would pass vacuously.',
  ).toBe('counted');

  butchery = await signIn(DEMO_USERS.butchery.email);
  shoes = await signIn(DEMO_USERS.shoes.email);
});

afterAll(async () => {
  // Orders first: order_items.variant_id is ON DELETE RESTRICT, so the lines
  // have to go before the variants they point at. Deleting the item cascades
  // its variants.
  for (const id of createdOrderIds) await admin.from('orders').delete().eq('id', id);
  for (const id of createdItemIds) await admin.from('items').delete().eq('id', id);
  await butchery?.auth.signOut();
  await shoes?.auth.signOut();
});

describe('confirm_order', () => {
  it('decrements a counted tenant by the quantity actually taken', async () => {
    const fixture = await makeOrder(shoesTenantId, [
      { stock: 10, price: 100, qty: 2 },
      { stock: 10, price: 50, qty: 4 },
    ]);

    // The seller adjusted the first line and left the second alone. The
    // decrement follows qty_confirmed where there is one and qty where there is
    // not — never both, and never qty when a confirmed quantity exists.
    const { data, error } = await shoes.rpc('confirm_order', {
      p_tenant_id: shoesTenantId,
      p_order_id: fixture.orderId,
      p_lines: [
        { id: fixture.lines[0].id, qty_confirmed: 3, line_total: 300 },
        { id: fixture.lines[1].id, qty_confirmed: null, line_total: 200 },
      ],
    });

    expect(error, `confirm failed: ${error?.message}`).toBeNull();

    expect(await stockOf(fixture.lines[0].variantId), 'qty_confirmed was not what moved stock').toBe(7);
    expect(await stockOf(fixture.lines[1].variantId), 'qty did not move stock on an unadjusted line').toBe(6);

    const order = await orderRow(fixture.orderId);
    expect(order.status).toBe('confirmed');
    expect(order.confirmed_at, 'confirmed_at was not stamped').not.toBeNull();
    expect(Number(order.total), 'the total was not recomputed from the lines').toBe(500);

    // Returned so the detail screen reconciles without a second trip.
    const returned = data as { order: { id: string; status: string }; lines: unknown[] };
    expect(returned.order.id).toBe(fixture.orderId);
    expect(returned.order.status).toBe('confirmed');
    expect(returned.lines).toHaveLength(2);
  });

  it('does not touch stock on an availability tenant', async () => {
    const fixture = await makeOrder(butcheryTenantId, [{ stock: 5, price: 189.9, qty: 2 }]);

    const { error } = await butchery.rpc('confirm_order', {
      p_tenant_id: butcheryTenantId,
      p_order_id: fixture.orderId,
      p_lines: [{ id: fixture.lines[0].id, qty_confirmed: 2.15, line_total: 408.29 }],
    });
    expect(error, `confirm failed: ${error?.message}`).toBeNull();

    expect(
      await stockOf(fixture.lines[0].variantId),
      'An availability tenant\'s stock moved. There is no count to move, and a ' +
        'decrement against a figure the seller is never shown empties their shop.',
    ).toBe(5);

    // The confirm itself still did its work — the weighed quantity and the real
    // total are the whole point of confirming on a weight tenant.
    const order = await orderRow(fixture.orderId);
    expect(order.status).toBe('confirmed');
    expect(Number(order.total)).toBe(408.29);

    const { data: line } = await admin
      .from('order_items')
      .select('qty_confirmed, line_total')
      .eq('id', fixture.lines[0].id)
      .single();
    expect(Number(line!.qty_confirmed)).toBe(2.15);
    expect(Number(line!.line_total)).toBe(408.29);
  });

  it('lets the count go negative rather than refusing the confirm', async () => {
    const fixture = await makeOrder(shoesTenantId, [{ stock: 1, price: 100, qty: 4 }]);

    const { error } = await shoes.rpc('confirm_order', {
      p_tenant_id: shoesTenantId,
      p_order_id: fixture.orderId,
      p_lines: [{ id: fixture.lines[0].id, qty_confirmed: null, line_total: 400 }],
    });

    expect(
      error,
      'The confirm was refused for insufficient stock. The seller has already ' +
        'cut the meat — a refusal does not un-cut it, it only leaves them unable ' +
        'to record what happened.',
    ).toBeNull();

    expect(
      await stockOf(fixture.lines[0].variantId),
      'The count was clamped instead of going negative. A negative count is the ' +
        'prompt to recount; clamping hides it.',
    ).toBe(-3);
    expect((await orderRow(fixture.orderId)).status).toBe('confirmed');
  });

  it('refuses a payload carrying another tenant\'s id', async () => {
    const fixture = await makeOrder(shoesTenantId, [{ stock: 10, price: 100, qty: 1 }]);

    const { error } = await butchery.rpc('confirm_order', {
      p_tenant_id: shoesTenantId,
      p_order_id: fixture.orderId,
      p_lines: [{ id: fixture.lines[0].id, qty_confirmed: null, line_total: 100 }],
    });

    expect(
      error,
      'A seller confirmed against another tenant. confirm_order must reject a ' +
        'foreign tenant_id explicitly, not rely on RLS to filter it silently — ' +
        '"confirmed nothing" and "you may not do that" must not look the same.',
    ).not.toBeNull();
    expect(error!.message).toMatch(/does not belong to tenant/i);

    expect((await orderRow(fixture.orderId)).status).toBe('received');
    expect(await stockOf(fixture.lines[0].variantId)).toBe(10);
  });

  it('refuses to confirm an order belonging to another tenant', async () => {
    const fixture = await makeOrder(shoesTenantId, [{ stock: 10, price: 100, qty: 1 }]);

    // Own tenant id, someone else's order — the shape RLS alone would answer
    // with an empty result rather than a refusal.
    const { error } = await butchery.rpc('confirm_order', {
      p_tenant_id: butcheryTenantId,
      p_order_id: fixture.orderId,
      p_lines: [],
    });

    expect(error, 'A seller confirmed another tenant\'s order by id.').not.toBeNull();
    expect(error!.message).toMatch(/does not belong to tenant/i);

    expect((await orderRow(fixture.orderId)).status).toBe('received');
    expect(await stockOf(fixture.lines[0].variantId)).toBe(10);
  });

  it('refuses an order that is not received', async () => {
    const fixture = await makeOrder(shoesTenantId, [{ stock: 10, price: 100, qty: 1 }], 'sent');

    const { error } = await shoes.rpc('confirm_order', {
      p_tenant_id: shoesTenantId,
      p_order_id: fixture.orderId,
      p_lines: [{ id: fixture.lines[0].id, qty_confirmed: null, line_total: 100 }],
    });

    expect(
      error,
      'A `sent` order was confirmed. Forward-only holds: received is an ' +
        'acknowledgement and confirmed is a promise, and a phantom order must ' +
        'not eat stock it never took.',
    ).not.toBeNull();
    expect(error!.message).toMatch(/only a received order can be confirmed/i);

    expect((await orderRow(fixture.orderId)).status).toBe('sent');
    expect(await stockOf(fixture.lines[0].variantId)).toBe(10);
  });

  it('re-confirming changes nothing and does not decrement twice', async () => {
    const fixture = await makeOrder(shoesTenantId, [{ stock: 10, price: 100, qty: 3 }]);
    const payload = {
      p_tenant_id: shoesTenantId,
      p_order_id: fixture.orderId,
      p_lines: [{ id: fixture.lines[0].id, qty_confirmed: null, line_total: 300 }],
    };

    const first = await shoes.rpc('confirm_order', payload);
    expect(first.error, `first confirm failed: ${first.error?.message}`).toBeNull();
    const after = await orderRow(fixture.orderId);
    expect(await stockOf(fixture.lines[0].variantId)).toBe(7);

    // A double-tap, or a retry after a dropped response. Idempotent, not an
    // error the seller has to interpret.
    const second = await shoes.rpc('confirm_order', payload);
    expect(
      second.error,
      'Re-confirming threw. A double-tap should return the order unchanged, not ' +
        'hand the seller an exception to interpret.',
    ).toBeNull();

    expect(
      await stockOf(fixture.lines[0].variantId),
      'STOCK DECREMENTED TWICE. A double-tap of Confirm took the goods off the ' +
        'shelf twice.',
    ).toBe(7);

    const again = await orderRow(fixture.orderId);
    expect(again.confirmed_at, 'confirmed_at was re-stamped by a re-confirm.').toBe(after.confirmed_at);
    expect(Number(again.total)).toBe(Number(after.total));

    const returned = second.data as { order: { status: string }; lines: unknown[] };
    expect(returned.order.status).toBe('confirmed');
    expect(returned.lines).toHaveLength(1);
  });

  it('rolls back completely when one line is invalid', async () => {
    const fixture = await makeOrder(shoesTenantId, [
      { stock: 10, price: 100, qty: 2 },
      { stock: 10, price: 50, qty: 1 },
    ]);

    // A negative qty_confirmed violates order_items_qty_confirmed_non_negative.
    // The first line's write and the decrement are in the same transaction, so
    // if that transaction is real, none of it survives.
    const { error } = await shoes.rpc('confirm_order', {
      p_tenant_id: shoesTenantId,
      p_order_id: fixture.orderId,
      p_lines: [
        { id: fixture.lines[0].id, qty_confirmed: 5, line_total: 500 },
        { id: fixture.lines[1].id, qty_confirmed: -1, line_total: -50 },
      ],
    });

    expect(error, 'An invalid quantity was accepted.').not.toBeNull();

    const order = await orderRow(fixture.orderId);
    expect(
      order.status,
      'The order was confirmed by a failed confirm — the write is not atomic.',
    ).toBe('received');
    expect(order.confirmed_at, 'confirmed_at was stamped by a failed confirm.').toBeNull();

    const { data: lines } = await admin
      .from('order_items')
      .select('id, qty_confirmed')
      .eq('order_id', fixture.orderId);
    expect(
      (lines ?? []).every((line) => line.qty_confirmed === null),
      'A weighed quantity survived a failed confirm — the write is not atomic.',
    ).toBe(true);

    expect(
      await stockOf(fixture.lines[0].variantId),
      'HALF-DECREMENTED STOCK: a failed confirm moved stock on one line.',
    ).toBe(10);
    expect(await stockOf(fixture.lines[1].variantId)).toBe(10);
  });
});
