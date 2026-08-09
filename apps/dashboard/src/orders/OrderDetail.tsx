import { useEffect, useMemo, useState } from 'react';
import { getSupabaseClient, useTenant } from '@chopchop/shared';
import {
  confirmOrder,
  loadOrderLines,
  money,
  transitionOrder,
  type OrderRow,
} from './orders-data';
import {
  adjustsQuantityOnConfirm,
  allowedTransitions,
  describeAge,
  DISMISSED_STATUS,
  isStale,
  lineTotalFor,
  orderTotalFor,
  totalIsEstimate,
  transitionLabel,
  type OrderLine,
} from './order-model';
import styles from './OrderDetail.module.css';

/**
 * One order, its lines, and what may happen to it next.
 *
 * Lines are rendered entirely from the snapshot columns. Nothing here joins
 * `variants` — a variant retired since the order was placed would drop out of
 * the join, and the whole point of the snapshots is that history does not
 * depend on a mutable product row.
 */
export function OrderDetail({
  order,
  onClose,
  onChanged,
}: {
  order: OrderRow;
  onClose: () => void;
  onChanged: () => void;
}) {
  const tenant = useTenant();
  const client = getSupabaseClient();
  const now = Date.now();

  const [lines, setLines] = useState<OrderLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [dismissing, setDismissing] = useState(false);

  const adjustsQuantity = adjustsQuantityOnConfirm(tenant.saleMode);

  useEffect(() => {
    let active = true;
    setLoading(true);
    loadOrderLines(client, order.id)
      .then((loaded) => {
        if (!active) return;
        setLines(loaded);
      })
      .catch((loadError) => {
        if (active) setError(loadError instanceof Error ? loadError.message : String(loadError));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, order.id]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape' && !busy) onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const transitions = allowedTransitions(order.status);
  const forward = transitions.filter((status) => status !== DISMISSED_STATUS);
  const canDismiss = transitions.includes(DISMISSED_STATUS);

  const runningTotal = useMemo(() => orderTotalFor(lines), [lines]);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
      onChanged();
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : String(runError));
      setBusy(false);
    }
  }

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-label={`Order ${order.reference}`}>
        <header className={styles.head}>
          <div>
            <p className="cc-eyebrow">{order.status}</p>
            <h2 className={styles.title}>{order.reference}</h2>
          </div>
          <button type="button" className={styles.ghost} onClick={onClose} disabled={busy}>
            Close
          </button>
        </header>

        <div className={styles.body}>
          <dl className={styles.facts}>
            <div>
              <dt>Buyer</dt>
              <dd>{order.customer_name}</dd>
            </div>
            <div>
              <dt>Phone</dt>
              <dd>{order.customer_phone}</dd>
            </div>
            <div>
              <dt>Fulfilment</dt>
              <dd>{order.fulfilment === 'local_delivery' ? 'Local delivery' : 'Collect'}</dd>
            </div>
            <div>
              <dt>Placed</dt>
              <dd>{describeAge(order.created_at, now)}</dd>
            </div>
          </dl>

          {order.notes && (
            <p className={styles.note}>
              <span className={styles.noteLabel}>Buyer note</span>
              {order.notes}
            </p>
          )}

          {isStale(order, now) && (
            <p className={styles.staleBanner}>
              This order is over 24 hours old and was never acknowledged. Check WhatsApp before
              acting on it — the buyer may have tapped through without sending.
            </p>
          )}

          {loading ? (
            <p className={styles.loading}>Loading lines…</p>
          ) : (
            <ul className={styles.lines}>
              {lines.map((line) => (
                <li key={line.id} className={styles.line}>
                  <div className={styles.lineTop}>
                    <span className={styles.lineName}>{line.name_snapshot}</span>
                    <span className={styles.lineTotal}>{money.format(lineTotalFor(line))}</span>
                  </div>
                  <div className={styles.lineMeta}>
                    {line.qty} × {money.format(line.price_snapshot)}
                    {line.qty_confirmed !== null && line.qty_confirmed !== line.qty && (
                      <span className={styles.adjusted}>weighed {line.qty_confirmed}</span>
                    )}
                  </div>

                  {/* Only a weight tenant adjusts quantities. A unit tenant
                      never sees this control and no weight language appears
                      anywhere on their screen. */}
                  {confirming && adjustsQuantity && (
                    <label className={styles.qtyField}>
                      <span>Actual quantity</span>
                      <input
                        type="number"
                        min="0"
                        step="0.001"
                        inputMode="decimal"
                        value={line.qty_confirmed ?? ''}
                        placeholder={String(line.qty)}
                        onChange={(event) => {
                          const raw = event.target.value;
                          setLines((current) =>
                            current.map((entry) =>
                              entry.id === line.id
                                ? { ...entry, qty_confirmed: raw === '' ? null : Number(raw) }
                                : entry,
                            ),
                          );
                        }}
                      />
                    </label>
                  )}
                </li>
              ))}
            </ul>
          )}

          <p className={styles.orderTotal}>
            <span>Total</span>
            <span>
              {money.format(confirming ? runningTotal : Number(order.total))}
              {!confirming && totalIsEstimate(tenant.saleMode, order.status) && (
                <span className={styles.estimate}>estimate until confirmed</span>
              )}
            </span>
          </p>

          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
        </div>

        <footer className={styles.actions}>
          {forward.map((next) => {
            // Confirming a weight order opens the quantity fields first, so the
            // seller enters what the scale said before committing to a price.
            const opensQuantities = next === 'confirmed' && adjustsQuantity && !confirming;
            return (
              <button
                key={next}
                type="button"
                className={styles.primary}
                disabled={busy || loading}
                onClick={() => {
                  if (opensQuantities) {
                    setConfirming(true);
                    return;
                  }
                  // Every confirm goes through the RPC, weight tenant or not:
                  // it is the one transition that moves stock, and that has to
                  // happen in the same transaction as the lines.
                  if (next === 'confirmed') {
                    void run(async () => {
                      const confirmed = await confirmOrder(client, tenant.id, order.id, lines);
                      setLines(confirmed.lines);
                    });
                    return;
                  }
                  void run(() => transitionOrder(client, order.id, next));
                }}
              >
                {opensQuantities ? 'Confirm order' : transitionLabel(next)}
              </button>
            );
          })}

          {canDismiss && (
            <button
              type="button"
              className={styles.danger}
              disabled={busy}
              onClick={() => setDismissing(true)}
            >
              {transitionLabel(DISMISSED_STATUS)}
            </button>
          )}
        </footer>
      </div>

      {dismissing && (
        <div className={styles.confirmBackdrop} role="presentation">
          <div className={styles.confirm} role="dialog" aria-modal="true" aria-label="Dismiss order">
            <h3 className={styles.confirmTitle}>Dismiss {order.reference}?</h3>
            <p className={styles.confirmBody}>
              Placed {describeAge(order.created_at, now)}.
            </p>
            <p className={styles.confirmBody}>
              This is for orders that never arrived on WhatsApp — the buyer tapped through to send
              and never pressed send. Check the chat first.
            </p>
            <p className={styles.confirmBody}>
              <strong>The buyer is not notified.</strong> Nothing is sent, and this cannot be
              undone. It never counts towards revenue, and it releases the products this order was
              holding.
            </p>
            <div className={styles.confirmActions}>
              <button type="button" className={styles.ghost} onClick={() => setDismissing(false)} disabled={busy}>
                Keep it
              </button>
              <button
                type="button"
                className={styles.danger}
                disabled={busy}
                onClick={() => void run(() => transitionOrder(client, order.id, DISMISSED_STATUS))}
              >
                Dismiss order
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
