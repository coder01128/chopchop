// Spreadsheet import's rules, tested without a browser or a database.
//
//   npm run test
//
// These are pure functions on purpose. The claims worth testing are claims
// about data — that a re-import of a grown price list produces 34 products and
// not 54, and that a product missing from the file is never touched by
// anything. Both are checkable here, cheaply, and the browser pass then only
// has to confirm the screens are wired to them.

import { describe, expect, it } from 'vitest';
import type { TenantAttribute } from '@chopchop/shared';
import {
  buildPlan,
  collectCategories,
  describeAttributes,
  guessMapping,
  ignoredHeaders,
  mappingProblems,
  nextSortOrders,
  normalise,
  parseNumber,
  readRows,
  resolveAsNew,
  toSavePayload,
  writableItems,
  type ExistingCatalogue,
  type ExistingItem,
  type ExistingVariant,
  type Mapping,
  type SheetTable,
} from '../apps/dashboard/src/import/import-model';
import { parseFile } from '../apps/dashboard/src/import/parse-file';

const SHOES: TenantAttribute[] = [
  { name: 'size', label: 'Size', options: ['7', '8', '9'] },
  { name: 'colour', label: 'Colour', options: ['white', 'black', 'red'] },
];

const BUTCHERY: TenantAttribute[] = [
  { name: 'unit', label: 'Sold by', options: ['per kg', 'per pack'] },
];

const COUNTED = { trackStock: true };
const AVAILABILITY = { trackStock: false };

function table(headers: string[], rows: string[][]): SheetTable {
  return { headers, rows };
}

function item(id: string, name: string, extra: Partial<ExistingItem> = {}): ExistingItem {
  return {
    id,
    name,
    description: null,
    imageUrl: null,
    categoryId: null,
    active: true,
    ...extra,
  };
}

function variant(
  id: string,
  itemId: string,
  attributes: Record<string, string>,
  extra: Partial<ExistingVariant> = {},
): ExistingVariant {
  return {
    id,
    itemId,
    attributes,
    price: 100,
    stock: 0,
    sku: null,
    available: true,
    retiredAt: null,
    ...extra,
  };
}

function catalogue(partial: Partial<ExistingCatalogue> = {}): ExistingCatalogue {
  return { items: [], variants: [], categories: [], ...partial };
}

/** Rows straight from a mapping, skipping the parser. */
function rowsFrom(headers: string[], rows: string[][], palette: TenantAttribute[]) {
  const sheet = table(headers, rows);
  return readRows(sheet, guessMapping(headers, palette));
}

// ===========================================================================
// Normalisation and parsing
// ===========================================================================

describe('normalise', () => {
  it('lowercases, collapses whitespace and trims', () => {
    expect(normalise('  Beef   Sausage ')).toBe('beef sausage');
    expect(normalise('BEEF SAUSAGE')).toBe(normalise('beef sausage'));
  });
});

describe('parseNumber', () => {
  it('reads money as people write it', () => {
    expect(parseNumber('89.50')).toBe(89.5);
    expect(parseNumber('R 89,50')).toBe(89.5);
    expect(parseNumber('R1,299.00')).toBe(1299);
    expect(parseNumber('1 299,00')).toBe(1299);
    expect(parseNumber('1,299')).toBe(1299);
  });

  it('returns null for anything that is not a number', () => {
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('POA')).toBeNull();
  });
});

// ===========================================================================
// Mapping
// ===========================================================================

describe('guessMapping', () => {
  it('guesses the common headings', () => {
    const mapping = guessMapping(['Product', 'Price', 'Category', 'Qty', 'SKU'], []);
    expect(mapping).toEqual(['name', 'price', 'category', 'stock', 'sku']);
  });

  it('offers a column per tenant attribute, and the palette wins on a clash', () => {
    // `unit` would otherwise be swallowed by the stock hints.
    const mapping = guessMapping(['Item', 'Sold by', 'Price'], BUTCHERY);
    expect(mapping).toEqual(['name', 'attribute:unit', 'price']);
  });

  it('maps a shoe shop\'s two attributes independently', () => {
    const mapping = guessMapping(['Name', 'Size', 'Colour', 'Price'], SHOES);
    expect(mapping).toEqual(['name', 'attribute:size', 'attribute:colour', 'price']);
  });

  it('names every column it is ignoring', () => {
    const sheet = table(['Product', 'Price', 'Supplier', 'Notes'], []);
    const mapping = guessMapping(sheet.headers, []);
    expect(ignoredHeaders(sheet, mapping)).toEqual(['Supplier', 'Notes']);
  });

  it('will not proceed without a name and a price column', () => {
    const problems = mappingProblems(['ignore', 'ignore'] as Mapping);
    expect(problems).toHaveLength(2);
    expect(mappingProblems(['name', 'price'] as Mapping)).toEqual([]);
  });
});

