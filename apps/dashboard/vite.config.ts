import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // One .env at the repo root serves both apps and the node scripts. Only
  // VITE_-prefixed variables reach the bundle, which is exactly why the private
  // key does not carry that prefix — see packages/shared/src/supabase.ts.
  envDir: '../../',
  server: { port: 5173 },
});
