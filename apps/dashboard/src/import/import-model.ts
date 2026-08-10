import type { Json, TenantAttribute } from '@chopchop/shared';
import { comboKey } from '../catalogue/variant-model';

/**
 * Spreadsheet import, as pure functions.
 *
 * Two rules shape this file.
 *
 * 1. **Nothing here knows where the rows came from.** The entry point is a
 *    headers-plus-rows table. `parse-file.ts` produces one from a `.csv` or an
 *    `.xlsx`; ticket 06B's vision extraction will produce the same shape and
 *    enter at exactly the same place. If anything below started asking about
 *    the file, that seam would close.
 *
 * 2. **A row absent from the file means nothing.** Nothing in this file emits a
 *    delete, a retire or a deactivate, and there is no flag that turns one on.
 *    A seller who uploads only their 14 new lines keeps the 20 that are not in
 *    it. Existing rows the import never mentions do not appear in any outcome
 *    list — that is asserted in the tests, because it is the single most
 *    damaging thing this feature could do.
 *
 * `attribute_schema` is read in one place only — `guessMapping`, to offer
 * mapping targets. It is a palette, not a mandate: what a product's selectors
 * render from is still the keys on that product's own variants.
 */

// ===========================================================================
// The seam
// ===========================================================================

/**
 * What a parser hands over. Rows are positional against `headers`; a short row
 * is padded rather than rejected, because a spreadsheet's trailing empty cells
 * are frequently just absent.
 */
export interface SheetTable {
  headers: string[];
  rows: string[][];
}

// ===========================================================================
// Normalisation
// ===========================================================================

/**
 * The one normalisation rule, used for item names, SKUs, category names and
 * header guessing alike. Lowercase, whitespace collapsed, trimmed.
 *
 * Matching and category de-duplication must use the same rule or a seller ends
 * up with "Boerewors" and "boerewors " as two products.
 */
