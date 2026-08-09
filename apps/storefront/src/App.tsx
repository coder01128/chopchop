import { useState } from 'react';
import { BrowserRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { StorefrontTenantGate } from './tenant/StorefrontTenantGate';
import { orderPath } from './tenant/useTenantSlug';
import { Header } from './shell/Header';
import { CartProvider } from './cart/CartProvider';
import { CartSheet } from './cart/CartSheet';
import { CataloguePage } from './catalogue/CataloguePage';
import { ProductSheet } from './catalogue/ProductSheet';
import { CheckoutSheet } from './checkout/CheckoutSheet';
import { StatusPage } from './status/StatusPage';
import type { StorefrontItem } from './storefront-data';
import styles from './App.module.css';

type Sheet =
  | { kind: 'none' }
  | { kind: 'product'; item: StorefrontItem }
  | { kind: 'cart' }
  | { kind: 'checkout' };

/**
 * The shop: catalogue, one product at a time, the cart, then checkout.
 *
 * Sheets rather than routes, because the whole thing is one thumb on one phone
 * and a back button that leaves the shop is a buyer lost.
 */
function Shopfront() {
  const navigate = useNavigate();
  const [sheet, setSheet] = useState<Sheet>({ kind: 'none' });

  return (
    <>
      <Header onCart={() => setSheet({ kind: 'cart' })} />
      <main className={styles.main}>
        <CataloguePage onOpen={(item) => setSheet({ kind: 'product', item })} />
      </main>

      {sheet.kind === 'product' && (
        <ProductSheet
          item={sheet.item}
          onClose={() => setSheet({ kind: 'none' })}
          onAdded={() => setSheet({ kind: 'cart' })}
        />
      )}

      {sheet.kind === 'cart' && (
        <CartSheet
          onClose={() => setSheet({ kind: 'none' })}
          onCheckout={() => setSheet({ kind: 'checkout' })}
        />
      )}

      {sheet.kind === 'checkout' && (
        <CheckoutSheet
          onClose={() => setSheet({ kind: 'cart' })}
          // The tab the buyer comes back to is their own order, not the form
          // they already submitted.
          onPlaced={(orderId) => navigate(orderPath(window.location.pathname, orderId))}
        />
      )}
    </>
  );
}

function Status() {
  return (
    <>
      <Header />
      <main className={styles.main}>
        <StatusPage />
      </main>
    </>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <StorefrontTenantGate>
        <CartProvider>
          <Routes>
            {/* Both addressings: a client's own domain, and the dev server
                serving either demo tenant off a slug. */}
            <Route path="/order/:orderId" element={<Status />} />
            <Route path="/:slug/order/:orderId" element={<Status />} />
            <Route path="*" element={<Shopfront />} />
          </Routes>
        </CartProvider>
      </StorefrontTenantGate>
    </BrowserRouter>
  );
}
