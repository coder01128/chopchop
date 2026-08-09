import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthProvider';
import { SignIn } from './auth/SignIn';
import { TenantGate } from './tenant/TenantGate';
import { Shell } from './shell/Shell';
import { Import } from './routes/Placeholder';
import { CataloguePage } from './catalogue/CataloguePage';
import { OrdersPage } from './orders/OrdersPage';
import { Settings } from './routes/Settings';
import { Notice } from './ui/Notice';

/**
 * Route protection is a gate around the whole router rather than a wrapper per
 * route: there is no public dashboard screen, so an unauthenticated visitor
 * reaching *any* path lands on sign-in. A per-route guard invites the one route
 * somebody forgets to wrap.
 */
function Protected() {
  const { session, loading } = useAuth();

  // The gap while the persisted session is read back off the device. Without
  // this, every reload flashes the sign-in screen before restoring.
  if (loading) return <Notice title="Loading…" />;
  if (!session) return <SignIn />;

  return (
    <TenantGate>
      <Routes>
        <Route element={<Shell />}>
          <Route path="/orders" element={<OrdersPage />} />
          <Route path="/catalogue" element={<CataloguePage />} />
          <Route path="/import" element={<Import />} />
          <Route path="/settings" element={<Settings />} />
          {/* Orders is the default landing screen — wireframe section 01. */}
          <Route path="*" element={<Navigate to="/orders" replace />} />
        </Route>
      </Routes>
    </TenantGate>
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
