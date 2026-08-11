import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@chopchop/shared/theme.css';
import { App } from './App';
import { registerServiceWorker } from './pwa/install';

registerServiceWorker();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
