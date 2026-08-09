import { useState } from 'react';
import { getSupabaseClient, useTenant } from '@chopchop/shared';
import { ensureBuyerSession, placeOrder } from '../storefront-data';
import { buildOrderMessage, money, totalIsEstimate, whatsappUrl } from '../storefront-model';
import { useCart } from '../cart/CartProvider';
import { messageLabelsFor } from './message-labels';
import styles from './CheckoutSheet.module.css';

/**
 * Checkout, and the WhatsApp handoff.
 *
 * The order of operations matters and is the whole of this component:
 *
 *   1. collect the details the order needs — an address only when the tenant
 *      delivers, never on a collect tenant;
 *   2. sign in anonymously, here and not on page load, so `auth.users` grows
 *      with orders rather than with traffic — and because the `anon` role holds
 *      no grant on `orders` at all, so a checkout that inserted first would
 *      simply fail;
 *   3. write the order, so the seller has a queue entry before the buyer
 *      leaves the page;
 *   4. open wa.me with a message composed from what was actually written;
 *   5. leave this tab on the buyer's own status page.
 *
 * The WhatsApp window is opened *synchronously inside the tap*, before any
 * await. A window opened from an async continuation is blocked by every mobile
 * browser, and a blocked handoff is the worst failure available here: the
 * seller never gets the message, while the order sits in their queue looking
 * like a phantom. If it is blocked anyway, the status page carries a button
 * that sends it — which is also how a buyer who never pressed send recovers.
 */
export function CheckoutSheet({
  onClose,
  onPlaced,
}: {
  onClose: () => void;
  onPlaced: (orderId: string) => void;
}) {
  const tenant = useTenant();
  const cart = useCart();
  const client = getSupabaseClient();

  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const delivers = tenant.fulfilmentMode === 'local_delivery';
  const estimate = totalIsEstimate(tenant.saleMode);

  async function run(waWindow: Window | null) {
    try {
      await ensureBuyerSession(client);
      const placed = await placeOrder(client, tenant.id, cart.lines, {
        customerName,
        customerPhone,
        deliveryAddress,
        notes,
      });

      const text = buildOrderMessage(
        {
          reference: placed.order.reference,
          customerName: placed.order.customer_name,
          deliveryAddress: placed.order.delivery_address,
          notes: placed.order.notes,
          total: Number(placed.order.total),
          lines: placed.lines.map((line) => ({ name: line.name_snapshot, qty: line.qty })),
        },
        tenant.saleMode,
        tenant.fulfilmentMode,
        messageLabelsFor(tenant),
      );

      const url = whatsappUrl(tenant.whatsappNumber, text);
      if (url && waWindow && !waWindow.closed) waWindow.location.replace(url);
      else waWindow?.close();

      cart.clear();
      onPlaced(placed.order.id);
    } catch (placeError) {
      waWindow?.close();
      setError(placeError instanceof Error ? placeError.message : String(placeError));
      setBusy(false);
    }
  }

  return (
    <div className={styles.backdrop} role="presentation">
      <div className={styles.sheet} role="dialog" aria-modal="true" aria-label={tenant.label('checkout', 'Checkout')}>
        <header className={styles.head}>
          <h2 className={styles.title}>{tenant.label('checkout', 'Checkout')}</h2>
          <button type="button" className={styles.close} onClick={onClose} disabled={busy}>
            Back
          </button>
        </header>

        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            if (busy) return;
            // Synchronous, inside the tap. Everything else waits.
            const waWindow = window.open('', '_blank');
            setBusy(true);
            setError(null);
            void run(waWindow);
          }}
        >
          <label className={styles.field}>
            <span>Your name</span>
            <input
              type="text"
              required
              autoComplete="name"
              value={customerName}
              onChange={(event) => setCustomerName(event.target.value)}
            />
          </label>

          <label className={styles.field}>
            <span>WhatsApp number</span>
            <input
              type="tel"
              required
              inputMode="tel"
              autoComplete="tel"
              placeholder="082 123 4567"
              value={customerPhone}
              onChange={(event) => setCustomerPhone(event.target.value)}
            />
          </label>

          {/* A collect tenant never sees an address field. */}
          {delivers && (
            <label className={styles.field}>
              <span>Delivery address</span>
              <textarea
                required
                rows={3}
                autoComplete="street-address"
                value={deliveryAddress}
                onChange={(event) => setDeliveryAddress(event.target.value)}
              />
            </label>
          )}

          <label className={styles.field}>
            <span>Anything else? (optional)</span>
            <textarea rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} />
          </label>

          <p className={styles.total}>
            <span>{estimate ? 'Estimated total' : 'Total'}</span>
            <span className={styles.totalAmount}>{money.format(cart.total)}</span>
          </p>

          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}

          <button type="submit" className={styles.send} disabled={busy || cart.lines.length === 0}>
            {busy ? 'Sending…' : 'Send on WhatsApp'}
          </button>
          <p className={styles.note}>
            This opens WhatsApp with your order ready to send. It only reaches the shop once
            you press send there.
          </p>
        </form>
      </div>
    </div>
  );
}
