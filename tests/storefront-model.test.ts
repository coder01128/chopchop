// The storefront's rules, without a browser.
//
//   npx vitest run tests/storefront-model.test.ts
//
// Cart arithmetic, estimate language, sold-out under each stock_mode, and the
// text the seller actually receives on WhatsApp. None of these need a database
// or a DOM, and all of them are things that break silently on a phone.

import { describe, expect, it } from 'vitest';
import {
  addLine,
  buildOrderMessage,
  cartTotal,
  describeStatus,
  formatQty,
  isSoldOut,
  lineTotal,
  matchVariant,
  parseQty,
  readsAsNotOurs,
  plainMoney,
  quantityStep,
  selectorsFor,
  setLineQty,
  showsWeighedQuantity,
  totalIsEstimate,
  variantLabel,
  whatsappUrl,
  type CartLine,
  type StorefrontVariant,
} from '../apps/storefront/src/storefront-model';

function variant(overrides: Partial<StorefrontVariant> = {}): StorefrontVariant {
  return {
    id: 'v1',
    itemId: 'i1',
    attributes: { size: '8', colour: 'white' },
    price: 100,
    stock: 5,
    available: true,
    ...overrides,
  };
}

describe('quantities', () => {
  it('takes decimals on a weight tenant and whole numbers on a unit tenant', () => {
    expect(quantityStep('weight')).toBe(0.001);
    expect(quantityStep('unit')).toBe(1);

    // Three places, matching variants.stock and order_items.qty.
    expect(parseQty('1.255', 'weight')).toBe(1.255);
    expect(parseQty('0.4567', 'weight')).toBe(0.457);
    expect(parseQty('2', 'unit')).toBe(2);
    expect(parseQty('2.6', 'unit')).toBe(2);
  });

  it('refuses what is not a quantity', () => {
    for (const raw of ['', '  ', 'abc', '0', '-1']) {
      expect(parseQty(raw, 'weight'), `"${raw}" was accepted`).toBeNull();
      expect(parseQty(raw, 'unit'), `"${raw}" was accepted`).toBeNull();
    }
  });

  it('formats without trailing noise', () => {
    expect(formatQty(1.5, 'weight')).toBe('1.5');
    expect(formatQty(2, 'weight')).toBe('2');
    expect(formatQty(1.25, 'weight')).toBe('1.25');
    expect(formatQty(3, 'unit')).toBe('3');
  });
});

describe('cart arithmetic', () => {
  const chops: CartLine = { variantId: 'v1', name: 'Lamb Chops — per kg', price: 259.9, qty: 1.5 };
  const wors: CartLine = { variantId: 'v2', name: 'Boerewors — per pack', price: 59.95, qty: 2 };

  it('rounds each line to cents', () => {
    expect(lineTotal(chops)).toBe(389.85);
    expect(lineTotal({ price: 189.9, qty: 1.255 })).toBe(238.32);
  });

  it('totals a cart of decimal quantities', () => {
    expect(cartTotal([chops, wors])).toBe(509.75);
  });

  it('tops up an existing line rather than repeating it', () => {
    const once = addLine([], chops);
    const twice = addLine(once, { ...chops, qty: 0.75 });

    expect(twice, 'The same variant was added as a second line.').toHaveLength(1);
    expect(twice[0].qty).toBe(2.25);
  });

  it('sets a line quantity outright', () => {
    expect(setLineQty([chops, wors], 'v2', 5)[1].qty).toBe(5);
  });
});

describe('estimate language', () => {
  it('is present on a weight tenant and absent on a unit tenant', () => {
    expect(totalIsEstimate('weight')).toBe(true);
    expect(
      totalIsEstimate('unit'),
      'A unit tenant showed estimate language. The total is the total.',
    ).toBe(false);
  });
});

