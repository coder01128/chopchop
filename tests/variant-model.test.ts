// The generated variant editor's rules, tested without a browser.
//
//   npm run test
//
// These are pure functions on purpose. The white-label claim is that one
// component produces a butchery's two priced rows and a shoe shop's nine-cell
// grid with no branch for either — that claim is checkable here, cheaply, and
// the browser pass then only has to confirm it is wired up.

import { describe, expect, it } from 'vitest';
import type { TenantAttribute } from '@chopchop/shared';
import {
  applyBulkFill,
  comboKey,
  crossProduct,
  deriveShape,
  droppedVariantIds,
  storeFromVariants,
  validateCells,
  activeCells,
  type Cell,
  type VariantRecord,
} from '../apps/dashboard/src/catalogue/variant-model';

const BUTCHERY: TenantAttribute[] = [
  { name: 'unit', label: 'Sold by', options: ['per kg', 'per pack'] },
];

const SHOES: TenantAttribute[] = [
  { name: 'size', label: 'Size', options: ['7', '8', '9'] },
  { name: 'colour', label: 'Colour', options: ['white', 'black', 'red'] },
];

function variant(id: string, attributes: Record<string, string>, price = 10): VariantRecord {
  return { id, attributes, price, stock: 0, available: true, sku: null };
}

describe('comboKey', () => {
  it('does not depend on key insertion order', () => {
    expect(comboKey({ size: '8', colour: 'black' })).toBe(comboKey({ colour: 'black', size: '8' }));
  });

  it('separates combinations that differ', () => {
    expect(comboKey({ size: '8' })).not.toBe(comboKey({ size: '9' }));
  });

  it('handles the no-attribute product', () => {
    expect(comboKey({})).toBe('');
  });
});

describe('crossProduct', () => {
  it('yields one empty combination for zero attributes — the vacuum cleaner case', () => {
    expect(crossProduct({ names: [], values: {} })).toEqual([{}]);
  });

  it('yields one row per option for one attribute', () => {
    const rows = crossProduct({ names: ['unit'], values: { unit: ['per kg', 'per pack'] } });
    expect(rows).toEqual([{ unit: 'per kg' }, { unit: 'per pack' }]);
  });

  it('yields the full grid for two attributes', () => {
    const rows = crossProduct({
      names: ['size', 'colour'],
      values: { size: ['7', '8', '9'], colour: ['white', 'black', 'red'] },
    });
    expect(rows).toHaveLength(9);
    expect(rows[0]).toEqual({ size: '7', colour: 'white' });
    // last attribute varies fastest, so the grid reads row by row
    expect(rows[1]).toEqual({ size: '7', colour: 'black' });
  });

  it('yields nothing when an attribute has no ticked values', () => {
    expect(crossProduct({ names: ['size'], values: { size: [] } })).toEqual([]);
  });
});

describe('deriveShape — attribute_schema is a palette, not a mandate', () => {
  it('takes the shape from the product, not the tenant row', () => {
    // The business has gained `colour`, but this product predates it.
    const palette: TenantAttribute[] = [
      { name: 'size', label: 'Size', options: ['7', '8'] },
      { name: 'colour', label: 'Colour', options: ['white'] },
    ];
    const shape = deriveShape([variant('a', { size: '7' }), variant('b', { size: '8' })], palette);

    expect(shape.names).toEqual(['size']);
    expect(shape.values).toEqual({ size: ['7', '8'] });
    // The critical assertion: no empty `colour` selector sprouts on an old product.
    expect(shape.names).not.toContain('colour');
  });

  it('orders attributes and values by the tenant palette', () => {
    const shape = deriveShape(
      [variant('a', { colour: 'red', size: '9' }), variant('b', { colour: 'white', size: '7' })],
      SHOES,
    );
    expect(shape.names).toEqual(['size', 'colour']);
    expect(shape.values.size).toEqual(['7', '9']);
    expect(shape.values.colour).toEqual(['white', 'red']);
  });

  it('keeps values the palette has since dropped, sorted last', () => {
    const shape = deriveShape(
      [variant('a', { colour: 'white' }), variant('b', { colour: 'teal' })],
      SHOES,
    );
    // `teal` is gone from the palette but the variant exists and is priced —
    // dropping it here would silently delete a live variant on next save.
    expect(shape.values.colour).toEqual(['white', 'teal']);
  });

  it('returns an empty shape for a product with no attributes', () => {
    expect(deriveShape([variant('a', {})], BUTCHERY)).toEqual({ names: [], values: {} });
  });
});

