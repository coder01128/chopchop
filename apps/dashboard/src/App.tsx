import { useEffect, useRef, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthProvider';
import { DemoBanner } from './auth/DemoBanner';
import { SignIn } from './auth/SignIn';
import { TenantGate } from './tenant/TenantGate';
import { Shell } from './shell/Shell';
import { ImportPage } from './import/ImportPage';
import { CataloguePage } from './catalogue/CataloguePage';
import { OrdersPage } from './orders/OrdersPage';
import { Settings } from './routes/Settings';
import { Notice } from './ui/Notice';

const DEMO_EMAIL = 'demo-shoes-owner@example.com';
const DEMO_PASSWORD = 'chopchop-demo-2026';

function isDemoRequested(): boolean {
  return new URLSearchParams(window.location.search).get('demo') === '1';
}

function Protected() {
  const { session, loading, signIn } = useAuth();
  const [demoActive] = useState(isDemoRequested);
  const attemptedRef = useRef(false);

  useEffect(() => {
    if (!demoActive || loading || session || attemptedRef.current) return;
    attemptedRef.current = true;
    signIn(DEMO_EMAIL, DEMO_PASSWORD);
  }, [demoActive, loading, session, signIn]);

  if (loading) return <Notice title="Loading…" />;

  if (demoActive && !session) return <Notice title="Signing into demo…" />;

  if (!session) return <SignIn />;

  return (
    <>
      {demoActive && <DemoBanner />}
      <TenantGate>
        <Routes>
          <Route element={<Shell />}>
            <Route path="/orders" element={<OrdersPage />} />
            <Route path="/catalogue" element={<CataloguePage />} />
            <Route path="/import" element={<ImportPage />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/orders" replace />} />
          </Route>
        </Routes>
      </TenantGate>
    </>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Protected />
      </AuthProvider>
    </BrowserRouter>
  );
}
