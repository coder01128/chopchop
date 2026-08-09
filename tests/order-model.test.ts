// The order queue's rules, tested without a browser.
//
//   npm test
//
// Same reasoning as variant-model.test.ts: the parts that must not drift — what
// may follow what, when an order is stale, what a confirmed weight line costs —
// are pure functions, so they are checkable at their edges.

import { describe, expect, it } from 'vitest';
import type { OrderStatus } from '@chopchop/shared';
import {
  BLOCKING_STATUSES,
  DISMISSED_STATUS,
  STALE_AFTER_MS,
  STATUS_FLOW,
  adjustsQuantityOnConfirm,
  allowedTransitions,
  blocksVariantRemoval,
  canTransition,
  effectiveQty,
  groupByStatus,
  isStale,
  isTerminal,
  lineTotalFor,
  orderTotalFor,
  totalIsEstimate,
  type OrderLine,
} from '../apps/dashboard/src/orders/order-model';

const ALL_STATUSES: OrderStatus[] = [
  'sent',
  'received',
  'confirmed',
  'ready',
  'completed',
  'cancelled',
];

describe('transitions', () => {
  it('moves forward one step at a time', () => {
    expect(allowedTransitions('sent')).toEqual(['received', 'cancelled']);
    expect(allowedTransitions('received')).toEqual(['confirmed']);
    expect(allowedTransitions('confirmed')).toEqual(['ready']);
    expect(allowedTransitions('ready')).toEqual(['completed']);
  });

  it('keeps received and confirmed separate', () => {
    // An acknowledgement is not a promise. There is no control that does both.
    expect(canTransition('sent', 'confirmed')).toBe(false);
    expect(canTransition('received', 'ready')).toBe(false);
  });

  it('allows no backward moves', () => {
    for (const from of STATUS_FLOW) {
      for (const to of STATUS_FLOW) {
        if (STATUS_FLOW.indexOf(to) < STATUS_FLOW.indexOf(from)) {
          expect(canTransition(from, to), `${from} -> ${to} should be refused`).toBe(false);
        }
      }
    }
  });

  it('refuses every pair that is not an allowed step', () => {
    for (const from of ALL_STATUSES) {
      const allowed = allowedTransitions(from);
      for (const to of ALL_STATUSES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(allowed.includes(to));
      }
    }
  });

  it('only lets a phantom be dismissed', () => {
    // Once the seller has acknowledged an order, dismissing it would throw away
    // work they have already started.
    expect(canTransition('sent', DISMISSED_STATUS)).toBe(true);
    for (const from of ['received', 'confirmed', 'ready'] as OrderStatus[]) {
      expect(canTransition(from, DISMISSED_STATUS), `${from} must not be dismissible`).toBe(false);
    }
  });

  it('lets nothing leave a terminal status', () => {
    expect(isTerminal('completed')).toBe(true);
    expect(isTerminal(DISMISSED_STATUS)).toBe(true);
    expect(allowedTransitions('completed')).toEqual([]);
    expect(allowedTransitions(DISMISSED_STATUS)).toEqual([]);
  });

  it('dismisses to a status that is not completed', () => {
    // Revenue metrics run off `completed` only. A dismissed phantom must never
    // be able to reach them.
    expect(DISMISSED_STATUS).not.toBe('completed');
    expect(STATUS_FLOW).not.toContain(DISMISSED_STATUS);
  });
});

