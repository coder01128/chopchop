import type { TenantAttribute } from '@chopchop/shared';

/**
 * The generated variant editor, as pure functions.
 *
 * Every rule the white-label claim depends on lives here rather than in a
 * component, because this is the part that must not branch on what a client
 * sells. A butchery and a shoe shop go through the same code with different
 * data; there is no `if (meat)` anywhere in the file, and there must never be.
 *
 * The rule that shapes all of it, from SCHEMA.md:
 *
 *   attribute_schema is a palette, not a mandate.
 *
 * The tenant row lists the attributes *available*. Which attributes a given
 * product actually uses is derived from the keys on that product's own
 * variants. A shoe shop that starts stocking wide fittings does not grow an
 * empty `width` selector on every product it has ever sold.
 */

export interface VariantRecord {
  id: string;
  attributes: Record<string, string>;
  price: number;
  stock: number;
  available: boolean;
  sku: string | null;
}

/** One editable variant. Numbers are held as strings — this is form state. */
export interface Cell {
  key: string;
  attributes: Record<string, string>;
  /** null when this combination has no row in the database yet. */
  variantId: string | null;
  price: string;
  stock: string;
  available: boolean;
  sku: string;
  /** New since the product was opened: renders empty and flagged, blocks save. */
  isNew: boolean;
}

export interface ProductShape {
  /** Attribute names this product uses, in tenant palette order. */
  names: string[];
  /** Ticked values per attribute, in tenant palette order. */
  values: Record<string, string[]>;
}

export type CellStore = Record<string, Cell>;

/**
 * A stable key for a combination. Attribute names are sorted so the key does
 * not depend on object insertion order — `{size, colour}` and `{colour, size}`
 * are the same variant, and treating them as two is how duplicates get written.
 */
export function comboKey(attributes: Record<string, string>): string {
  const names = Object.keys(attributes).sort();
  // Separated by control characters, which cannot occur in an attribute value,
  // so `a=xy, b=z` and `a=x, b=yz` cannot collide into the same key. Written as
  // escapes: literal control bytes in source break grep, diffs and editors.
  return names.map((name) => `${name}\u0000${attributes[name]}`).join('\u0001');
}

/** Orders a list by a reference order, appending anything not in it. */
function orderedBy<T>(items: T[], reference: T[]): T[] {
  const known = reference.filter((entry) => items.includes(entry));
  const rest = items.filter((entry) => !reference.includes(entry));
  return [...known, ...rest];
}

/**
 * Derives which attributes and values a product uses from its own variants.
 *
 * Values no longer in the tenant palette are kept and sorted to the end rather
 * than dropped: they exist, they are priced, and they may appear in past
 * orders. Dropping them here would silently delete a live variant the moment
 * a seller edited an old product after the palette changed.
 */
export function deriveShape(
  variants: VariantRecord[],
  palette: TenantAttribute[],
): ProductShape {
  const paletteNames = palette.map((attribute) => attribute.name);

  const seenNames: string[] = [];
  const seenValues: Record<string, string[]> = {};

  for (const variant of variants) {
    for (const [name, value] of Object.entries(variant.attributes)) {
      if (typeof value !== 'string') continue;
      if (!seenNames.includes(name)) {
        seenNames.push(name);
        seenValues[name] = [];
      }
      if (!seenValues[name].includes(value)) seenValues[name].push(value);
    }
  }

  const names = orderedBy(seenNames, paletteNames);
  const values: Record<string, string[]> = {};
  for (const name of names) {
    const paletteOptions = palette.find((attribute) => attribute.name === name)?.options ?? [];
    values[name] = orderedBy(seenValues[name], paletteOptions);
  }

  return { names, values };
}

/**
 * The cross product, in a stable order: last attribute varies fastest, which
 * is what makes the grid read row-by-row the way the wireframe draws it.
 *
 * Zero attributes yields exactly one combination, `{}` — the vacuum cleaner
 * case. The seller sees a price and a stock field and no evidence that a
 * variant system exists.
 */
export function crossProduct(shape: ProductShape): Record<string, string>[] {
  return shape.names.reduce<Record<string, string>[]>(
    (rows, name) =>
      rows.flatMap((row) => (shape.values[name] ?? []).map((value) => ({ ...row, [name]: value }))),
    [{}],
  );
}

function emptyCell(attributes: Record<string, string>): Cell {
  return {
    key: comboKey(attributes),
    attributes,
    variantId: null,
    price: '',
    stock: '',
    available: true,
    sku: '',
    isNew: true,
  };
}

export function cellFromVariant(variant: VariantRecord): Cell {
  return {
    key: comboKey(variant.attributes),
    attributes: variant.attributes,
    variantId: variant.id,
    price: String(variant.price),
    stock: String(variant.stock),
    available: variant.available,
    sku: variant.sku ?? '',
    isNew: false,
  };
}