// ===========================================================================
// Rows
// ===========================================================================

describe('readRows', () => {
  it('a row with no attribute columns yields a single variant', () => {
    const rows = rowsFrom(['Product', 'Price'], [['Vacuum cleaner', '2499']], SHOES);
    expect(rows).toHaveLength(1);
    expect(rows[0].attributes).toEqual({});

    const plan = buildPlan(rows, catalogue(), COUNTED);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].variants).toHaveLength(1);
    expect(plan.items[0].variants[0].attributes).toEqual({});
  });

  it('missing name and missing price are errors, and the other rows survive', () => {
    const rows = rowsFrom(
      ['Product', 'Price'],
      [
        ['Boerewors', '89.90'],
        ['', '45.00'],
        ['Rump', ''],
        ['Lamb chops', '169.00'],
      ],
      BUTCHERY,
    );

    const plan = buildPlan(rows, catalogue(), COUNTED);

    expect(plan.counts.errorRows).toBe(2);
    expect(plan.errorRows.map((row) => row.line)).toEqual([3, 4]);
    expect(plan.errorRows[0].errors).toContain('No product name.');
    expect(plan.errorRows[1].errors).toContain('No price.');

    // The two good rows are unaffected — an error row does not abort the batch.
    expect(plan.counts.newProducts).toBe(2);
    expect(plan.items.map((entry) => entry.name)).toEqual(['Boerewors', 'Lamb chops']);
  });

  it('drops blank trailing rows rather than reporting them as errors', () => {
    const rows = rowsFrom(['Product', 'Price'], [['Boerewors', '89.90'], ['', ''], ['', '']], BUTCHERY);
    expect(rows).toHaveLength(1);
  });

  it('omits a blank attribute cell instead of storing an empty value', () => {
    const rows = rowsFrom(
      ['Name', 'Size', 'Colour', 'Price'],
      [['Sneaker', '8', '', '899']],
      SHOES,
    );
    expect(rows[0].attributes).toEqual({ size: '8' });
  });
});

// ===========================================================================
// Collapsing
// ===========================================================================

describe('collapsing', () => {
  it('rows sharing a name collapse into one item with several variants', () => {
    const rows = rowsFrom(
      ['Name', 'Size', 'Colour', 'Price'],
      [
        ['Sneaker', '8', 'black', '899'],
        ['Sneaker', '9', 'black', '899'],
        ['Sneaker', '8', 'white', '949'],
        ['Boot', '8', 'black', '1299'],
      ],
      SHOES,
    );

    const plan = buildPlan(rows, catalogue(), COUNTED);

    expect(plan.items).toHaveLength(2);
    const sneaker = plan.items.find((entry) => entry.name === 'Sneaker')!;
    expect(sneaker.variants).toHaveLength(3);
    // Four rows, two products — the counter is in products.
    expect(plan.counts.newProducts).toBe(2);
  });

  it('collapses on the normalised name, so spacing and case do not split a product', () => {
    const rows = rowsFrom(
      ['Name', 'Size', 'Price'],
      [
        ['Sneaker', '8', '899'],
        ['  sneaker ', '9', '899'],
        ['SNEAKER', '7', '899'],
      ],
      SHOES,
    );

    const plan = buildPlan(rows, catalogue(), COUNTED);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].variants).toHaveLength(3);
  });

  it('reports the same variant given twice rather than writing it twice', () => {
    const rows = rowsFrom(
      ['Name', 'Size', 'Price'],
      [
        ['Sneaker', '8', '899'],
        ['Sneaker', '8', '949'],
      ],
      SHOES,
    );

    const plan = buildPlan(rows, catalogue(), COUNTED);
    expect(plan.items[0].variants).toHaveLength(1);
    expect(plan.counts.errorRows).toBe(1);
    expect(plan.errorRows[0].errors[0]).toContain('row 2');
  });
});

