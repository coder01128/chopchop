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

interface DemoProfile { email: string; password: string }

const DEMO_PROFILES: Record<string, DemoProfile> = {
  '1':          { email: 'demo-shoes-owner@example.com', password: 'chopchop-demo-2026' },
  'trattoria':  { email: 'trattoria@mail.co.za',         password: 'trattor!@' },
};

function getDemoProfile(): DemoProfile | null {
  const val = new URLSearchParams(window.location.search).get('demo');
  return val ? DEMO_PROFILES[val] ?? null : null;
}

function Protected() {
  const { session, loading, signIn } = useAuth();
  const [demoProfile] = useState(getDemoProfile);
  const attemptedRef = useRef(false);

  useEffect(() => {
    if (!demoProfile || loading || session || attemptedRef.current) return;
    attemptedRef.current = true;
    signIn(demoProfile.email, demoProfile.password);
  }, [demoProfile, loading, session, signIn]);

  if (loading) return <Notice title="Loading…" />;

  if (demoProfile && !session) return <Notice title="Signing into demo…" />;

  if (!session) return <SignIn />;

  return (
    <>
      {demoProfile && <DemoBanner />}
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
