import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // One .env at the repo root serves both apps and the node scripts. Only
  // VITE_-prefixed variables reach the bundle, which is exactly why the private
  // key does not carry that prefix — see packages/shared/src/supabase.ts.
  envDir: '../../',
  // 5173 by default, but honour PORT so the harness can hand us a free one when
  // 5173 is already taken. Auth here is email/password, so no callback URL is
  // pinned to a fixed port.
  server: { port: Number(process.env.PORT) || 5173 },
});