// ===========================================================================
// Matching
// ===========================================================================

describe('matching', () => {
  const existing = catalogue({
    items: [item('item-1', 'Boerewors')],
    variants: [variant('var-1', 'item-1', { unit: 'per kg' }, { price: 89.9, sku: 'BW-KG' })],
  });

  it('matches by SKU when the row has one, ignoring the name', () => {
    const rows = rowsFrom(
      ['Name', 'Sold by', 'Price', 'SKU'],
      [['Wors (farm style)', 'per kg', '89.90', 'BW-KG']],
      BUTCHERY,
    );

    const plan = buildPlan(rows, existing, COUNTED);

    expect(plan.items[0].itemId).toBe('item-1');
    expect(plan.items[0].variants[0].variantId).toBe('var-1');
    // The name in the file differs, so that is a change the seller must see.
    expect(plan.items[0].changes).toEqual([
      { field: 'name', from: 'Boerewors', to: 'Wors (farm style)' },
    ]);
  });

  it('matches by normalised name — case, trailing space, double space', () => {
    for (const written of ['boerewors', 'Boerewors ', ' BOEREWORS']) {
      const rows = rowsFrom(['Name', 'Sold by', 'Price'], [[written, 'per kg', '89.90']], BUTCHERY);
      const plan = buildPlan(rows, existing, COUNTED);
      expect(plan.items[0].itemId, `"${written}" did not match the existing product`).toBe('item-1');
      expect(plan.items[0].variants[0].outcome).toBe('unchanged');
    }
  });

  it('collapses a doubled space in the middle of a name', () => {
    const rows = rowsFrom(['Name', 'Sold by', 'Price'], [['Boere wors', 'per kg', '89.90']], BUTCHERY);
    const withSpace = catalogue({
      items: [item('item-2', 'Boere  wors')],
      variants: [variant('var-2', 'item-2', { unit: 'per kg' }, { price: 89.9 })],
    });
    const plan = buildPlan(rows, withSpace, COUNTED);
    expect(plan.items[0].itemId).toBe('item-2');
  });

  it('no match is new', () => {
    const rows = rowsFrom(['Name', 'Sold by', 'Price'], [['Lamb chops', 'per kg', '169']], BUTCHERY);
    const plan = buildPlan(rows, existing, COUNTED);

    expect(plan.items[0].itemId).toBeNull();
    expect(plan.items[0].outcome).toBe('new');
    expect(plan.counts.newProducts).toBe(1);
  });

  it('two matches are ambiguous and are never auto-resolved', () => {
    const twins = catalogue({
      items: [item('item-a', 'Boerewors'), item('item-b', 'boerewors ')],
      variants: [
        variant('var-a', 'item-a', { unit: 'per kg' }),
        variant('var-b', 'item-b', { unit: 'per kg' }),
      ],
    });

    const rows = rowsFrom(['Name', 'Sold by', 'Price'], [['Boerewors', 'per kg', '95']], BUTCHERY);
    const plan = buildPlan(rows, twins, COUNTED);

    expect(plan.items[0].outcome).toBe('ambiguous');
    expect(plan.items[0].itemId).toBeNull();
    expect(plan.counts.ambiguousProducts).toBe(1);
    expect(plan.counts.updatedProducts).toBe(0);
    // Ambiguous writes nothing at all until the seller says which.
    expect(writableItems(plan)).toEqual([]);
  });

  it('SKUs pointing at two different products are ambiguous', () => {
    const spread = catalogue({
      items: [item('item-a', 'Sneaker'), item('item-b', 'Boot')],
      variants: [
        variant('var-a', 'item-a', { size: '8' }, { sku: 'S-8' }),
        variant('var-b', 'item-b', { size: '9' }, { sku: 'S-9' }),
      ],
    });

    const rows = rowsFrom(
      ['Name', 'Size', 'Price', 'SKU'],
      [
        ['Sneaker', '8', '899', 'S-8'],
        ['Sneaker', '9', '899', 'S-9'],
      ],
      SHOES,
    );

    const plan = buildPlan(rows, spread, COUNTED);
    expect(plan.items[0].outcome).toBe('ambiguous');
    expect(plan.items[0].reason).toContain('more than one existing product');
  });

  it('the seller can resolve an ambiguity as a new product, and nothing else changes', () => {
    const twins = catalogue({
      items: [item('item-a', 'Boerewors'), item('item-b', 'BOEREWORS')],
      variants: [
        variant('var-a', 'item-a', { unit: 'per kg' }),
        variant('var-b', 'item-b', { unit: 'per kg' }),
      ],
    });

    const rows = rowsFrom(['Name', 'Sold by', 'Price'], [['Boerewors', 'per kg', '95']], BUTCHERY);
    const plan = buildPlan(rows, twins, COUNTED);
    const resolved = resolveAsNew(plan, plan.items[0].key);

    expect(resolved.items[0].outcome).toBe('new');
    expect(resolved.items[0].itemId).toBeNull();
    expect(resolved.counts.ambiguousProducts).toBe(0);
    expect(resolved.counts.newProducts).toBe(1);
  });

  it('a retired variant is invisible to matching, so an import never restores one', () => {
    const withRetired = catalogue({
      items: [item('item-1', 'Sneaker')],
      variants: [
        variant('var-live', 'item-1', { size: '8' }),
        variant('var-gone', 'item-1', { size: '9' }, { retiredAt: '2026-07-01T00:00:00Z' }),
      ],
    });

    const rows = rowsFrom(['Name', 'Size', 'Price'], [['Sneaker', '9', '899']], SHOES);
    const plan = buildPlan(rows, withRetired, COUNTED);

    expect(plan.items[0].variants[0].outcome).toBe('new');
    expect(plan.items[0].variants[0].variantId).toBeNull();
  });
});

