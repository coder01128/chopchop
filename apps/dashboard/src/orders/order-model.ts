import type { OrderStatus, SaleMode } from '@chopchop/shared';

/**
 * The order queue's rules, as pure functions.
 *
 * Same pattern as variant-model.ts and for the same reason: the parts that must
 * not drift — what may follow what, when an order is stale, what a confirmed
 * weight line actually costs — are checkable without a browser.
 */

/**
 * Forward only.
 *
 * `received` and `confirmed` are deliberately separate and stay that way:
 * received is an acknowledgement, confirmed is a promise. There is no control
 * that performs both.
 *
 * There are no backward moves in v1. Correcting a mis-tap is a real need and an
 * open question, not something to invent here.
 */
export const STATUS_FLOW: OrderStatus[] = [
  'sent',
  'received',
  'confirmed',
  'ready',
  'completed',
];

/** The phantom's exit. Terminal, and deliberately not `completed`. */
export const DISMISSED_STATUS: OrderStatus = 'cancelled';

/**
 * Statuses that still hold a variant hostage.
 *
 * This is the single definition — the ticket 03B removal classifier imports it
 * rather than keeping its own copy, so dismissing a phantom order really does
 * release the variants it was blocking. Two lists would drift, and the symptom
 * would be a seller unable to delete a variant with nothing on screen to
 * explain why.
 *
 * `completed` and `cancelled` are absent: both are terminal, and neither is
 * something the seller can still act on.
 */
export const BLOCKING_STATUSES: OrderStatus[] = ['sent', 'received', 'confirmed', 'ready'];

export function blocksVariantRemoval(status: OrderStatus): boolean {
  return BLOCKING_STATUSES.includes(status);
}

/** True once an order can no longer move. */
export function isTerminal(status: OrderStatus): boolean {
  return status === 'completed' || status === DISMISSED_STATUS;
}

/**
 * What this order may become next. At most one forward step, plus dismissal
 * for a `sent` order that never arrived.
 */
export function allowedTransitions(status: OrderStatus): OrderStatus[] {
  if (isTerminal(status)) return [];

  const next: OrderStatus[] = [];
  const index = STATUS_FLOW.indexOf(status);
  if (index >= 0 && index < STATUS_FLOW.length - 1) next.push(STATUS_FLOW[index + 1]);

  // Only a phantom can be dismissed. Once the seller has acknowledged an order,
  // dismissing it would be throwing away work they have already started.
  if (status === 'sent') next.push(DISMISSED_STATUS);

  return next;
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return allowedTransitions(from).includes(to);
}

/** Seller-facing wording for the button that performs a transition. */
export function transitionLabel(to: OrderStatus): string {
  switch (to) {
    case 'received':
      return 'Mark received';
    case 'confirmed':
      return 'Confirm order';
    case 'ready':
      return 'Mark ready';
    case 'completed':
      return 'Mark completed';
    case 'cancelled':
      return 'Dismiss';
    default:
      return to;
  }
}

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

/**
 * A `sent` order older than this is worth checking against WhatsApp — the buyer
 * may have tapped through and never pressed send.
 *
 * One named constant, computed at render time. No stored column, no cron, no
 * background job, and nothing auto-cancels: age is a prompt to look, not a
 * verdict.
 */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * `now` is injected rather than read inside, so the boundary is testable.
 * A function that calls Date.now() internally cannot be tested at its edges.
 */
export function isStale(
  order: { status: OrderStatus; created_at: string },
  now: number,
): boolean {
  if (order.status !== 'sent') return false;
  return now - new Date(order.created_at).getTime() > STALE_AFTER_MS;
}

/** "2 days ago" — enough for a seller to judge whether an order is a phantom. */
export function describeAge(iso: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

// ---------------------------------------------------------------------------
// Confirmation arithmetic
// ---------------------------------------------------------------------------

export interface OrderLine {
  id: string;
  name_snapshot: string;
  price_snapshot: number;
  qty: number;
  qty_confirmed: number | null;
  line_total: number;
}

/**
 * Does this tenant adjust quantities when confirming?
 *
 * Only a weight tenant does — the seller cuts, weighs, and enters what the
 * scale said. A unit tenant never sees a quantity-adjustment control, and no
 * weight language appears anywhere on their screen. Same white-label gate as
 * the variant editor: a shoe seller seeing a weight field is the product
 * failing.
 */
export function adjustsQuantityOnConfirm(saleMode: SaleMode): boolean {
  return saleMode === 'weight';
}

/**
 * The quantity that actually counts: what was weighed if the seller has entered
 * it, otherwise what was ordered.
 */
export function effectiveQty(line: OrderLine): number {
  return line.qty_confirmed ?? line.qty;
}

/**
 * `line_total` is a stored column, not generated, so confirming has to write
 * it. Rounded to cents because the column is numeric(10,2) and letting Postgres
 * round a half-cent would make the seller's arithmetic disagree with the
 * screen's.
 */
export function lineTotalFor(line: OrderLine): number {
  return Math.round(line.price_snapshot * effectiveQty(line) * 100) / 100;
}

export function orderTotalFor(lines: OrderLine[]): number {
  return Math.round(lines.reduce((sum, line) => sum + lineTotalFor(line), 0) * 100) / 100;
}

/**
 * On a weight tenant the total shown before confirmation is an estimate — the
 * buyer asked for 1kg and will be charged for the 1.15kg actually cut.
 */
export function totalIsEstimate(saleMode: SaleMode, status: OrderStatus): boolean {
  return saleMode === 'weight' && (status === 'sent' || status === 'received');
}

// ---------------------------------------------------------------------------
// Queue grouping
// ---------------------------------------------------------------------------

/**
 * Order of the queue: what is waiting on the seller comes first, so a phone
 * shows the work without scrolling. Finished business sits at the bottom.
 */
export const QUEUE_GROUPS: { status: OrderStatus; title: string; needsAction: boolean }[] = [
  { status: 'sent', title: 'New', needsAction: true },
  { status: 'received', title: 'Acknowledged', needsAction: true },
  { status: 'confirmed', title: 'Confirmed', needsAction: true },
  { status: 'ready', title: 'Ready', needsAction: true },
  { status: 'completed', title: 'Completed', needsAction: false },
  { status: 'cancelled', title: 'Dismissed', needsAction: false },
];

export function groupByStatus<T extends { status: OrderStatus }>(
  orders: T[],
): { status: OrderStatus; title: string; needsAction: boolean; orders: T[] }[] {
  return QUEUE_GROUPS.map((group) => ({
    ...group,
    orders: orders.filter((order) => order.status === group.status),
  }));
}
