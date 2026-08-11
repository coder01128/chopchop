import type { FulfilmentMode, OrderStatus, SaleMode, StockMode } from '@chopchop/shared';

/**
 * The storefront's rules, as pure functions.
 *
 * Same pattern as `variant-model.ts` and `order-model.ts`, and for the same
 * reason: the parts that must not drift — what a cart costs, when a total is
 * only an estimate, what counts as sold out, what the seller actually receives
 * on WhatsApp — are checkable without a browser.
 *
 * Nothing here branches on what a client sells. Every decision is read from
 * `sale_mode`, `stock_mode` or `fulfilment_mode`; there is no `if (meat)` in
 * this file and there must never be.
 */

// ---------------------------------------------------------------------------
// Money and quantities
// ---------------------------------------------------------------------------

/** How the storefront shows money on screen. */
export const money = new Intl.NumberFormat('en-ZA', {
  style: 'currency',
  currency: 'ZAR',
  minimumFractionDigits: 2,
});

/**
 * Money for the WhatsApp message.
 *
 * Deliberately not `Intl`: that emits a non-breaking space between R and the
 * figure, which survives URL encoding as `%C2%A0` and reads as a stray
 * character in some WhatsApp clients. The seller is reading this off a phone.
 */
export function plainMoney(amount: number): string {
  return `R ${amount.toFixed(2)}`;
}

/**
 * Does this business sell in whole things or by weight?
 *
 * `weight` matches `variants.stock` and `order_items.qty`, both numeric with
 * scale 3. `unit` gets whole numbers and no decimal control anywhere on screen.
 */
export function quantityStep(saleMode: SaleMode): number {
  return saleMode === 'weight' ? 0.001 : 1;
}

/** 1.5 on a weight tenant, 2 on a unit tenant. Trailing zeros are noise. */
export function formatQty(qty: number, saleMode: SaleMode): string {
  if (saleMode !== 'weight') return String(Math.round(qty));
  return String(Number(qty.toFixed(3)));
}

/**
 * A quantity typed into the box, as the tenant's mode allows it.
 *
 * Returns null for anything that is not a usable quantity, so the caller can
 * leave the field alone rather than replacing what the buyer is halfway through
 * typing.
 */
export function parseQty(raw: string, saleMode: SaleMode): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;

  if (saleMode === 'weight') return Number(parsed.toFixed(3));
  return Number.isInteger(parsed) ? parsed : Math.floor(parsed) || null;
}

// ---------------------------------------------------------------------------
// Sold out
// ---------------------------------------------------------------------------

export interface StorefrontVariant {
  id: string;
  itemId: string;
  attributes: Record<string, string>;
  price: number;
  stock: number;
  available: boolean;
  /**
   * The photo assigned to this variant, as a Storage object path, or null to
   * use the product's. Resolution is not done here — `resolveImageSource` in
   * shared answers it for both apps, so the seller's dashboard and the buyer's
   * sheet cannot show different pictures.
   */
  imagePath: string | null;
}

/**
 * Whether a buyer may order this.
 *
 * A `counted` business runs out when the count does; an `availability` business
 * has no count worth trusting — they also sell over a counter — so the toggle
 * is the only signal. The count itself is never shown to a buyer: it is the
 * seller's working figure, not a promise.
 */
export function isSoldOut(
  variant: Pick<StorefrontVariant, 'available' | 'stock'>,
  stockMode: StockMode,
): boolean {
  if (!variant.available) return true;
  return stockMode === 'counted' ? variant.stock <= 0 : false;
}

/**
 * The attributes a product actually uses, derived from its own variants.
 *
 * SCHEMA.md: `attribute_schema` is a palette, not a mandate. Rendering
 * selectors from the tenant palette would sprout an empty selector on every old
 * product the day the palette gains an attribute. The order follows the
 * palette; anything not in it sorts after.
 */
export function selectorsFor(
  variants: StorefrontVariant[],
  paletteOrder: string[],
): { name: string; values: string[] }[] {
  const seen = new Map<string, string[]>();

  for (const variant of variants) {
    for (const [name, value] of Object.entries(variant.attributes)) {
      if (typeof value !== 'string') continue;
      const values = seen.get(name) ?? [];
      if (!values.includes(value)) values.push(value);
      seen.set(name, values);
    }
  }

  return [...seen.entries()]
    .sort(([a], [b]) => {
      const ai = paletteOrder.indexOf(a);
      const bi = paletteOrder.indexOf(b);
      return (ai === -1 ? paletteOrder.length : ai) - (bi === -1 ? paletteOrder.length : bi);
    })
    .map(([name, values]) => ({ name, values }));
}