// ===========================================================================
// Differences
// ===========================================================================

describe('differences', () => {
  const existing = catalogue({
    items: [item('item-1', 'Sneaker')],
    variants: [variant('var-1', 'item-1', { size: '8' }, { price: 899, stock: 4 })],
  });

  it('reports a price change old → new', () => {
    const rows = rowsFrom(['Name', 'Size', 'Price'], [['Sneaker', '8', '949']], SHOES);
    const plan = buildPlan(rows, existing, COUNTED);

    expect(plan.items[0].variants[0].outcome).toBe('update');
    expect(plan.items[0].variants[0].changes).toEqual([
      { field: 'price', from: '899.00', to: '949.00' },
    ]);
    expect(plan.counts.updatedProducts).toBe(1);
  });

  it('an identical row is unchanged and writes nothing', () => {
    const rows = rowsFrom(['Name', 'Size', 'Price'], [['Sneaker', '8', '899']], SHOES);
    const plan = buildPlan(rows, existing, COUNTED);

    expect(plan.items[0].variants[0].outcome).toBe('unchanged');
    expect(plan.counts.unchangedProducts).toBe(1);
    expect(writableItems(plan)).toEqual([]);
  });

  it('reports a stock change for a counted business and none for an availability one', () => {
    const rows = rowsFrom(['Name', 'Size', 'Price', 'Qty'], [['Sneaker', '8', '899', '11']], SHOES);

    const counted = buildPlan(rows, existing, COUNTED);
    expect(counted.items[0].variants[0].changes).toEqual([
      { field: 'stock', from: '4', to: '11' },
    ]);

    // An availability business is shown no count and stores none — save_product
    // reads the mode off the tenant row and ignores any figure sent.
    const availability = buildPlan(rows, existing, AVAILABILITY);
    expect(availability.items[0].variants[0].changes).toEqual([]);
    expect(availability.items[0].variants[0].outcome).toBe('unchanged');
  });
});

// ===========================================================================
// Absence — the one that matters most
// ===========================================================================

