import { useTenant } from '@chopchop/shared';
import { StorefrontTenantGate } from './tenant/StorefrontTenantGate';
import { Header } from './shell/Header';
import styles from './App.module.css';

/**
 * Ticket 02 stops at the header. The catalogue, the product modal generated
 * from attribute_schema, the cart and the wa.me handoff are later tickets —
 * this renders the shop's chrome and says so.
 */
function Shopfront() {
  const tenant = useTenant();

  return (
    <>
      <Header />
      <main className={styles.main}>
        <p className="cc-eyebrow">Not built yet</p>
        <h1 className={styles.heading}>{tenant.label('catalogue', 'Catalogue')}</h1>
        <p className={styles.blurb}>
          The catalogue, cart and WhatsApp order handoff land in a later ticket.
        </p>
      </main>
    </>
  );
}

export function App() {
  return (
    <StorefrontTenantGate>
      <Shopfront />
    </StorefrontTenantGate>
  );
}