describe('activeCells', () => {
  it('produces two priced rows for the butchery case', () => {
    const store = storeFromVariants([
      variant('a', { unit: 'per kg' }, 189.9),
      variant('b', { unit: 'per pack' }, 94.95),
    ]);
    const cells = activeCells({ names: ['unit'], values: { unit: ['per kg', 'per pack'] } }, store);

    expect(cells).toHaveLength(2);
    expect(cells.map((cell) => cell.price)).toEqual(['189.9', '94.95']);
    expect(cells.every((cell) => !cell.isNew)).toBe(true);
  });

  it('produces a nine-cell grid for the shoe case', () => {
    const cells = activeCells(
      { names: ['size', 'colour'], values: { size: ['7', '8', '9'], colour: ['white', 'black', 'red'] } },
      {},
    );
    expect(cells).toHaveLength(9);
    expect(cells.every((cell) => cell.isNew && cell.price === '')).toBe(true);
  });

  it('leaves existing cells untouched when a value is added', () => {
    const store = storeFromVariants([
      variant('a', { size: '7', colour: 'white' }, 899),
      variant('b', { size: '8', colour: 'white' }, 899),
    ]);

    // The seller starts stocking size 9.
    const cells = activeCells(
      { names: ['size', 'colour'], values: { size: ['7', '8', '9'], colour: ['white'] } },
      store,
    );

    expect(cells).toHaveLength(3);
    const existing = cells.filter((cell) => !cell.isNew);
    expect(existing.map((cell) => cell.price)).toEqual(['899', '899']);

    const added = cells.filter((cell) => cell.isNew);
    expect(added).toHaveLength(1);
    expect(added[0].attributes).toEqual({ size: '9', colour: 'white' });
    // Never inherited — a silently guessed price is a wrong price on the storefront.
    expect(added[0].price).toBe('');
    expect(added[0].variantId).toBeNull();
  });

  it('restores prices when a value is unticked and reticked', () => {
    const shape = { names: ['unit'], values: { unit: ['per kg', 'per pack'] } };
    const store = storeFromVariants([
      variant('a', { unit: 'per kg' }, 189.9),
      variant('b', { unit: 'per pack' }, 94.95),
    ]);

    const narrowed = activeCells({ names: ['unit'], values: { unit: ['per kg'] } }, store);
    expect(narrowed).toHaveLength(1);

    const restored = activeCells(shape, store);
    expect(restored.map((cell) => cell.price)).toEqual(['189.9', '94.95']);
  });
});

describe('validateCells', () => {
  const shape = { names: ['size', 'colour'], values: { size: ['9'], colour: ['red'] } };

  function cell(overrides: Partial<Cell> = {}): Cell {
    return {
      key: comboKey({ size: '9', colour: 'red' }),
      attributes: { size: '9', colour: 'red' },
      variantId: null,
      price: '10',
      stock: '',
      available: true,
      sku: '',
      isNew: true,
      ...overrides,
    };
  }

  it('names the offending cell rather than saying "check your input"', () => {
    const errors = validateCells([cell({ price: '' })], shape, SHOES, {});
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('size 9 · colour red needs a price.');
  });

  it('rejects a value that is not in the tenant palette', () => {
    const rogue = cell({
      key: comboKey({ size: '9', colour: 'Red' }),
      attributes: { size: '9', colour: 'Red' },
    });
    const errors = validateCells([rogue], shape, SHOES, {});
    // This is the only thing stopping `navy` and `Navy` becoming separate
    // variants forever — Postgres will not police the jsonb column.
    expect(errors.some((error) => error.message.includes('"Red" is not a listed colour'))).toBe(true);
  });

  it('lets an existing variant keep a value the palette has since dropped', () => {
    const legacy = cell({
      key: comboKey({ size: '9', colour: 'teal' }),
      attributes: { size: '9', colour: 'teal' },
      variantId: 'v1',
      isNew: false,
    });
    const original = { [legacy.key]: legacy };
    // Rejecting it would make every pre-existing product permanently unsaveable.
    expect(validateCells([legacy], shape, SHOES, original)).toEqual([]);
  });

  it('blocks duplicate combinations', () => {
    const errors = validateCells([cell(), cell()], shape, SHOES, {});
    expect(errors.some((error) => error.message.includes('appears twice'))).toBe(true);
  });

  it('rejects negative and non-numeric prices', () => {
    expect(validateCells([cell({ price: '-1' })], shape, SHOES, {})[0].message).toContain(
      'cannot be negative',
    );
    expect(validateCells([cell({ price: 'abc' })], shape, SHOES, {})[0].message).toContain(
      'is not a price',
    );
  });

  it('complains when nothing is ticked', () => {
    expect(validateCells([], shape, SHOES, {})[0].message).toContain('no variants');
  });

  it('passes a fully priced grid', () => {
    const cells = activeCells(
      { names: ['size', 'colour'], values: { size: ['7', '8'], colour: ['white', 'black'] } },
      {},
    ).map((entry) => ({ ...entry, price: '899' }));
    expect(validateCells(cells, { names: ['size', 'colour'], values: { size: ['7', '8'], colour: ['white', 'black'] } }, SHOES, {})).toEqual([]);
  });
});

describe('droppedVariantIds', () => {
  it('lists saved variants that fell out of the selection', () => {
    const original = storeFromVariants([
      variant('keep', { unit: 'per kg' }),
      variant('drop', { unit: 'per pack' }),
    ]);
    const dropped = droppedVariantIds(original, { names: ['unit'], values: { unit: ['per kg'] } });
    expect(dropped).toEqual(['drop']);
  });

  it('lists nothing when the selection is unchanged', () => {
    const original = storeFromVariants([variant('a', { unit: 'per kg' })]);
    expect(droppedVariantIds(original, { names: ['unit'], values: { unit: ['per kg'] } })).toEqual([]);
  });
});

describe('applyBulkFill', () => {
  const cells: Cell[] = [
    { key: 'a', attributes: {}, variantId: null, price: '100', stock: '', available: true, sku: '', isNew: true },
    { key: 'b', attributes: {}, variantId: null, price: '', stock: '', available: true, sku: '', isNew: true },
  ];

  it('fills only empty cells by default', () => {
    const filled = applyBulkFill(cells, 'price', '250', false);
    expect(filled.map((cell) => cell.price)).toEqual(['100', '250']);
  });

  it('overwrites everything when asked explicitly', () => {
    const filled = applyBulkFill(cells, 'price', '250', true);
    expect(filled.map((cell) => cell.price)).toEqual(['250', '250']);
  });
});