describe('absence', () => {
  it('an existing product not in the file is untouched and appears in no outcome list', () => {
    const existing = catalogue({
      items: [item('keep-1', 'Boerewors'), item('keep-2', 'Lamb chops')],
      variants: [
        variant('var-1', 'keep-1', { unit: 'per kg' }, { price: 89.9 }),
        variant('var-2', 'keep-2', { unit: 'per kg' }, { price: 169 }),
      ],
    });

    // The seller uploads only their new line.
    const rows = rowsFrom(['Name', 'Sold by', 'Price'], [['Rump steak', 'per kg', '249']], BUTCHERY);
    const plan = buildPlan(rows, existing, COUNTED);

    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].name).toBe('Rump steak');

    const named = JSON.stringify(plan);
    expect(named).not.toContain('keep-1');
    expect(named).not.toContain('keep-2');
    expect(named).not.toContain('Boerewors');
    expect(named).not.toContain('Lamb chops');

    expect(plan.counts).toEqual({
      newProducts: 1,
      updatedProducts: 0,
      unchangedProducts: 0,
      ambiguousProducts: 0,
      errorRows: 0,
    });
  });

  it('a re-import of a grown list produces no duplicates', () => {
    // 2 products imported two months ago, 3 in the file now.
    const existing = catalogue({
      items: [item('item-1', 'Boerewors'), item('item-2', 'Lamb chops')],
      variants: [
        variant('var-1', 'item-1', { unit: 'per kg' }, { price: 89.9 }),
        variant('var-2', 'item-2', { unit: 'per kg' }, { price: 169 }),
      ],
    });

    const rows = rowsFrom(
      ['Name', 'Sold by', 'Price'],
      [
        ['Boerewors', 'per kg', '89.90'],
        ['Lamb chops', 'per kg', '179.00'],
        ['Rump steak', 'per kg', '249.00'],
      ],
      BUTCHERY,
    );

    const plan = buildPlan(rows, existing, COUNTED);

    expect(plan.items).toHaveLength(3);
    expect(plan.counts).toEqual({
      newProducts: 1,
      updatedProducts: 1,
      unchangedProducts: 1,
      ambiguousProducts: 0,
      errorRows: 0,
    });

    // Two products end up written: the price change and the new one. Never a
    // second "Boerewors".
    const writable = writableItems(plan);
    expect(writable.map((entry) => entry.name).sort()).toEqual(['Lamb chops', 'Rump steak']);
    expect(writable.filter((entry) => entry.itemId === null)).toHaveLength(1);
  });
});

// ===========================================================================
// The counters
// ===========================================================================

describe('counters', () => {
  it('counts products, not rows — four variants of one product is one product', () => {
    const rows = rowsFrom(
      ['Name', 'Size', 'Colour', 'Price'],
      [
        ['Canvas sneaker', '7', 'white', '899'],
        ['Canvas sneaker', '8', 'white', '899'],
        ['Canvas sneaker', '9', 'white', '899'],
        ['Canvas sneaker', '8', 'black', '949'],
      ],
      SHOES,
    );

    const plan = buildPlan(rows, catalogue(), COUNTED);

    expect(plan.items[0].variants).toHaveLength(4);
    expect(plan.counts.newProducts).toBe(1);
  });

  it('new products is exactly the number the catalogue grows by', () => {
    const existing = catalogue({
      items: [item('item-1', 'Boerewors'), item('item-2', 'Lamb chops')],
      variants: [
        variant('var-1', 'item-1', { unit: 'per kg' }, { price: 89.9 }),
        variant('var-2', 'item-2', { unit: 'per kg' }, { price: 169 }),
      ],
    });

    const rows = rowsFrom(
      ['Name', 'Sold by', 'Price'],
      [
        ['Boerewors', 'per kg', '89.90'], // unchanged
        ['Lamb chops', 'per kg', '179.00'], // updated
        ['Rump steak', 'per kg', '249.00'], // new
        ['Pork belly', 'per kg', '149.00'], // new
        ['Pork belly', 'per pack', '89.00'], // second variant of the same new product
        ['', '12.00'], // error
      ],
      BUTCHERY,
    );

    const plan = buildPlan(rows, existing, COUNTED);

    // Six rows in, but the catalogue grows by two products, and that is the
    // number the counter shows.
    expect(plan.counts).toEqual({
      newProducts: 2,
      updatedProducts: 1,
      unchangedProducts: 1,
      ambiguousProducts: 0,
      errorRows: 1,
    });

    const created = writableItems(plan).filter((entry) => entry.itemId === null);
    expect(plan.counts.newProducts).toBe(created.length);

    // And the commit button counts what the commit loop actually writes.
    expect(writableItems(plan)).toHaveLength(
      plan.counts.newProducts + plan.counts.updatedProducts,
    );
  });

  it('counts errors in rows, because an error row never became a product', () => {
    const rows = rowsFrom(
      ['Name', 'Sold by', 'Price'],
      [
        ['Boerewors', 'per kg', '89.90'],
        ['', 'per kg', '45.00'],
        ['Rump', 'per kg', ''],
      ],
      BUTCHERY,
    );

    const plan = buildPlan(rows, catalogue(), COUNTED);

    expect(plan.counts.errorRows).toBe(2);
    expect(plan.counts.newProducts).toBe(1);
  });
});

