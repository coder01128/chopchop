import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // These tests talk to the linked Supabase project over the network, and
    // sign in twice before the first assertion runs.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // The leak test creates and deletes a fixture tenant. Running files in
    // parallel against one shared database invites false positives.
    fileParallelism: false,
  },
});