/**
 * The label for one variant — "8 / white", "per kg".
 *
 * Matches what `place_order` composes into `name_snapshot`, in the same
 * attribute order, so the cart and the order the seller receives read alike.
 * The stored snapshot is still the authority; this is what a buyer sees before
 * one exists.
 */
export function variantLabel(
  attributes: Record<string, string>,
  paletteOrder: string[],
): string {
  return Object.entries(attributes)
    .sort(([a], [b]) => {
      const ai = paletteOrder.indexOf(a);
      const bi = paletteOrder.indexOf(b);
      const byPalette = (ai === -1 ? paletteOrder.length : ai) - (bi === -1 ? paletteOrder.length : bi);
      return byPalette !== 0 ? byPalette : a.localeCompare(b);
    })
    .map(([, value]) => value)
    .join(' / ');
}

export function matchVariant(
  variants: StorefrontVariant[],
  chosen: Record<string, string>,
): StorefrontVariant | null {
  const names = Object.keys(chosen);
  return (
    variants.find((variant) =>
      names.every((name) => variant.attributes[name] === chosen[name]) &&
      Object.keys(variant.attributes).length === names.length,
    ) ?? null
  );
}

// ---------------------------------------------------------------------------
// Cart
// ---------------------------------------------------------------------------

export interface CartLine {
  variantId: string;
  /** Item name plus the variant label, exactly as place_order will store it. */
  name: string;
  price: number;
  qty: number;
}

/** Rounded to cents, because that is what the column holds. */
export function lineTotal(line: Pick<CartLine, 'price' | 'qty'>): number {
  return Math.round(line.price * line.qty * 100) / 100;
}

export function cartTotal(lines: Pick<CartLine, 'price' | 'qty'>[]): number {
  return Math.round(lines.reduce((sum, line) => sum + lineTotal(line), 0) * 100) / 100;
}

export function cartCount(lines: Pick<CartLine, 'qty'>[]): number {
  return lines.length;
}

/**
 * Adding the same variant twice tops up the line rather than repeating it — a
 * buyer who adds 1kg and then another 1kg means 2kg, and two identical lines in
 * the seller's queue is a question they have to ask on WhatsApp.
 */
export function addLine(lines: CartLine[], line: CartLine): CartLine[] {
  const existing = lines.find((entry) => entry.variantId === line.variantId);
  if (!existing) return [...lines, line];
  return lines.map((entry) =>
    entry.variantId === line.variantId
      ? { ...entry, qty: Number((entry.qty + line.qty).toFixed(3)) }
      : entry,
  );
}

export function removeLine(lines: CartLine[], variantId: string): CartLine[] {
  return lines.filter((line) => line.variantId !== variantId);
}

export function setLineQty(lines: CartLine[], variantId: string, qty: number): CartLine[] {
  return lines.map((line) => (line.variantId === variantId ? { ...line, qty } : line));
}

/**
 * On a weight tenant every total is an estimate, and says so, because the real
 * figure is whatever the seller weighs. A buyer surprised at collection is a
 * buyer the client loses. On a unit tenant the total is the total, and no
 * estimate language appears anywhere.
 */
export function totalIsEstimate(saleMode: SaleMode): boolean {
  return saleMode === 'weight';
}

// ---------------------------------------------------------------------------
// The WhatsApp handoff
// ---------------------------------------------------------------------------

export interface OrderForMessage {
  reference: string;
  customerName: string;
  deliveryAddress: string | null;
  notes: string | null;
  total: number;
  lines: { name: string; qty: number }[];
}

export interface MessageLabels {
  /** What this tenant calls an order — "Order", "Bestelling". */
  order: string;
  estimate: string;
  total: string;
  collect: string;
  delivery: string;
}

export const DEFAULT_MESSAGE_LABELS: MessageLabels = {
  order: 'Order',
  estimate: 'Estimated total',
  total: 'Total',
  collect: 'Collecting',
  delivery: 'Delivery',
};

/**
 * The message the buyer sends and the seller reads.
 *
 * The reference comes first and alone on its line: the seller matches this
 * against the queue by eye, on a phone, often while serving somebody else.
 * Every line is the `name_snapshot` the RPC actually stored, not cart state —
 * the caller passes what came back from `place_order`.
 */
export function buildOrderMessage(
  order: OrderForMessage,
  saleMode: SaleMode,
  fulfilment: FulfilmentMode,
  labels: MessageLabels = DEFAULT_MESSAGE_LABELS,
): string {
  const parts: string[] = [`${labels.order} ${order.reference}`, ''];

  for (const line of order.lines) {
    parts.push(`• ${line.name} × ${formatQty(line.qty, saleMode)}`);
  }

  parts.push('');
  parts.push(
    totalIsEstimate(saleMode)
      ? `${labels.estimate}: ${plainMoney(order.total)}`
      : `${labels.total}: ${plainMoney(order.total)}`,
  );

  parts.push('');
  parts.push(
    fulfilment === 'local_delivery'
      ? `${labels.delivery}: ${order.deliveryAddress ?? ''}`.trimEnd()
      : labels.collect,
  );
  parts.push(order.customerName);

  if (order.notes) {
    parts.push('');
    parts.push(order.notes);
  }

  return parts.join('\n');
}

