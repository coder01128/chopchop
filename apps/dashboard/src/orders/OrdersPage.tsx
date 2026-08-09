import { useCallback, useEffect, useMemo, useState } from 'react';
import { getSupabaseClient, useTenant } from '@chopchop/shared';
import { loadOrders, money, type OrderSummary } from './orders-data';
import { describeAge, groupByStatus, isStale, totalIsEstimate } from './order-model';
import { OrderDetail } from './OrderDetail';
import styles from './OrdersPage.module.css';

/**
 * The order queue — the screen a seller lives on.
 *
 * Grouped so that what is waiting on them comes first: a phone must show the
 * work without scrolling. Finished business sits at the bottom, present but out
 * of the way.
 */
export function OrdersPage() {
  const tenant = useTenant();
  const client = getSupabaseClient();

  const [summaries, setSummaries] = useState<OrderSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  // Recomputed on a timer so a `sent` order crossing 24 hours starts showing
  // its flag without a reload. Nothing is stored and nothing auto-cancels.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setSummaries(await loadOrders(client, tenant.id));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [client, tenant.id]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  // Realtime, not polling. Ticket 01B proved this path end to end: Postgres
  // Changes re-checks RLS per subscriber, so this only ever delivers rows this
  // tenant's policies already allow.
  useEffect(() => {
    const channel = client
      .channel(`orders-${tenant.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'orders', filter: `tenant_id=eq.${tenant.id}` },
        () => {
          void refresh();
        },
      )
      .subscribe();

    return () => {
      void client.removeChannel(channel);
    };
  }, [client, tenant.id, refresh]);

  const groups = useMemo(() => groupByStatus(summaries.map((s) => s.order)), [summaries]);
  const lineCounts = useMemo(
    () => new Map(summaries.map((s) => [s.order.id, s.lineCount])),
    [summaries],
  );

  const staleCount = summaries.filter((s) => isStale(s.order, now)).length;
  const open = summaries.find((s) => s.order.id === openId) ?? null;

  return (
    <section className={styles.page}>
      <header className={styles.head}>
        <div>
          <p className="cc-eyebrow">Orders</p>
          <h1 className={styles.heading}>Queue</h1>
        </div>
        {staleCount > 0 && (
          <p className={styles.staleSummary}>
            {staleCount} order{staleCount === 1 ? '' : 's'} to check against WhatsApp
          </p>
        )}
      </header>

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <p className={styles.loading}>Loading…</p>
      ) : summaries.length === 0 ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>No orders yet</p>
          <p className={styles.emptyBody}>
            Orders arrive here the moment a buyer taps through from your shop.
          </p>
        </div>
      ) : (
        <div className={styles.groups}>
          {groups
            .filter((group) => group.orders.length > 0)
            .map((group) => (
              <section key={group.status} className={styles.group} data-quiet={!group.needsAction || undefined}>
                <h2 className={styles.groupTitle}>
                  {group.title}
                  <span className={styles.groupCount}>{group.orders.length}</span>
                </h2>

                <ul className={styles.list}>
                  {group.orders.map((order) => {
                    const stale = isStale(order, now);
                    return (
                      <li key={order.id}>
                        <button
                          type="button"
                          className={styles.row}
                          data-stale={stale || undefined}
                          onClick={() => setOpenId(order.id)}
                        >
                          <span className={styles.rowTop}>
                            <span className={styles.reference}>{order.reference}</span>
                            <span className={styles.total}>
                              {money.format(Number(order.total))}
                              {totalIsEstimate(tenant.saleMode, order.status) && (
                                <span className={styles.estimate}>est.</span>
                              )}
                            </span>
                          </span>

                          <span className={styles.rowBottom}>
                            <span className={styles.customer}>{order.customer_name}</span>
                            <span className={styles.meta}>
                              {lineCounts.get(order.id) ?? 0} line
                              {(lineCounts.get(order.id) ?? 0) === 1 ? '' : 's'} ·{' '}
                              {describeAge(order.created_at, now)}
                            </span>
                          </span>

                          {stale && (
                            <span className={styles.staleFlag}>
                              Over 24 hours — check WhatsApp
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
        </div>
      )}

      {open && (
        <OrderDetail
          order={open.order}
          onClose={() => setOpenId(null)}
          onChanged={() => {
            setOpenId(null);
            void refresh();
          }}
        />
      )}
    </section>
  );
}