export function normalise(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Non-breaking spaces arrive from copy-pasted spreadsheets and read as text. */
function clean(value: string | undefined): string {
  return (value ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * A price as typed by a person: `R 89,50`, `89.50`, `1 299,00`, `R1,299.00`.
 *
 * Both separators present means the last one is the decimal point. A lone comma
 * followed by one or two digits at the end is a decimal comma — which is how
 * most of this market writes money. A lone comma anywhere else is a thousands
 * separator.
 */
export function parseNumber(raw: string): number | null {
  const text = clean(raw).replace(/[^\d,.\-]/g, '');
  if (text === '') return null;

  let normalised = text;
  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');

  if (lastComma >= 0 && lastDot >= 0) {
    normalised =
      lastComma > lastDot
        ? text.replace(/\./g, '').replace(',', '.')
        : text.replace(/,/g, '');
  } else if (lastComma >= 0) {
    normalised = /,\d{1,2}$/.test(text) ? text.replace(',', '.') : text.replace(/,/g, '');
  }

  const value = Number(normalised);
  return Number.isFinite(value) ? value : null;
}

// ===========================================================================
// Column mapping
// ===========================================================================

export type SimpleField = 'name' | 'price' | 'category' | 'stock' | 'sku';
export type ColumnTarget = 'ignore' | SimpleField | `attribute:${string}`;
export type Mapping = ColumnTarget[];

export function attributeTarget(name: string): ColumnTarget {
  return `attribute:${name}`;
}

export function targetAttributeName(target: ColumnTarget): string | null {
  return target.startsWith('attribute:') ? target.slice('attribute:'.length) : null;
}

/**
 * Header guesses. Generic vocabulary only — a hint naming anything a particular
 * client sells would be the same bug as a component that knows the word `meat`.
 * Afrikaans is here because the market is, not because a client asked.
 */
const FIELD_HINTS: Record<SimpleField, string[]> = {
  name: ['name', 'product', 'item', 'title', 'produk', 'beskrywing'],
  price: ['price', 'amount', 'cost', 'rate', 'prys', 'r'],
  category: ['category', 'cat', 'group', 'section', 'type', 'kategorie'],
  stock: ['stock', 'qty', 'quantity', 'count', 'on hand', 'available', 'voorraad'],
  sku: ['sku', 'code', 'ref', 'barcode', 'item code', 'product code', 'kode'],
};

const FIELD_ORDER: SimpleField[] = ['name', 'price', 'sku', 'category', 'stock'];

function hintScore(header: string, hints: string[]): number {
  const value = normalise(header);
  if (value === '') return 0;
  for (const hint of hints) {
    if (value === hint) return 3;
    if (value.startsWith(`${hint} `) || value.endsWith(` ${hint}`)) return 2;
    if (hint.length > 2 && value.includes(hint)) return 1;
  }
  return 0;
}

/**
 * A first guess at the mapping. Every guess is correctable on the screen — this
 * saves typing, it does not decide anything.
 *
 * Attributes win over generic fields on a tie, because a header matching a
 * tenant's own attribute name is a stronger signal than a keyword list. That
 * matters for a palette containing something like `unit`, which would otherwise
 * be swallowed by the stock hints.
 */
export function guessMapping(headers: string[], palette: TenantAttribute[]): Mapping {
  const mapping: Mapping = headers.map(() => 'ignore');
  const taken = new Set<ColumnTarget>();

  headers.forEach((header, index) => {
    const value = normalise(header);
    if (value === '') return;
    for (const attribute of palette) {
      const target = attributeTarget(attribute.name);
      if (taken.has(target)) continue;
      if (value === normalise(attribute.name) || value === normalise(attribute.label ?? '')) {
        mapping[index] = target;
        taken.add(target);
        return;
      }
    }
  });

  for (const field of FIELD_ORDER) {
    if (taken.has(field)) continue;
    let best = -1;
    let bestScore = 0;
    headers.forEach((header, index) => {
      if (mapping[index] !== 'ignore') return;
      const score = hintScore(header, FIELD_HINTS[field]);
      if (score > bestScore) {
        bestScore = score;
        best = index;
      }
    });
    if (best >= 0) {
      mapping[best] = field;
      taken.add(field);
    }
  }

  return mapping;
}

/** Headers whose target is `ignore` — named on screen, never dropped quietly. */
export function ignoredHeaders(table: SheetTable, mapping: Mapping): string[] {
  return table.headers.filter((header, index) => mapping[index] === 'ignore' && clean(header) !== '');
}

export function mappedColumn(mapping: Mapping, target: ColumnTarget): number {
  return mapping.indexOf(target);
}

export interface MappingProblem {
  message: string;
}

/** The two mappings without which there is nothing to import. */
export function mappingProblems(mapping: Mapping): MappingProblem[] {
  const problems: MappingProblem[] = [];
  if (mappedColumn(mapping, 'name') < 0) {
    problems.push({ message: 'No column is mapped to product name. Nothing can be imported without one.' });
  }
  if (mappedColumn(mapping, 'price') < 0) {
    problems.push({ message: 'No column is mapped to price. Nothing can be imported without one.' });
  }
  return problems;
}

// ===========================================================================
// Rows
// ===========================================================================

export interface ParsedRow {
  /** The row number the seller sees in their spreadsheet, header counted. */
  line: number;
  name: string;
  price: number | null;
  stock: number | null;
  sku: string | null;
  category: string | null;
  attributes: Record<string, string>;
  /** Non-empty means this row is excluded from the commit and shown as an error. */
  errors: string[];
}

function cellAt(row: string[], index: number): string {
  return index < 0 ? '' : clean(row[index]);
}

/**
 * One row is one variant. Rows sharing an item name collapse later; a row with
 * no attribute columns is a product with a single variant, which is how a
 * vacuum cleaner works.
 *
 * A blank attribute cell omits the key rather than storing an empty string. The
 * product's shape is the set of keys on its variants, so an empty string would
 * invent a nameless option on the storefront.
 */
export function readRows(table: SheetTable, mapping: Mapping): ParsedRow[] {
  const nameColumn = mappedColumn(mapping, 'name');
  const priceColumn = mappedColumn(mapping, 'price');
  const categoryColumn = mappedColumn(mapping, 'category');
  const stockColumn = mappedColumn(mapping, 'stock');
  const skuColumn = mappedColumn(mapping, 'sku');

  const attributeColumns = mapping
    .map((target, index) => ({ name: targetAttributeName(target), index }))
    .filter((entry): entry is { name: string; index: number } => entry.name !== null);

  const rows: ParsedRow[] = [];

  table.rows.forEach((raw, offset) => {
    // +2: one for the header row, one because spreadsheets count from 1.
    const line = offset + 2;
    const name = cellAt(raw, nameColumn);
    const priceText = cellAt(raw, priceColumn);
    const stockText = cellAt(raw, stockColumn);
    const skuText = cellAt(raw, skuColumn);
    const categoryText = cellAt(raw, categoryColumn);

    const attributes: Record<string, string> = {};
    for (const column of attributeColumns) {
      const value = cellAt(raw, column.index);
      if (value !== '') attributes[column.name] = value;
    }

    // A row where every mapped cell is blank is a spreadsheet's trailing
    // whitespace, not an error the seller has to look at.
    const blank =
      name === '' &&
      priceText === '' &&
      stockText === '' &&
      skuText === '' &&
      categoryText === '' &&
      Object.keys(attributes).length === 0;
    if (blank) return;

    const errors: string[] = [];
    if (name === '') errors.push('No product name.');

    const price = parseNumber(priceText);
    if (priceText === '') errors.push('No price.');
    else if (price === null) errors.push(`"${priceText}" is not a price.`);
    else if (price < 0) errors.push('Price is negative.');

    let stock: number | null = null;
    if (stockText !== '') {
      stock = parseNumber(stockText);
      if (stock === null) errors.push(`"${stockText}" is not a stock figure.`);
      else if (stock < 0) errors.push('Stock is below zero.');
    }

    rows.push({
      line,
      name,
      price,
      stock,
      sku: skuText === '' ? null : skuText,
      category: categoryText === '' ? null : categoryText,
      attributes,
      errors,
    });
  });

  return rows;
}

// ===========================================================================
// Categories
// ===========================================================================

export interface ExistingCategory {
  id: string;
  name: string;
  sortOrder: number;
}

export type CategoryAction = 'create' | 'attach';

export interface CategoryDecision {
  /** Normalised name — the identity used to look a decision up from a row. */
  key: string;
  /** As written in the file, first spelling wins. */
  name: string;
  action: CategoryAction;
  /** Set when attaching to an existing category. */
  categoryId: string | null;
  /** Rows in the file carrying this category. */
  rowCount: number;
}

/**
 * The distinct category names in the file — eight decisions across two hundred
 * rows, not two hundred.
 *
 * Defaults to attach when an existing category matches by normalised name, and
 * to create otherwise. Nothing is written to `categories` without the seller
 * passing through this screen.
 */
export function collectCategories(
  rows: ParsedRow[],
  existing: ExistingCategory[],
): CategoryDecision[] {
  const byName = new Map<string, ExistingCategory>();
  for (const category of existing) {
    const key = normalise(category.name);
    if (!byName.has(key)) byName.set(key, category);
  }

  const decisions = new Map<string, CategoryDecision>();
  for (const row of rows) {
    if (row.category === null) continue;
    const key = normalise(row.category);
    if (key === '') continue;

    const seen = decisions.get(key);
    if (seen) {
      seen.rowCount += 1;
      continue;
    }

    const match = byName.get(key);
    decisions.set(key, {
      key,
      name: row.category,
      action: match ? 'attach' : 'create',
      categoryId: match?.id ?? null,
      rowCount: 1,
    });
  }

  return [...decisions.values()];
}

/**
 * `sort_order` for categories created by this import: after everything that
 * already exists, in the order the names appear in the file.
 *
 * The column defaults to 0, so eight created categories would otherwise all
 * sort equal and the rail order would come out arbitrary.
 */
export function nextSortOrders(
  decisions: CategoryDecision[],
  existing: ExistingCategory[],
): Record<string, number> {
  let next = existing.reduce((highest, category) => Math.max(highest, category.sortOrder), 0);
  const orders: Record<string, number> = {};
  for (const decision of decisions) {
    if (decision.action !== 'create') continue;
    next += 1;
    orders[decision.key] = next;
  }
  return orders;
}

// ===========================================================================
// What already exists
// ===========================================================================

export interface ExistingVariant {
  id: string;
  itemId: string;
  attributes: Record<string, string>;
  price: number;
  stock: number;
  sku: string | null;
  available: boolean;
  retiredAt: string | null;
}

export interface ExistingItem {
  id: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  categoryId: string | null;
  active: boolean;
}

export interface ExistingCatalogue {
  items: ExistingItem[];
  variants: ExistingVariant[];
  categories: ExistingCategory[];
}

// ===========================================================================
// The plan
// ===========================================================================

export type Outcome = 'new' | 'unchanged' | 'update' | 'ambiguous';

export interface FieldChange {
  field: 'name' | 'price' | 'stock' | 'sku';
  from: string;
  to: string;
}

export interface PlannedVariant {
  line: number;
  attributes: Record<string, string>;
  price: number;
  stock: number | null;
  sku: string | null;
  outcome: Outcome;
  variantId: string | null;
  changes: FieldChange[];
  /** Why this is ambiguous. Null otherwise. */
  reason: string | null;
}

export interface PlannedItem {
  /** Normalised name — stable across a re-import. */
  key: string;
  name: string;
  categoryName: string | null;
  itemId: string | null;
  outcome: Outcome;
  changes: FieldChange[];
  reason: string | null;
  variants: PlannedVariant[];
}

/**
 * Counted in **products**, except errors.
 *
 * The seller's check on the review screen is arithmetic: the number they read
 * has to be the number their catalogue grows by. Counting rows made "7 new"
 * precede a catalogue that grew by 5, which reads as an import that dropped
 * two.
 *
 * Errors stay counted in rows, because an error is a row that could not become
 * anything — there is no product to count. Naming the unit on screen is what
 * stops that reading as two lost products.
 */
export interface PlanCounts {
  newProducts: number;
  updatedProducts: number;
  unchangedProducts: number;
  ambiguousProducts: number;
  errorRows: number;
}

function countProducts(items: PlannedItem[], errorRows: number): PlanCounts {
  const counts: PlanCounts = {
    newProducts: 0,
    updatedProducts: 0,
    unchangedProducts: 0,
    ambiguousProducts: 0,
    errorRows,
  };

  for (const item of items) {
    if (item.outcome === 'new') counts.newProducts += 1;
    else if (item.outcome === 'update') counts.updatedProducts += 1;
    else if (item.outcome === 'unchanged') counts.unchangedProducts += 1;
    else counts.ambiguousProducts += 1;
  }

  return counts;
}

export interface ImportPlan {
  items: PlannedItem[];
  /** Rows excluded from the commit, kept visible with their reason. */
  errorRows: ParsedRow[];
  counts: PlanCounts;
}

export interface PlanOptions {
  /**
   * `stock_mode = 'counted'`. False means the tenant is on `availability`, so
   * `save_product` writes no stock figure for them and a mapped stock column
   * goes nowhere — the mapping screen says so, and no stock difference is
   * reported here either.
   */
  trackStock: boolean;
}

function skuKey(sku: string | null): string | null {
  const value = normalise(sku ?? '');
  return value === '' ? null : value;
}

function moneyText(value: number): string {
  return value.toFixed(2);
}

/**
 * Builds the whole plan: collapse, match, classify, diff.
 *
 * Retired variants are invisible to matching, deliberately. A retired variant
 * is one the seller took off the product; matching it would make an import
 * clear `retired_at` and put it back, which is the import overruling a decision
 * the seller made by hand. Instead the row reads as new — visible on the review
 * screen, where the seller can see it and cancel.
 */
export function buildPlan(
  rows: ParsedRow[],
  existing: ExistingCatalogue,
  options: PlanOptions,
): ImportPlan {
  const errorRows = rows.filter((row) => row.errors.length > 0);
  const usable = rows.filter((row) => row.errors.length === 0);

  const liveVariants = existing.variants.filter((variant) => variant.retiredAt === null);

  const itemsById = new Map(existing.items.map((item) => [item.id, item]));

  const itemIdsByName = new Map<string, string[]>();
  for (const item of existing.items) {
    const key = normalise(item.name);
    itemIdsByName.set(key, [...(itemIdsByName.get(key) ?? []), item.id]);
  }

  const itemIdsBySku = new Map<string, Set<string>>();
  const variantsBySku = new Map<string, ExistingVariant[]>();
  for (const variant of liveVariants) {
    const key = skuKey(variant.sku);
    if (key === null) continue;
    itemIdsBySku.set(key, (itemIdsBySku.get(key) ?? new Set()).add(variant.itemId));
    variantsBySku.set(key, [...(variantsBySku.get(key) ?? []), variant]);
  }

  const variantsByItem = new Map<string, ExistingVariant[]>();
  for (const variant of liveVariants) {
    variantsByItem.set(variant.itemId, [...(variantsByItem.get(variant.itemId) ?? []), variant]);
  }

  // ── collapse ──────────────────────────────────────────────────────────
  // Rows sharing an item name are one product with several variants.
  const groups = new Map<string, ParsedRow[]>();
  for (const row of usable) {
    const key = normalise(row.name);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  const items: PlannedItem[] = [];
  const duplicateRows: ParsedRow[] = [];

  for (const [key, groupRows] of groups) {
    // The same combination twice in one file would write two identical
    // variants. The later row loses and is reported.
    const seen = new Map<string, number>();
    const kept: ParsedRow[] = [];
    for (const row of groupRows) {
      const combo = skuKey(row.sku) ?? comboKey(row.attributes);
      const first = seen.get(combo);
      if (first !== undefined) {
        duplicateRows.push({
          ...row,
          errors: [`Already given on row ${first} of this file.`],
        });
        continue;
      }
      seen.set(combo, row.line);
      kept.push(row);
    }
    if (kept.length === 0) continue;

    // ── match the item ──────────────────────────────────────────────────
    // SKU first, when the rows carry one; item name, normalised, otherwise.
    const skuCandidates = new Set<string>();
    for (const row of kept) {
      const sku = skuKey(row.sku);
      if (sku === null) continue;
      for (const itemId of itemIdsBySku.get(sku) ?? []) skuCandidates.add(itemId);
    }

    let itemId: string | null = null;
    let reason: string | null = null;

    if (skuCandidates.size === 1) {
      itemId = [...skuCandidates][0];
    } else if (skuCandidates.size > 1) {
      const names = [...skuCandidates].map((id) => itemsById.get(id)?.name ?? id);
      reason = `The SKUs on these rows belong to more than one existing product: ${names.join(', ')}.`;
    } else {
      const byName = itemIdsByName.get(key) ?? [];
      if (byName.length === 1) itemId = byName[0];
      else if (byName.length > 1) {
        reason = `${byName.length} existing products are already called "${kept[0].name}".`;
      }
    }

    const existingItem = itemId ? (itemsById.get(itemId) ?? null) : null;
    const itemChanges: FieldChange[] = [];
    if (existingItem && existingItem.name !== kept[0].name) {
      itemChanges.push({ field: 'name', from: existingItem.name, to: kept[0].name });
    }

    const candidates = itemId ? (variantsByItem.get(itemId) ?? []) : [];
    const claimed = new Set<string>();

    const variants: PlannedVariant[] = kept.map((row) => {
      const base = {
        line: row.line,
        attributes: row.attributes,
        price: row.price as number,
        stock: options.trackStock ? row.stock : null,
        sku: row.sku,
      };

      if (reason !== null) {
        return { ...base, outcome: 'ambiguous' as const, variantId: null, changes: [], reason };
      }

      const sku = skuKey(row.sku);
      let matches: ExistingVariant[] = [];

      if (sku !== null) {
        matches = (variantsBySku.get(sku) ?? []).filter((variant) => variant.itemId === itemId);
      }
      if (matches.length === 0 && sku === null) {
        const combo = comboKey(row.attributes);
        matches = candidates.filter((variant) => comboKey(variant.attributes) === combo);
      }

      if (matches.length > 1) {
        return {
          ...base,
          outcome: 'ambiguous' as const,
          variantId: null,
          changes: [],
          reason: `${matches.length} existing variants of "${existingItem?.name ?? row.name}" match this row.`,
        };
      }

      const match = matches[0];
      if (!match || claimed.has(match.id)) {
        return { ...base, outcome: 'new' as const, variantId: null, changes: [], reason: null };
      }
      claimed.add(match.id);

      const changes: FieldChange[] = [];
      if (Number(match.price) !== base.price) {
        changes.push({ field: 'price', from: moneyText(Number(match.price)), to: moneyText(base.price) });
      }
      if (options.trackStock && base.stock !== null && Number(match.stock) !== base.stock) {
        changes.push({ field: 'stock', from: String(Number(match.stock)), to: String(base.stock) });
      }
      if (base.sku !== null && skuKey(match.sku) !== skuKey(base.sku)) {
        changes.push({ field: 'sku', from: match.sku ?? '—', to: base.sku });
      }

      return {
        ...base,
        outcome: changes.length > 0 ? ('update' as const) : ('unchanged' as const),
        variantId: match.id,
        changes,
        reason: null,
      };
    });

    const outcome: Outcome =
      reason !== null
        ? 'ambiguous'
        : itemId === null
          ? 'new'
          : itemChanges.length > 0 || variants.some((v) => v.outcome !== 'unchanged')
            ? 'update'
            : 'unchanged';

    items.push({
      key,
      name: kept[0].name,
      categoryName: kept.find((row) => row.category !== null)?.category ?? null,
      itemId,
      outcome,
      changes: itemChanges,
      reason,
      variants,
    });
  }

  const allErrors = [...errorRows, ...duplicateRows].sort((a, b) => a.line - b.line);

  return { items, errorRows: allErrors, counts: countProducts(items, allErrors.length) };
}

/** Items with something to write. Unchanged and ambiguous items are not touched. */
export function writableItems(plan: ImportPlan): PlannedItem[] {
  return plan.items.filter(
    (item) =>
      item.outcome === 'new' ||
      (item.outcome === 'update' && (item.changes.length > 0 || item.variants.some((v) => v.outcome !== 'unchanged'))),
  );
}

// ===========================================================================
// The commit payload
// ===========================================================================

export interface SavePayload {
  item: {
    id: string | null;
    name: string;
    description: string;
    image_url: string;
    category_id: string | null;
    active: boolean;
  };
  variants: {
    id: string | null;
    attributes: Record<string, string>;
    price: number;
    stock: number | null;
    available: boolean;
    sku: string;
  }[];
}

/**
 * The argument for one `save_product` call. Every write in this feature goes
 * through that RPC — no direct inserts into `items` or `variants`.
 *
 * The unmentioned fields are the point of this function. `save_product`
 * overwrites `description`, `image_url`, `category_id` and `active` with
 * whatever it is handed, so an import that omitted them would erase a
 * description the seller typed by hand. They are read back off the existing row
 * and passed through unchanged. Same for a variant's `available`: that is the
 * everyday in-stock toggle, and an import is not a statement about today's
 * stock.
 *
 * Unchanged variants are left out of the payload entirely — there is nothing to
 * write, and every row sent is a row that could be written wrong.
 */
export function toSavePayload(
  planned: PlannedItem,
  existing: ExistingItem | null,
  existingVariants: ExistingVariant[],
  categoryId: string | null,
  options: PlanOptions,
): SavePayload {
  const byId = new Map(existingVariants.map((variant) => [variant.id, variant]));

  return {
    item: {
      id: planned.itemId,
      name: planned.name,
      description: existing?.description ?? '',
      image_url: existing?.imageUrl ?? '',
      // A file with no category for this product must not clear the one the
      // seller already chose.
      category_id: categoryId ?? existing?.categoryId ?? null,
      active: existing?.active ?? true,
    },
    variants: planned.variants
      .filter((variant) => variant.outcome === 'new' || variant.outcome === 'update')
      .map((variant) => {
        const match = variant.variantId ? byId.get(variant.variantId) : undefined;
        return {
          id: variant.variantId,
          attributes: variant.attributes,
          price: variant.price,
          stock: options.trackStock ? variant.stock : null,
          available: match ? match.available : true,
          sku: variant.sku ?? '',
        };
      }),
  };
}

/** "size 9 · colour red", or a plain word when a product has no attributes. */
export function describeAttributes(attributes: Record<string, string>): string {
  const parts = Object.keys(attributes)
    .sort()
    .map((name) => `${name} ${attributes[name]}`);
  return parts.length === 0 ? 'single variant' : parts.join(' · ');
}

/**
 * The seller's resolution of an ambiguous product: import it as a new one.
 *
 * The other resolution is to leave it, which needs no function — an ambiguous
 * item is not written. Nothing here picks a match on the seller's behalf; two
 * candidates stay two candidates until they say which.
 */
export function resolveAsNew(plan: ImportPlan, key: string): ImportPlan {
  const items = plan.items.map((item) => {
    if (item.key !== key || item.outcome !== 'ambiguous') return item;
    return {
      ...item,
      itemId: null,
      outcome: 'new' as const,
      changes: [],
      reason: null,
      variants: item.variants.map((variant) => ({
        ...variant,
        outcome: 'new' as const,
        variantId: null,
        changes: [],
        reason: null,
      })),
    };
  });

  return { ...plan, items, counts: countProducts(items, plan.errorRows.length) };
}

/** What `import_batches.raw` records: the rows as parsed, before any approval. */
export function batchRows(rows: ParsedRow[]): Json[] {
  return rows.map((row) => ({
    line: row.line,
    name: row.name,
    price: row.price,
    stock: row.stock,
    sku: row.sku,
    category: row.category,
    attributes: row.attributes,
    errors: row.errors,
  }));
}