/**
 * `wa.me` takes digits only — no `+`, no spaces. `tenants.whatsapp_number` is
 * already stored that way and constrained to it, but anything else arriving
 * here is stripped rather than sent to a URL that silently does nothing.
 *
 * encodeURIComponent is what carries the newlines and the Afrikaans characters
 * through intact.
 */
export function whatsappUrl(whatsappNumber: string | null, text: string): string | null {
  const digits = (whatsappNumber ?? '').replace(/\D/g, '');
  if (!digits) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

// ---------------------------------------------------------------------------
// Buyer-facing status
// ---------------------------------------------------------------------------

export interface StatusCopy {
  title: string;
  body: string;
  /** True while the order is still moving, so the page can show it as live. */
  live: boolean;
}

/**
 * The status flow in a buyer's language, never the enum.
 *
 * `cancelled` is the delicate one. It means the seller dismissed an order whose
 * WhatsApp message never arrived — usually because the buyer tapped through and
 * did not press send. It has to read as "we didn't receive this" and point back
 * to WhatsApp: not as an accusation, and not as a system error.
 */
export function describeStatus(status: OrderStatus, fulfilment: FulfilmentMode): StatusCopy {
  switch (status) {
    case 'sent':
      // Not "Sent": the order exists here, but the WhatsApp message may never
      // have been sent, and that is exactly the case this status covers.
      return {
        title: 'Waiting for the shop',
        body:
          'Your order is with the shop. If WhatsApp did not open, or you never pressed ' +
          'send, send the message now — that is how they see it.',
        live: true,
      };
    case 'received':
      return {
        title: 'Seen by the shop',
        body: 'They have your order and will confirm what they can do shortly.',
        live: true,
      };
    case 'confirmed':
      return {
        title: 'Confirmed by the shop',
        body:
          fulfilment === 'local_delivery'
            ? 'The shop is putting your order together for delivery.'
            : 'The shop is putting your order together.',
        live: true,
      };
    case 'ready':
      return {
        title: fulfilment === 'local_delivery' ? 'On the way' : 'Ready to collect',
        body:
          fulfilment === 'local_delivery'
            ? 'Your order has left the shop.'
            : 'Your order is packed and waiting for you.',
        live: true,
      };
    case 'completed':
      return { title: 'Done', body: 'Thank you — this order is complete.', live: false };
    case 'cancelled':
      return {
        title: 'We did not receive this',
        body:
          'The shop never got a WhatsApp message for this order, so they have set it ' +
          'aside. Nothing was charged. If you still want it, send the message on ' +
          'WhatsApp and they will pick it up.',
        live: false,
      };
    default:
      return { title: status, body: '', live: false };
  }
}

/**
 * Once a weight order is confirmed the buyer should see both figures — what
 * they asked for and what was weighed — rather than a total that silently
 * changed. Only meaningful when the seller actually adjusted the quantity.
 */
export function showsWeighedQuantity(
  line: { qty: number; qtyConfirmed: number | null },
  saleMode: SaleMode,
): boolean {
  return saleMode === 'weight' && line.qtyConfirmed !== null && line.qtyConfirmed !== line.qty;
}

/**
 * Does this failure mean "not your order" rather than "something broke"?
 *
 * A buyer reaches their status page as an anonymous auth user, and that session
 * lives on one device. Open the same link on a laptop, after clearing storage,
 * or from a forwarded WhatsApp message, and there is no session — so the read
 * is refused by grant before RLS is ever consulted, and PostgREST answers
 * `permission denied for table orders`.
 *
 * To the buyer that is the same fact as an order that does not exist: this
 * device cannot see it. It is not an error and it must never reach the screen
 * as Postgres wrote it — a raw database string in front of a customer is the
 * trap HANDOFF already names for sellers, and a buyer has even less idea what
 * to do with it.
 */
export function readsAsNotOurs(error: { code?: string | null; message?: string | null }): boolean {
  // 42501 insufficient_privilege — no grant, which is the session-less case.
  // PGRST301 — JWT missing or rejected, the expired-session case.
  if (error.code === '42501' || error.code === 'PGRST301') return true;

  const message = (error.message ?? '').toLowerCase();
  return message.includes('permission denied') || message.includes('jwt');
}