export function storeFromVariants(variants: VariantRecord[]): CellStore {
  const store: CellStore = {};
  for (const variant of variants) {
    store[comboKey(variant.attributes)] = cellFromVariant(variant);
  }
  return store;
}

/**
 * The cells currently on screen, in cross-product order.
 *
 * The store is deliberately not pruned when a value is unticked: untick red,
 * retick it, and the prices come back. Only `save` decides what is actually
 * removed, and only after checking order history.
 */
export function activeCells(shape: ProductShape, store: CellStore): Cell[] {
  return crossProduct(shape).map((attributes) => store[comboKey(attributes)] ?? emptyCell(attributes));
}

/** A human label for a combination — "size 9 · red". Used in error messages. */
export function describeCell(cell: Cell, shape: ProductShape): string {
  if (shape.names.length === 0) return 'this product';
  return shape.names
    .filter((name) => cell.attributes[name] !== undefined)
    .map((name) => `${name} ${cell.attributes[name]}`)
    .join(' · ');
}

export interface CellError {
  key: string;
  /** Named so the message can point at the cell — never "please check your input". */
  message: string;
}

/**
 * Everything Postgres will not check.
 *
 * The jsonb column accepts anything, so this is the only thing standing between
 * a clean catalogue and `navy` sitting alongside `Navy` as separate variants
 * forever.
 */
export function validateCells(
  cells: Cell[],
  shape: ProductShape,
  palette: TenantAttribute[],
  original: CellStore,
): CellError[] {
  const errors: CellError[] = [];
  const seen = new Set<string>();

  if (cells.length === 0) {
    return [{ key: '', message: 'This product has no variants. Tick at least one value.' }];
  }

  for (const cell of cells) {
    const where = describeCell(cell, shape);

    // Duplicate combinations. comboKey sorts its names, so this catches the
    // same combination arriving with its keys in a different order too.
    if (seen.has(cell.key)) {
      errors.push({ key: cell.key, message: `${where} appears twice.` });
      continue;
    }
    seen.add(cell.key);

    // Values are checked against the tenant's declared list — but only for
    // combinations that did not already exist. A product saved before the
    // palette changed keeps its values; rejecting them would make old products
    // permanently unsaveable, which is a worse failure than a stale value.
    if (!original[cell.key]) {
      for (const [name, value] of Object.entries(cell.attributes)) {
        const declared = palette.find((attribute) => attribute.name === name);
        if (!declared) {
          errors.push({ key: cell.key, message: `${where}: "${name}" is not an attribute for this business.` });
        } else if (!declared.options.includes(value)) {
          errors.push({ key: cell.key, message: `${where}: "${value}" is not a listed ${name}.` });
        }
      }
    }

    const price = cell.price.trim();
    if (price === '') {
      errors.push({ key: cell.key, message: `${where} needs a price.` });
    } else {
      const parsed = Number(price);
      if (!Number.isFinite(parsed)) {
        errors.push({ key: cell.key, message: `${where}: "${cell.price}" is not a price.` });
      } else if (parsed < 0) {
        errors.push({ key: cell.key, message: `${where}: a price cannot be negative.` });
      }
    }

    if (cell.stock.trim() !== '') {
      const parsed = Number(cell.stock);
      if (!Number.isFinite(parsed)) {
        errors.push({ key: cell.key, message: `${where}: "${cell.stock}" is not a stock figure.` });
      } else if (parsed < 0) {
        errors.push({ key: cell.key, message: `${where}: stock cannot be negative.` });
      }
    }
  }

  return errors;
}

/**
 * Which existing variants have fallen out of the current selection.
 *
 * These are candidates for removal, not removals: order_items.variant_id is
 * ON DELETE RESTRICT, so what actually happens to each one depends on whether
 * it has ever been ordered.
 */
export function droppedVariantIds(original: CellStore, shape: ProductShape): string[] {
  const activeKeys = new Set(crossProduct(shape).map(comboKey));
  return Object.values(original)
    .filter((cell) => cell.variantId && !activeKeys.has(cell.key))
    .map((cell) => cell.variantId!);
}

/**
 * Bulk fill. Defaults to filling only what is empty — a seller who has already
 * priced six of nine cells and then sets a blanket price is topping up, not
 * discarding their work. `overwrite` makes the destructive version explicit.
 */
export function applyBulkFill(
  cells: Cell[],
  field: 'price' | 'stock',
  value: string,
  overwrite: boolean,
): Cell[] {
  return cells.map((cell) =>
    overwrite || cell[field].trim() === '' ? { ...cell, [field]: value } : cell,
  );
}
