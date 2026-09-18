import { useEffect, useMemo, useState } from 'react';
import { BrowserRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { getSupabaseClient, useTenant } from '@chopchop/shared';
import { StorefrontTenantGate } from './tenant/StorefrontTenantGate';
import { orderPath } from './tenant/useTenantSlug';
import { Header } from './shell/Header';
import { CartProvider } from './cart/CartProvider';
import { CartSheet } from './cart/CartSheet';
import { CartSidebar } from './cart/CartSidebar';
import { MobileCartBar } from './cart/MobileCartBar';
import { CategoryNav } from './catalogue/CategoryNav';
import { SearchBar } from './catalogue/SearchBar';
import { CataloguePage } from './catalogue/CataloguePage';
import { ProductSheet } from './catalogue/ProductSheet';
import { CheckoutSheet } from './checkout/CheckoutSheet';
import { StatusPage } from './status/StatusPage';
import { loadCatalogue, type Catalogue, type StorefrontItem } from './storefront-data';
import styles from './App.module.css';

type Sheet =
  | { kind: 'none' }
  | { kind: 'product'; item: StorefrontItem }
  | { kind: 'cart' }
  | { kind: 'checkout' };

function Shopfront() {
  const navigate = useNavigate();
  const tenant = useTenant();
  const client = getSupabaseClient();

  const [sheet, setSheet] = useState<Sheet>({ kind: 'none' });
  const [catalogue, setCatalogue] = useState<Catalogue>({ categories: [], items: [] });
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    loadCatalogue(client, tenant.id)
      .then((loaded) => {
        if (active) setCatalogue(loaded);
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
  }, [client, tenant.id]);

  useEffect(() => {
    if (menuOpen) {
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = '';
      };
    }
  }, [menuOpen]);

  const visible = useMemo(() => {
    let items = catalogue.items;
    if (categoryId !== null) {
      items = items.filter((item) => item.categoryId === categoryId);
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      items = items.filter(
        (item) =>
          item.name.toLowerCase().includes(q) ||
          (item.description?.toLowerCase().includes(q) ?? false),
      );
    }
    const catOrder = new Map(catalogue.categories.map((cat, i) => [cat.id, i]));
    return [...items].sort((a, b) => {
      const aIdx = a.categoryId ? catOrder.get(a.categoryId) ?? Infinity : Infinity;
      const bIdx = b.categoryId ? catOrder.get(b.categoryId) ?? Infinity : Infinity;
      return aIdx - bIdx;
    });
  }, [catalogue, categoryId, searchQuery]);

  const activeCategoryName = categoryId
    ? catalogue.categories.find((c) => c.id === categoryId)?.name ?? null
    : null;

  function selectCategory(id: string | null) {
    setCategoryId(id);
    setMenuOpen(false);
  }

  return (
    <>
      <Header
        onMenuToggle={() => setMenuOpen((o) => !o)}
        activeCategoryName={activeCategoryName}
      />

      <div className={styles.layout}>
        <aside className={styles.sidebar}>
          <CategoryNav
            categories={catalogue.categories}
            activeId={categoryId}
            onSelect={selectCategory}
          />
        </aside>

        <main className={styles.center}>
          <SearchBar value={searchQuery} onChange={setSearchQuery} />
          <CataloguePage
            items={visible}
            loading={loading}
            error={error}
            hasFilters={categoryId !== null || searchQuery !== ''}
            onOpen={(item) => setSheet({ kind: 'product', item })}
          />
        </main>

        <aside className={styles.cartPanel}>
          <CartSidebar onCheckout={() => setSheet({ kind: 'checkout' })} />
        </aside>
      </div>

      <MobileCartBar onTap={() => setSheet({ kind: 'cart' })} />

      {menuOpen && (
        <div
          className={styles.drawerBackdrop}
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setMenuOpen(false);
          }}
        >
          <aside className={styles.drawer}>
            <CategoryNav
              categories={catalogue.categories}
              activeId={categoryId}
              onSelect={selectCategory}
            />
          </aside>
        </div>
      )}

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
          onClose={() => setSheet({ kind: 'none' })}
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
      <main className={styles.statusMain}>
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
            <Route path="/order/:orderId" element={<Status />} />
            <Route path="/:slug/order/:orderId" element={<Status />} />
            <Route path="*" element={<Shopfront />} />
          </Routes>
        </CartProvider>
      </StorefrontTenantGate>
    </BrowserRouter>
  );
}