describe('sold out', () => {
  it('follows the count on a counted tenant', () => {
    expect(isSoldOut(variant({ stock: 3 }), 'counted')).toBe(false);
    expect(isSoldOut(variant({ stock: 0 }), 'counted')).toBe(true);
    // Confirming an order decrements past zero rather than refusing, so a
    // negative count is a real state a buyer can meet.
    expect(isSoldOut(variant({ stock: -2 }), 'counted')).toBe(true);
  });

  it('follows the toggle alone on an availability tenant', () => {
    // Their count is not maintained — they also sell over a counter — so a zero
    // must not hide a product that is actually on the shelf.
    expect(isSoldOut(variant({ stock: 0, available: true }), 'availability')).toBe(false);
    expect(isSoldOut(variant({ stock: 99, available: false }), 'availability')).toBe(true);
  });

  it('respects the toggle on a counted tenant too', () => {
    expect(isSoldOut(variant({ stock: 10, available: false }), 'counted')).toBe(true);
  });
});

describe('selectors', () => {
  const shoes = [
    variant({ id: 'a', attributes: { size: '7', colour: 'white' } }),
    variant({ id: 'b', attributes: { size: '8', colour: 'black' } }),
  ];

  it('come from the product\'s own variants, in palette order', () => {
    const selectors = selectorsFor(shoes, ['size', 'colour']);
    expect(selectors.map((s) => s.name)).toEqual(['size', 'colour']);
    expect(selectors[0].values).toEqual(['7', '8']);
    expect(selectors[1].values).toEqual(['white', 'black']);
  });

  it('does not invent an attribute the product does not use', () => {
    // The tenant gained `width`; this product predates it and must not sprout
    // an empty selector. attribute_schema is a palette, not a mandate.
    const selectors = selectorsFor(shoes, ['size', 'colour', 'width']);
    expect(selectors.map((s) => s.name)).toEqual(['size', 'colour']);
  });

  it('labels a variant in the same order place_order stores it', () => {
    expect(variantLabel({ colour: 'white', size: '8' }, ['size', 'colour'])).toBe('8 / white');
    expect(variantLabel({ unit: 'per kg' }, ['unit'])).toBe('per kg');
    expect(variantLabel({}, [])).toBe('');
  });

  it('matches a chosen combination exactly', () => {
    expect(matchVariant(shoes, { size: '8', colour: 'black' })?.id).toBe('b');
    expect(matchVariant(shoes, { size: '8', colour: 'white' })).toBeNull();
  });
});

describe('the WhatsApp message', () => {
  const order = {
    reference: 'B08',
    customerName: 'Thandi Mokoena',
    deliveryAddress: null,
    notes: null,
    total: 509.75,
    lines: [
      { name: 'Lamb Chops — per kg', qty: 1.5 },
      { name: 'Boerewors — per pack', qty: 2 },
    ],
  };

  it('leads with the reference and labels a weight total an estimate', () => {
    expect(buildOrderMessage(order, 'weight', 'collect')).toBe(
      [
        'Order B08',
        '',
        '• Lamb Chops — per kg × 1.5',
        '• Boerewors — per pack × 2',
        '',
        'Estimated total: R 509.75',
        '',
        'Collecting',
        'Thandi Mokoena',
      ].join('\n'),
    );
  });

  it('carries the address on a delivery order and no estimate on a unit tenant', () => {
    const delivery = {
      ...order,
      reference: 'S12',
      deliveryAddress: '12 Long Street, Salt River',
      notes: 'Ring the bell',
      total: 1348,
      lines: [{ name: 'Court Classic — 8 / white', qty: 1 }],
    };

    expect(buildOrderMessage(delivery, 'unit', 'local_delivery')).toBe(
      [
        'Order S12',
        '',
        '• Court Classic — 8 / white × 1',
        '',
        'Total: R 1348.00',
        '',
        'Delivery: 12 Long Street, Salt River',
        'Thandi Mokoena',
        '',
        'Ring the bell',
      ].join('\n'),
    );
  });

  it('speaks the tenant\'s own vocabulary', () => {
    const message = buildOrderMessage(order, 'weight', 'collect', {
      order: 'Bestelling',
      estimate: 'Geskatte totaal',
      total: 'Totaal',
      collect: 'Haal self op',
      delivery: 'Aflewering',
    });
    expect(message.startsWith('Bestelling B08')).toBe(true);
    expect(message).toContain('Geskatte totaal: R 509.75');
    expect(message).toContain('Haal self op');
  });

  it('uses a plain currency prefix, not a non-breaking space', () => {
    // Intl emits U+00A0, which survives encoding as %C2%A0 and reads as a
    // stray character in some WhatsApp clients.
    expect(plainMoney(509.75)).toBe('R 509.75');
    expect(plainMoney(509.75)).not.toContain(' ');
  });

  it('builds a wa.me url that survives newlines and Afrikaans characters', () => {
    const url = whatsappUrl('27821234567', 'Bestelling B08\nBoerewors — 2kg\nDankie, Móller');
    expect(url).toBe(
      'https://wa.me/27821234567?text=' +
        encodeURIComponent('Bestelling B08\nBoerewors — 2kg\nDankie, Móller'),
    );
    expect(url).toContain('%0A');
    expect(url, 'a raw newline reached the URL').not.toContain('\n');
  });

  it('strips anything that is not a digit, and refuses an empty number', () => {
    expect(whatsappUrl('+27 82 123 4567', 'hi')?.startsWith('https://wa.me/27821234567')).toBe(true);
    expect(whatsappUrl(null, 'hi')).toBeNull();
    expect(whatsappUrl('', 'hi')).toBeNull();
  });
});

