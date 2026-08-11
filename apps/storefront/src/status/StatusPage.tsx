import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getSupabaseClient, useTenant } from '@chopchop/shared';
import { loadOrder, type PlacedOrder } from '../storefront-data';
import {
  buildOrderMessage,
  describeStatus,
  formatQty,
  money,
  showsWeighedQuantity,
  totalIsEstimate,
  whatsappUrl,
} from '../storefront-model';
import { messageLabelsFor } from '../checkout/message-labels';
import { shopPath } from '../tenant/useTenantSlug';
import styles from './StatusPage.module.css';

/**
 * The buyer's own order, live.
 *
 * Reached by id, and readable only because `buyer_id = auth.uid()` — the one
 * per-row check RLS can express here, and the reason this page works with
 * Realtime instead of polling. It also means the page works on the device that
 * placed the order and nowhere else, which the page says out loud rather than
 * leaving a buyer to discover on their laptop.
 *
 * Everything rendered comes from the snapshot columns. Nothing joins
 * `variants`: a variant retired since the order was placed is filtered out of
 * the buyer's view by policy, and a join would quietly drop the line.
 */
export function StatusPage() {
  const { orderId } = useParams();
  const tenant = useTenant();
  const client = getSupabaseClient();

  const [placed, setPlaced] = useState<PlacedOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!orderId) return;
    let active = true;

    setLoading(true);
    setFailed(false);
    loadOrder(client, orderId)
      .then((loaded) => {
        if (active) setPlaced(loaded);
      })
      .catch(() => {
        if (active) setFailed(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [client, orderId]);

  // Realtime, not polling. Postgres Changes re-checks RLS per subscriber, so
  // this only ever delivers the buyer's own row — which is exactly what ticket
  // 01B proved end to end.
  useEffect(() => {
    if (!orderId) return;

    const channel = client
      .channel(`order-${orderId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'orders', filter: `id=eq.${orderId}` },
        () => {
          void loadOrder(client, orderId).then((fresh) => {
            if (fresh) setPlaced(fresh);
          });
        },
      )
      .subscribe();

    return () => {
      void client.removeChannel(channel);
    };
  }, [client, orderId]);

  if (loading) return <p className={styles.loading}>Loading…</p>;

  // Only genuine failures reach here — a network drop, or Supabase down. A
  // refused read is not one of them: that means this device does not hold the
  // order, and it falls through to the screen below. Nothing renders the
  // database's own words either way.
  if (failed) {
    return (
      <section className={styles.page}>
        <h1 className={styles.heading}>We could not load this order</h1>
        <p className={styles.body}>
          Check your connection and try again. Your order is safe — the shop already has it.
        </p>
        <Link className={styles.back} to={shopPath(window.location.pathname)}>
          Back to {tenant.label('catalogue', 'the shop')}
        </Link>
      </section>
    );
  }

  if (!placed) {
    return (
      <section className={styles.page}>
        <h1 className={styles.heading}>We cannot find that order</h1>
        <p className={styles.body}>
          An order can only be opened on the phone or browser it was placed from — that device
          holds the session it belongs to. If you have the WhatsApp message, the shop can find
          it by its reference.
        </p>
        <Link className={styles.back} to={shopPath(window.location.pathname)}>
          Back to {tenant.label('catalogue', 'the shop')}
        </Link>
      </section>
    );
  }

  const { order, lines } = placed;
  const copy = describeStatus(order.status, tenant.fulfilmentMode);
  const estimate = totalIsEstimate(tenant.saleMode) && (order.status === 'sent' || order.status === 'received');
  const message = buildOrderMessage(
    {
      reference: order.reference,
      customerName: order.customer_name,
      deliveryAddress: order.delivery_address,
      notes: order.notes,
      total: Number(order.total),
      lines: lines.map((line) => ({ name: line.name_snapshot, qty: line.qty })),
    },
    tenant.saleMode,
    tenant.fulfilmentMode,
    messageLabelsFor(tenant),
  );
  const waUrl = whatsappUrl(tenant.whatsappNumber, message);

  return (
    <section className={styles.page}>
      <p className="cc-eyebrow">{tenant.label('order', 'Order')} {order.reference}</p>
      <h1 className={styles.heading} data-live={copy.live || undefined}>
        {copy.title}
      </h1>
      <p className={styles.body}>{copy.body}</p>

      {/* Also the recovery path for a buyer whose browser blocked the handoff,
          and for the dismissed order whose message never arrived. */}
      {waUrl && copy.live && (
        <a className={styles.wa} href={waUrl} target="_blank" rel="noopener noreferrer">
          Open this order in WhatsApp
        </a>
      )}

      <ul className={styles.lines}>
        {lines.map((line) => (
          <li key={line.id} className={styles.line}>
            <div className={styles.lineTop}>
              <span className={styles.name}>{line.name_snapshot}</span>
              <span className={styles.amount}>{money.format(line.line_total)}</span>
            </div>
            <div className={styles.lineMeta}>
              {formatQty(line.qty, tenant.saleMode)} × {money.format(line.price_snapshot)}
              {/* The moment the estimate becomes real. Both figures, so the
                  buyer sees what changed rather than a number that moved. */}
              {showsWeighedQuantity(
                { qty: line.qty, qtyConfirmed: line.qty_confirmed },
                tenant.saleMode,
              ) && (
                <span className={styles.weighed}>
                  weighed {formatQty(line.qty_confirmed as number, tenant.saleMode)}
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>

      <p className={styles.total}>
        <span>{estimate ? 'Estimated total' : 'Total'}</span>
        <span className={styles.totalAmount}>{money.format(Number(order.total))}</span>
      </p>

      <dl className={styles.facts}>
        <div>
          <dt>{tenant.fulfilmentMode === 'local_delivery' ? 'Delivery to' : 'Collection'}</dt>
          <dd>
            {tenant.fulfilmentMode === 'local_delivery'
              ? order.delivery_address || '—'
              : `From ${tenant.name}`}
          </dd>
        </div>
        <div>
          <dt>Name</dt>
          <dd>{order.customer_name}</dd>
        </div>
        {order.notes && (
          <div>
            <dt>Your note</dt>
            <dd>{order.notes}</dd>
          </div>
        )}
      </dl>

      <p className={styles.device}>
        Keep this tab. This page only opens on the device the order was placed from — there is
        no login, which is also why nobody else can see it.
      </p>

      <Link className={styles.back} to={shopPath(window.location.pathname)}>
        Back to {tenant.label('catalogue', 'the shop')}
      </Link>
    </section>
  );
}