// ===========================================================================
// Categories
// ===========================================================================

describe('categories', () => {
  it('collects distinct names once, not per row', () => {
    const rows = rowsFrom(
      ['Name', 'Price', 'Category'],
      [
        ['A', '10', 'Beef'],
        ['B', '10', 'beef '],
        ['C', '10', 'BEEF'],
        ['D', '10', 'Lamb'],
        ['E', '10', ''],
      ],
      BUTCHERY,
    );

    const decisions = collectCategories(rows, []);
    expect(decisions).toHaveLength(2);
    expect(decisions.map((decision) => decision.name)).toEqual(['Beef', 'Lamb']);
    expect(decisions[0].rowCount).toBe(3);
  });

  it('defaults to attaching when a category already exists, and to creating otherwise', () => {
    const rows = rowsFrom(
      ['Name', 'Price', 'Category'],
      [
        ['A', '10', 'beef'],
        ['B', '10', 'Poultry'],
      ],
      BUTCHERY,
    );

    const decisions = collectCategories(rows, [{ id: 'cat-1', name: 'Beef', sortOrder: 3 }]);

    expect(decisions[0]).toMatchObject({ action: 'attach', categoryId: 'cat-1' });
    expect(decisions[1]).toMatchObject({ action: 'create', categoryId: null });
  });

  it('sorts created categories after the existing ones, in file order', () => {
    const rows = rowsFrom(
      ['Name', 'Price', 'Category'],
      [
        ['A', '10', 'Poultry'],
        ['B', '10', 'Game'],
        ['C', '10', 'Beef'],
      ],
      BUTCHERY,
    );

    const existing = [{ id: 'cat-1', name: 'Beef', sortOrder: 4 }];
    const decisions = collectCategories(rows, existing);
    const orders = nextSortOrders(decisions, existing);

    expect(orders).toEqual({ poultry: 5, game: 6 });
  });
});

// ===========================================================================
// The commit payload
// ===========================================================================

describe('toSavePayload', () => {
  const existingItem = item('item-1', 'Sneaker', {
    description: 'Handmade, Cape Town',
    imageUrl: 'https://example.test/sneaker.svg',
    categoryId: 'cat-old',
    active: false,
  });

  const existingVariants = [
    variant('var-1', 'item-1', { size: '8' }, { price: 899, stock: 4, available: false }),
  ];

  const existing = catalogue({ items: [existingItem], variants: existingVariants });

  it('preserves everything the file does not mention', () => {
    const rows = rowsFrom(['Name', 'Size', 'Price'], [['Sneaker', '8', '949']], SHOES);
    const plan = buildPlan(rows, existing, COUNTED);
    const payload = toSavePayload(plan.items[0], existingItem, existingVariants, null, COUNTED);

    // save_product overwrites what it is handed, so an import that omitted
    // these would wipe a description the seller typed by hand.
    expect(payload.item.description).toBe('Handmade, Cape Town');
    expect(payload.item.image_url).toBe('https://example.test/sneaker.svg');
    expect(payload.item.category_id).toBe('cat-old');
    expect(payload.item.active).toBe(false);

    // `available` is the everyday in-stock toggle. An import is not a statement
    // about today's stock, so it must not flip it back on.
    expect(payload.variants[0].available).toBe(false);
    expect(payload.variants[0].id).toBe('var-1');
    expect(payload.variants[0].price).toBe(949);
  });

  it('sends no stock figure for an availability business', () => {
    const rows = rowsFrom(['Name', 'Size', 'Price', 'Qty'], [['Sneaker', '8', '949', '12']], SHOES);
    const plan = buildPlan(rows, existing, AVAILABILITY);
    const payload = toSavePayload(plan.items[0], existingItem, existingVariants, null, AVAILABILITY);

    expect(payload.variants[0].stock).toBeNull();
  });

  it('leaves unchanged variants out of the payload entirely', () => {
    const rows = rowsFrom(
      ['Name', 'Size', 'Price'],
      [
        ['Sneaker', '8', '899'],
        ['Sneaker', '9', '899'],
      ],
      SHOES,
    );
    const plan = buildPlan(rows, existing, COUNTED);
    const payload = toSavePayload(plan.items[0], existingItem, existingVariants, null, COUNTED);

    expect(payload.variants).toHaveLength(1);
    expect(payload.variants[0].attributes).toEqual({ size: '9' });
    expect(payload.variants[0].id).toBeNull();
  });

  it('a new category decision reaches the item, and a file with none keeps the old one', () => {
    const rows = rowsFrom(['Name', 'Size', 'Price'], [['Sneaker', '8', '949']], SHOES);
    const plan = buildPlan(rows, existing, COUNTED);

    expect(toSavePayload(plan.items[0], existingItem, existingVariants, 'cat-new', COUNTED).item.category_id)
      .toBe('cat-new');
    expect(toSavePayload(plan.items[0], existingItem, existingVariants, null, COUNTED).item.category_id)
      .toBe('cat-old');
  });

  it('carries no removals — there is no field for one', () => {
    const rows = rowsFrom(['Name', 'Size', 'Price'], [['Sneaker', '8', '949']], SHOES);
    const plan = buildPlan(rows, existing, COUNTED);
    const payload = toSavePayload(plan.items[0], existingItem, existingVariants, null, COUNTED);

    expect(Object.keys(payload).sort()).toEqual(['item', 'variants']);
  });
});