describe('staleness', () => {
  const at = (msAgo: number) => new Date(Date.UTC(2026, 7, 9, 12, 0, 0) - msAgo).toISOString();
  const now = Date.UTC(2026, 7, 9, 12, 0, 0);

  it('flags a sent order past the window', () => {
    expect(isStale({ status: 'sent', created_at: at(STALE_AFTER_MS + 60_000) }, now)).toBe(true);
  });

  it('does not flag one inside the window', () => {
    expect(isStale({ status: 'sent', created_at: at(STALE_AFTER_MS - 60_000) }, now)).toBe(false);
  });

  it('does not flag exactly on the boundary', () => {
    // Strictly older than the window, so the boundary itself is not stale.
    expect(isStale({ status: 'sent', created_at: at(STALE_AFTER_MS) }, now)).toBe(false);
  });

  it('flags one millisecond past the boundary', () => {
    expect(isStale({ status: 'sent', created_at: at(STALE_AFTER_MS + 1) }, now)).toBe(true);
  });

  it('never flags an order the seller has already acknowledged', () => {
    for (const status of ['received', 'confirmed', 'ready', 'completed', 'cancelled'] as OrderStatus[]) {
      expect(isStale({ status, created_at: at(STALE_AFTER_MS * 10) }, now), status).toBe(false);
    }
  });

  it('uses a single named window of 24 hours', () => {
    expect(STALE_AFTER_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe('variant removal blocking', () => {
  it('blocks on every status the seller can still act on', () => {
    expect(BLOCKING_STATUSES).toEqual(['sent', 'received', 'confirmed', 'ready']);
  });

  it('releases a dismissed order', () => {
    // This is what makes dismissal useful: the phantom stops holding its
    // variants hostage.
    expect(blocksVariantRemoval(DISMISSED_STATUS)).toBe(false);
  });

  it('releases a completed order', () => {
    expect(blocksVariantRemoval('completed')).toBe(false);
  });

  it('blocks exactly the non-terminal statuses', () => {
    for (const status of ALL_STATUSES) {
      expect(blocksVariantRemoval(status), status).toBe(!isTerminal(status));
    }
  });
});

describe('confirmation arithmetic', () => {
  function line(overrides: Partial<OrderLine> = {}): OrderLine {
    return {
      id: 'l1',
      name_snapshot: 'Rump Steak — per kg',
      price_snapshot: 189.9,
      qty: 1,
      qty_confirmed: null,
      line_total: 189.9,
      ...overrides,
    };
  }

  it('only a weight tenant adjusts quantities', () => {
    expect(adjustsQuantityOnConfirm('weight')).toBe(true);
    // A shoe seller seeing a weight field is the product failing.
    expect(adjustsQuantityOnConfirm('unit')).toBe(false);
  });

  it('uses the ordered quantity until one is weighed', () => {
    expect(effectiveQty(line())).toBe(1);
    expect(effectiveQty(line({ qty_confirmed: 1.15 }))).toBe(1.15);
  });

  it('recomputes the line total from the weighed quantity', () => {
    // 1kg asked for, 1.15kg cut.
    expect(lineTotalFor(line({ qty_confirmed: 1.15 }))).toBe(218.39);
  });

  it('rounds to cents, because line_total is numeric(10,2)', () => {
    expect(lineTotalFor(line({ price_snapshot: 10.005, qty: 1 }))).toBe(10.01);
    expect(lineTotalFor(line({ price_snapshot: 33.333, qty: 3 }))).toBe(100);
  });

  it('leaves a unit tenant\'s totals alone', () => {
    // qty_confirmed stays null on a unit tenant, so the total is what was ordered.
    const unitLine = line({ price_snapshot: 899, qty: 2, qty_confirmed: null });
    expect(unitLine.qty_confirmed).toBeNull();
    expect(lineTotalFor(unitLine)).toBe(1798);
  });

  it('sums an order from its lines', () => {
    expect(
      orderTotalFor([
        line({ id: 'a', price_snapshot: 189.9, qty: 1, qty_confirmed: 1.15 }),
        line({ id: 'b', price_snapshot: 59.95, qty: 2 }),
      ]),
    ).toBe(338.29);
  });

  it('calls a weight total an estimate only until it is confirmed', () => {
    expect(totalIsEstimate('weight', 'sent')).toBe(true);
    expect(totalIsEstimate('weight', 'received')).toBe(true);
    expect(totalIsEstimate('weight', 'confirmed')).toBe(false);
    // A unit tenant's total is never an estimate.
    expect(totalIsEstimate('unit', 'sent')).toBe(false);
  });
});

describe('queue grouping', () => {
  it('puts what needs action before finished business', () => {
    const grouped = groupByStatus([
      { status: 'completed' as OrderStatus },
      { status: 'sent' as OrderStatus },
      { status: 'cancelled' as OrderStatus },
    ]);
    const order = grouped.map((group) => group.status);
    expect(order.indexOf('sent')).toBeLessThan(order.indexOf('completed'));
    expect(order.indexOf('completed')).toBeLessThan(order.indexOf('cancelled'));
  });

  it('covers every status the enum defines', () => {
    const covered = groupByStatus([]).map((group) => group.status);
    expect([...covered].sort()).toEqual([...ALL_STATUSES].sort());
  });
});