describe('buyer-facing status', () => {
  it('never shows the enum', () => {
    for (const status of ['sent', 'received', 'confirmed', 'ready', 'completed', 'cancelled'] as const) {
      const copy = describeStatus(status, 'collect');
      expect(copy.title.toLowerCase(), `"${status}" was shown raw`).not.toBe(status);
      expect(copy.title.length).toBeGreaterThan(0);
    }
  });

  it('reads a dismissal as a message that never arrived, not an accusation', () => {
    const copy = describeStatus('cancelled', 'collect');
    expect(copy.title).toMatch(/did not receive/i);
    expect(copy.body).toMatch(/whatsapp/i);
    expect(copy.live).toBe(false);
  });

  it('says collect or on the way according to the tenant', () => {
    expect(describeStatus('ready', 'collect').title).toMatch(/collect/i);
    expect(describeStatus('ready', 'local_delivery').title).toMatch(/on the way/i);
  });

  it('shows both figures once a weight order is weighed', () => {
    expect(showsWeighedQuantity({ qty: 1.5, qtyConfirmed: 1.62 }, 'weight')).toBe(true);
    // Nothing to show when the seller did not adjust it.
    expect(showsWeighedQuantity({ qty: 1.5, qtyConfirmed: 1.5 }, 'weight')).toBe(false);
    expect(showsWeighedQuantity({ qty: 1.5, qtyConfirmed: null }, 'weight')).toBe(false);
    // And never on a unit tenant, where no weight language appears at all.
    expect(showsWeighedQuantity({ qty: 2, qtyConfirmed: 3 }, 'unit')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A refused read is not an error the buyer should ever see.
// ---------------------------------------------------------------------------

describe('readsAsNotOurs', () => {
  // The session-less case: no grant on `orders` for anon, so PostgREST refuses
  // before RLS is consulted. Opening a forwarded link, or the same link on a
  // laptop, lands here — and to the buyer it means the same thing as an order
  // that isn't theirs.
  it('is true for a refused read', () => {
    expect(readsAsNotOurs({ code: '42501', message: 'permission denied for table orders' })).toBe(
      true,
    );
  });

  it('is true for a missing or rejected session', () => {
    expect(readsAsNotOurs({ code: 'PGRST301', message: 'JWT expired' })).toBe(true);
    expect(readsAsNotOurs({ code: null, message: 'invalid JWT' })).toBe(true);
  });

  // Everything else is a real failure and gets the try-again screen, never the
  // database's own words.
  it('is false for a genuine failure', () => {
    expect(readsAsNotOurs({ code: '500', message: 'Failed to fetch' })).toBe(false);
    expect(readsAsNotOurs({ code: null, message: null })).toBe(false);
    expect(readsAsNotOurs({})).toBe(false);
  });
});