// ===========================================================================
// The parser — the one piece with a library behind it
// ===========================================================================

describe('parseFile', () => {
  const CSV = [
    'Product,Sold by,Price,Category,Supplier',
    'Boerewors,per kg,"R 89,90",Beef,Karoo Meats',
    'Boerewors,per pack,R 45.00,Beef,Karoo Meats',
    'Lamb chops,per kg,R 189.00,Lamb,Karoo Meats',
    '',
  ].join('\n');

  it('turns a .csv into headers plus rows, and nothing more', async () => {
    const table = await parseFile(new File([CSV], 'price-list.csv', { type: 'text/csv' }));

    expect(table.headers).toEqual(['Product', 'Sold by', 'Price', 'Category', 'Supplier']);
    expect(table.rows).toHaveLength(3);
    expect(table.rows[0]).toEqual(['Boerewors', 'per kg', 'R 89,90', 'Beef', 'Karoo Meats']);
  });

  it('reaches the review screen from a real file', async () => {
    const table = await parseFile(new File([CSV], 'price-list.csv', { type: 'text/csv' }));
    const mapping = guessMapping(table.headers, BUTCHERY);
    const rows = readRows(table, mapping);
    const plan = buildPlan(rows, catalogue(), AVAILABILITY);

    expect(mapping).toEqual(['name', 'attribute:unit', 'price', 'category', 'ignore']);
    expect(ignoredHeaders(table, mapping)).toEqual(['Supplier']);

    // Two rows share a name, so two products with three variants between them.
    expect(plan.items).toHaveLength(2);
    expect(plan.items[0].variants).toHaveLength(2);
    expect(plan.items[0].variants[0].price).toBe(89.9);
    expect(collectCategories(rows, []).map((decision) => decision.name)).toEqual(['Beef', 'Lamb']);
  });

  it('reads an .xlsx the same way', async () => {
    const XLSX = await import('xlsx');
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.aoa_to_sheet([
        ['Name', 'Size', 'Colour', 'Price'],
        ['Canvas sneaker', '8', 'white', 899],
        ['Canvas sneaker', '9', 'white', 899],
      ]),
      'Sheet1',
    );
    const buffer = XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;

    const table = await parseFile(new File([buffer], 'stock.xlsx'));
    expect(table.headers).toEqual(['Name', 'Size', 'Colour', 'Price']);

    const rows = readRows(table, guessMapping(table.headers, SHOES));
    const plan = buildPlan(rows, catalogue(), COUNTED);

    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].variants.map((entry) => entry.attributes)).toEqual([
      { size: '8', colour: 'white' },
      { size: '9', colour: 'white' },
    ]);
  });
});

describe('describeAttributes', () => {
  it('names the combination, and says so when there is not one', () => {
    expect(describeAttributes({ size: '9', colour: 'red' })).toBe('colour red · size 9');
    expect(describeAttributes({})).toBe('single variant');
  });
});
